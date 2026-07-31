import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import sodium from 'libsodium-wrappers';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { RemoteConfigStore } from './remote-config';
import {
  RemoteDevice,
  RemoteNodePublicIdentity,
} from './remote-model';
import { RemoteEnvelopeV1 } from './remote-transport.types';

const IDENTITY_CONFIG_KEY = 'vops-remote-node-identity';
const BASE64 = () => sodium.base64_variants.URLSAFE_NO_PADDING;

interface StoredNodeIdentity {
  keyId: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  exchangePublicKey: string;
  exchangePrivateKey: string;
}

@Injectable()
export class RemoteCryptoService {
  private readonly secrets = new LocalConfigStore();
  private readonly remoteConfig = new RemoteConfigStore();

  async ensureNodeIdentity(): Promise<RemoteNodePublicIdentity> {
    await sodium.ready;
    let identity = this.readIdentity();
    if (!identity) {
      const signing = sodium.crypto_sign_keypair();
      const exchange = sodium.crypto_kx_keypair();
      const signingPublicKey = encode(signing.publicKey);
      const exchangePublicKey = encode(exchange.publicKey);
      identity = {
        keyId: `key_${fingerprint(`${signingPublicKey}.${exchangePublicKey}`, 18)}`,
        signingPublicKey,
        signingPrivateKey: encode(signing.privateKey),
        exchangePublicKey,
        exchangePrivateKey: encode(exchange.privateKey),
      };
      this.secrets.setCredentials(IDENTITY_CONFIG_KEY, { ...identity });
    }
    const config = this.remoteConfig.read();
    if (!config) throw new Error('Remote transport must be enabled before creating a node identity.');
    return {
      nodeId: config.nodeId,
      keyId: identity.keyId,
      signingPublicKey: identity.signingPublicKey,
      exchangePublicKey: identity.exchangePublicKey,
      fingerprint: fingerprint(`${identity.signingPublicKey}.${identity.exchangePublicKey}`, 24),
    };
  }

  async verifyPairingChallenge(
    payload: PairingChallengePayload,
    signature: string,
    signingPublicKey: string,
  ): Promise<boolean> {
    await sodium.ready;
    return sodium.crypto_sign_verify_detached(
      decode(signature),
      canonical(payload),
      decode(signingPublicKey),
    );
  }

  async encryptForDevice(
    device: RemoteDevice,
    envelope: Omit<RemoteEnvelopeV1, 'ciphertext'>,
    payload: unknown,
  ): Promise<RemoteEnvelopeV1> {
    await sodium.ready;
    const identity = this.requireIdentity();
    const { sharedTx } = sodium.crypto_kx_server_session_keys(
      decode(identity.exchangePublicKey),
      decode(identity.exchangePrivateKey),
      decode(device.exchangePublicKey),
    );
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      canonical(payload),
      canonical(envelope),
      null,
      nonce,
      sharedTx,
    );
    return {
      ...envelope,
      ciphertext: encode(concat(nonce, ciphertext)),
    };
  }

  async decryptFromDevice<T>(device: RemoteDevice, envelope: RemoteEnvelopeV1): Promise<T> {
    await sodium.ready;
    const identity = this.requireIdentity();
    const { sharedRx } = sodium.crypto_kx_server_session_keys(
      decode(identity.exchangePublicKey),
      decode(identity.exchangePrivateKey),
      decode(device.exchangePublicKey),
    );
    const packed = decode(envelope.ciphertext);
    const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    if (packed.length <= nonceLength) throw new Error('Encrypted envelope is truncated.');
    const nonce = packed.slice(0, nonceLength);
    const ciphertext = packed.slice(nonceLength);
    const { ciphertext: _ciphertext, ...metadata } = envelope;
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      canonical(metadata),
      nonce,
      sharedRx,
      'text',
    );
    return JSON.parse(plain) as T;
  }

  async verifyDeviceSignature(
    payload: unknown,
    signature: string,
    signingPublicKey: string,
  ): Promise<boolean> {
    await sodium.ready;
    return sodium.crypto_sign_verify_detached(
      decode(signature),
      canonical(payload),
      decode(signingPublicKey),
    );
  }

  async deviceKeyId(signingPublicKey: string, exchangePublicKey: string): Promise<string> {
    await sodium.ready;
    return `key_${encode(sodium.crypto_generichash(18, `${signingPublicKey}.${exchangePublicKey}`, null))}`;
  }

  private readIdentity(): StoredNodeIdentity | null {
    const value = this.secrets.getCredentials(IDENTITY_CONFIG_KEY);
    if (
      !value?.keyId ||
      !value.signingPublicKey ||
      !value.signingPrivateKey ||
      !value.exchangePublicKey ||
      !value.exchangePrivateKey
    ) {
      return null;
    }
    return value as unknown as StoredNodeIdentity;
  }

  private requireIdentity(): StoredNodeIdentity {
    const identity = this.readIdentity();
    if (!identity) throw new Error('Remote control-node identity is not initialized.');
    return identity;
  }
}

export interface PairingChallengePayload {
  protocol_version: 1;
  pairing_id: string;
  challenge: string;
  device_route_id: string;
  signing_public_key: string;
  exchange_public_key: string;
  expires_at: string;
}

export function canonical(value: unknown): string {
  assertCanonicalValue(value);
  const result = canonicalize(value);
  if (!result) throw new Error('Value cannot be canonicalized.');
  return result;
}

function assertCanonicalValue(value: unknown): void {
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isSafeInteger(value))) {
    throw new Error('Signed payload numbers must be finite safe integers.');
  }
  if (Array.isArray(value)) {
    value.forEach(assertCanonicalValue);
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child === undefined) throw new Error('Signed payload cannot contain undefined.');
      assertCanonicalValue(child);
    }
  }
}

function encode(value: Uint8Array): string {
  return sodium.to_base64(value, BASE64());
}

function decode(value: string): Uint8Array {
  return sodium.from_base64(value, BASE64());
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function fingerprint(value: string, length: number): string {
  return crypto.createHash('sha256').update(value).digest('base64url').slice(0, length);
}
