import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { AgentStore } from '../agent-control/agent-store';
import { localId } from '../agent-control/ids';
import { RemoteConfigStore } from './remote-config';
import {
  PairingChallengePayload,
  RemoteCryptoService,
} from './remote-crypto.service';
import { DeviceRegistry } from './device-registry';
import {
  RemoteDeviceRestrictions,
  RemoteDeviceRole,
  RemotePairingSession,
} from './remote-model';
import { RemoteStore } from './remote-store';
import { PairingHelloFrame, RemoteEnvelopeV1 } from './remote-transport.types';
import { RelayClient } from './relay-client';

const PAIRING_TTL_MS = 10 * 60_000;
const DEFAULT_PWA_URL =
  process.env.VOPS_REMOTE_PWA_URL ?? 'https://vops.flui.cloud/watch/pair/';

export interface PairingBootstrap {
  kind: 'vops.remote.pairing';
  protocol_version: 1;
  relay_url: string;
  pairing_id: string;
  challenge: string;
  expires_at: string;
  node: {
    route_id: string;
    key_id: string;
    signing_public_key: string;
    exchange_public_key: string;
    fingerprint: string;
  };
}

@Injectable()
export class PairingService {
  private readonly config = new RemoteConfigStore();

  constructor(
    private readonly relay: RelayClient,
    private readonly cryptoService: RemoteCryptoService,
    private readonly store: RemoteStore,
    private readonly devices: DeviceRegistry,
    private readonly audit: AgentStore,
  ) {}

  async create(): Promise<{
    pairing: RemotePairingSession;
    activationUrl: string;
    qrDataUrl: string;
    bootstrap: PairingBootstrap;
  }> {
    const config = this.config.read();
    if (!config?.enabled) throw new Error('Enable remote transport before pairing a device.');
    const identity = await this.cryptoService.ensureNodeIdentity();
    const now = new Date();
    const pairing: RemotePairingSession = {
      id: `pair_${crypto.randomBytes(24).toString('base64url')}`,
      nodeId: identity.nodeId,
      challenge: crypto.randomBytes(32).toString('base64url'),
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
    };
    const bootstrap: PairingBootstrap = {
      kind: 'vops.remote.pairing',
      protocol_version: 1,
      relay_url: config.relayUrl,
      pairing_id: pairing.id,
      challenge: pairing.challenge,
      expires_at: pairing.expiresAt,
      node: {
        route_id: identity.nodeId,
        key_id: identity.keyId,
        signing_public_key: identity.signingPublicKey,
        exchange_public_key: identity.exchangePublicKey,
        fingerprint: identity.fingerprint,
      },
    };
    const encoded = Buffer.from(JSON.stringify(bootstrap)).toString('base64url');
    const activationUrl = `${DEFAULT_PWA_URL}?pair=${encodeURIComponent(encoded)}`;
    await this.relay.registerPairing(pairing.id, pairing.expiresAt);
    await this.store.savePairing(pairing);
    await this.event('remote.pairing.created', 'Created a short-lived remote pairing session.', {
      pairingId: pairing.id,
      expiresAt: pairing.expiresAt,
    });
    return {
      pairing,
      activationUrl,
      qrDataUrl: await QRCode.toDataURL(activationUrl, { margin: 1, width: 280 }),
      bootstrap,
    };
  }

  async handleHello(frame: PairingHelloFrame): Promise<void> {
    const pairing = await this.requireLive(frame.pairing_id, 'pending');
    const payload: PairingChallengePayload = {
      protocol_version: 1,
      pairing_id: pairing.id,
      challenge: pairing.challenge,
      device_route_id: frame.device_route_id,
      signing_public_key: frame.signing_public_key,
      exchange_public_key: frame.exchange_public_key,
      expires_at: pairing.expiresAt,
    };
    const valid = await this.cryptoService.verifyPairingChallenge(
      payload,
      frame.challenge_signature,
      frame.signing_public_key,
    );
    if (!valid) {
      await this.event('remote.pairing.rejected', 'Rejected invalid device proof during pairing.', {
        pairingId: pairing.id,
      });
      throw new Error('Device proof did not match the pairing challenge.');
    }
    const updated: RemotePairingSession = {
      ...pairing,
      status: 'hello_received',
      deviceRouteId: frame.device_route_id,
      deviceSigningPublicKey: frame.signing_public_key,
      deviceExchangePublicKey: frame.exchange_public_key,
      challengeSignature: frame.challenge_signature,
    };
    await this.store.savePairing(updated);
    await this.event('remote.pairing.hello_received', 'A remote device is waiting for local confirmation.', {
      pairingId: pairing.id,
      deviceRouteId: frame.device_route_id,
    });
  }

  async confirm(
    pairingId: string,
    input: {
      label: string;
      role: RemoteDeviceRole;
      restrictions?: Partial<RemoteDeviceRestrictions>;
    },
  ) {
    if (this.relay.status().state !== 'online') {
      throw new Error('The relay must be connected to confirm a device.');
    }
    const pairing = await this.requireLive(pairingId, 'hello_received');
    if (
      !pairing.deviceRouteId ||
      !pairing.deviceSigningPublicKey ||
      !pairing.deviceExchangePublicKey
    ) {
      throw new Error('Pairing has no verified device identity.');
    }
    const keyId = await this.cryptoService.deviceKeyId(
      pairing.deviceSigningPublicKey,
      pairing.deviceExchangePublicKey,
    );
    const device = await this.devices.register({
      routeId: pairing.deviceRouteId,
      label: input.label,
      role: input.role,
      signingPublicKey: pairing.deviceSigningPublicKey,
      exchangePublicKey: pairing.deviceExchangePublicKey,
      keyId,
      restrictions: input.restrictions,
    });
    const identity = await this.cryptoService.ensureNodeIdentity();
    const now = new Date();
    const sequence = await this.store.nextOutboundSequence(device.id);
    const metadata: Omit<RemoteEnvelopeV1, 'ciphertext'> = {
      protocol_version: 1,
      message_id: `msg_${crypto.randomBytes(24).toString('base64url')}`,
      sender_id: identity.nodeId,
      recipient_id: device.routeId,
      channel: 'key_management',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
      key_id: device.keyId,
      sequence,
    };
    const envelope = await this.cryptoService.encryptForDevice(device, metadata, {
      type: 'pairing.node_confirmation',
      device: {
        id: device.id,
        label: device.label,
        role: device.role,
        restrictions: device.restrictions,
      },
      node: identity,
    });
    this.relay.sendEnvelope(envelope);
    const confirmed: RemotePairingSession = {
      ...pairing,
      status: 'confirmed',
      confirmedDeviceId: device.id,
    };
    await this.store.savePairing(confirmed);
    await this.event('remote.pairing.confirmed', `Confirmed remote device '${device.label}'.`, {
      pairingId,
      deviceId: device.id,
      role: device.role,
    });
    return { pairing: confirmed, device };
  }

  async list(): Promise<RemotePairingSession[]> {
    const rows = await this.store.listPairings();
    const now = Date.now();
    await Promise.all(
      rows
        .filter((row) => ['pending', 'hello_received'].includes(row.status) && Date.parse(row.expiresAt) <= now)
        .map((row) => this.store.savePairing({ ...row, status: 'expired' })),
    );
    return this.store.listPairings();
  }

  private async requireLive(
    id: string,
    expected: RemotePairingSession['status'],
  ): Promise<RemotePairingSession> {
    const pairing = await this.store.getPairing(id);
    if (!pairing) throw new Error(`Pairing '${id}' was not found.`);
    if (Date.parse(pairing.expiresAt) <= Date.now()) {
      await this.store.savePairing({ ...pairing, status: 'expired' });
      throw new Error('Pairing session expired.');
    }
    if (pairing.status !== expected) {
      throw new Error(`Pairing '${id}' is ${pairing.status}; expected ${expected}.`);
    }
    return pairing;
  }

  private async event(eventType: string, summary: string, detail: unknown): Promise<void> {
    await this.audit.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      actor: 'vops',
      eventType,
      summary,
      detail,
    });
  }
}
