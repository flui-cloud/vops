import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentStore } from '../agent-control/agent-store';
import { localId } from '../agent-control/ids';
import { ConversationService } from './conversation.service';
import { DeviceRegistry } from './device-registry';
import { PairingService } from './pairing.service';
import { RemoteCryptoService } from './remote-crypto.service';
import { parseRemoteInboundPayload } from './remote-message.types';
import { RemoteMessenger } from './remote-messenger';
import { RemoteCommandHandler } from './remote-command.handler';
import { RemoteStore } from './remote-store';
import { RemoteSyncService } from './remote-sync.service';
import { RemoteEnvelopeV1 } from './remote-transport.types';
import { RelayClient } from './relay-client';

@Injectable()
export class RemoteGateway implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;

  constructor(
    private readonly relay: RelayClient,
    private readonly pairing: PairingService,
    private readonly devices: DeviceRegistry,
    private readonly crypto: RemoteCryptoService,
    private readonly store: RemoteStore,
    private readonly messenger: RemoteMessenger,
    private readonly sync: RemoteSyncService,
    private readonly conversations: ConversationService,
    private readonly commands: RemoteCommandHandler,
    private readonly audit: AgentStore,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.relay.onFrame(async (frame) => {
      if (frame.type === 'pairing.hello') {
        await this.pairing.handleHello(frame);
        return;
      }
      if (frame.type === 'envelope') {
        await this.handleEnvelope(frame.envelope);
      }
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private async handleEnvelope(envelope: RemoteEnvelopeV1): Promise<void> {
    try {
      validateEnvelope(envelope);
      const identity = await this.crypto.ensureNodeIdentity();
      if (envelope.recipient_id !== identity.nodeId) {
        throw new Error('Remote envelope is addressed to a different control node.');
      }
      const device = await this.devices.getActiveByRoute(envelope.sender_id);
      if (envelope.key_id !== device.keyId) {
        throw new Error('Remote envelope key binding does not match the paired device.');
      }
      const payload = parseRemoteInboundPayload(
        await this.crypto.decryptFromDevice(device, envelope),
      );
      const fresh = await this.store.acceptInboundMessage(
        device.id,
        envelope.message_id,
        envelope.sequence,
        envelope.expires_at,
      );
      this.relay.acknowledge(envelope.message_id);
      if (!fresh) {
        await this.event('remote.message.replayed', 'Rejected a replayed remote message.', {
          deviceId: device.id,
          messageId: envelope.message_id,
        });
        return;
      }
      await this.devices.touch(device.id);
      if (payload.type === 'sync.request') {
        if (envelope.channel !== 'state_sync') {
          throw new Error('Remote sync request used the wrong encrypted channel.');
        }
        await this.messenger.send(
          device,
          'state_sync',
          await this.sync.snapshot(device, payload.request_id),
          2 * 60_000,
        );
        return;
      }
      if (payload.type === 'chat.user_message') {
        if (envelope.channel !== 'chat_request') {
          throw new Error('Remote chat request used the wrong encrypted channel.');
        }
        // The delivery has already been authenticated, replay-checked, persisted,
        // and acknowledged. Chat continues asynchronously so one model turn
        // cannot block relay heartbeats or other devices.
        void this.conversations.handle(device, payload);
        return;
      }
      if (payload.type === 'chat.cancel') {
        if (envelope.channel !== 'chat_request') {
          throw new Error('Remote chat cancellation used the wrong encrypted channel.');
        }
        await this.conversations.cancel(device, payload);
        return;
      }
      if (payload.type === 'remote.command') {
        if (envelope.channel !== 'remote_command') {
          throw new Error('Remote command used the wrong encrypted channel.');
        }
        void this.commands.handle(device, payload);
      }
    } catch (error) {
      // Poison envelopes must not create an infinite relay redelivery loop. The
      // content is not logged; only bounded routing metadata reaches local audit.
      try {
        this.relay.acknowledge(envelope.message_id);
      } catch {
        // Transport reconnect will redeliver if the ack cannot be sent.
      }
      await this.event('remote.message.rejected', 'Rejected a remote encrypted message.', {
        senderId: safeId(envelope?.sender_id),
        messageId: safeId(envelope?.message_id),
        reason: error instanceof Error ? error.message.slice(0, 240) : 'invalid envelope',
      });
    }
  }

  private async event(eventType: string, summary: string, detail: unknown): Promise<void> {
    await this.audit.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      actor: 'remote_gateway',
      eventType,
      summary,
      detail,
    });
  }
}

const CHANNELS = new Set([
  'presence',
  'notification',
  'state_sync',
  'chat_request',
  'chat_stream',
  'approval',
  'remote_command',
  'delivery_ack',
  'key_management',
]);

export function validateEnvelope(envelope: RemoteEnvelopeV1): void {
  if (!envelope || typeof envelope !== 'object' || envelope.protocol_version !== 1) {
    throw new Error('Unsupported remote envelope protocol.');
  }
  for (const [field, value, max] of [
    ['message_id', envelope.message_id, 160],
    ['sender_id', envelope.sender_id, 160],
    ['recipient_id', envelope.recipient_id, 160],
    ['key_id', envelope.key_id, 160],
  ] as const) {
    if (typeof value !== 'string' || value.length < 3 || value.length > max) {
      throw new Error(`Remote envelope ${field} is invalid.`);
    }
  }
  if (!CHANNELS.has(envelope.channel)) throw new Error('Remote envelope channel is invalid.');
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) {
    throw new Error('Remote envelope sequence is invalid.');
  }
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length < 32 || envelope.ciphertext.length > 512_000) {
    throw new Error('Remote envelope ciphertext length is invalid.');
  }
  const created = Date.parse(envelope.created_at);
  const expires = Date.parse(envelope.expires_at);
  const now = Date.now();
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) {
    throw new Error('Remote envelope timestamps are invalid.');
  }
  if (created > now + 2 * 60_000 || expires <= now) {
    throw new Error('Remote envelope is expired or from the future.');
  }
  if (expires - created > 15 * 60_000) {
    throw new Error('Remote envelope lifetime exceeds the accepted window.');
  }
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 160) : undefined;
}
