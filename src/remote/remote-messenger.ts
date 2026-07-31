import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RemoteCryptoService } from './remote-crypto.service';
import { RemoteDevice } from './remote-model';
import { RemoteStore } from './remote-store';
import { RemoteEnvelopeV1 } from './remote-transport.types';
import { RelayClient } from './relay-client';

@Injectable()
export class RemoteMessenger {
  constructor(
    private readonly relay: RelayClient,
    private readonly cryptoService: RemoteCryptoService,
    private readonly store: RemoteStore,
  ) {}

  async send(
    device: RemoteDevice,
    channel: RemoteEnvelopeV1['channel'],
    payload: unknown,
    ttlMs = 2 * 60_000,
  ): Promise<RemoteEnvelopeV1> {
    if (device.status !== 'active') throw new Error('Cannot send to an inactive remote device.');
    const node = await this.cryptoService.ensureNodeIdentity();
    const now = new Date();
    const metadata: Omit<RemoteEnvelopeV1, 'ciphertext'> = {
      protocol_version: 1,
      message_id: `msg_${crypto.randomBytes(24).toString('base64url')}`,
      sender_id: node.nodeId,
      recipient_id: device.routeId,
      channel,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      key_id: device.keyId,
      sequence: await this.store.nextOutboundSequence(device.id),
    };
    const envelope = await this.cryptoService.encryptForDevice(device, metadata, payload);
    this.relay.sendEnvelope(envelope);
    if (channel === 'notification') {
      void this.relay.wakeDeviceRoute(device.routeId).catch(() => 'unavailable');
    }
    return envelope;
  }
}
