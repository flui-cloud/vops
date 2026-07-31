import * as crypto from 'node:crypto';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { VaultLockedError } from '../lib/keyring/vault-session';

const REMOTE_CONFIG_KEY = 'vops-remote-control';
const DEFAULT_RELAY_URL =
  process.env.VOPS_REMOTE_RELAY ??
  process.env.VOPS_CLOUD_API ??
  'https://vops-api.flui.cloud';

export interface RemoteConfig {
  enabled: boolean;
  relayUrl: string;
  nodeId: string;
  transportToken: string;
}

export class RemoteConfigStore {
  private readonly store = new LocalConfigStore();

  read(): RemoteConfig | null {
    const value = this.store.getCredentials(REMOTE_CONFIG_KEY);
    if (!value?.nodeId || !value.transportToken || !value.relayUrl) return null;
    return {
      enabled: value.enabled === 'true',
      relayUrl: value.relayUrl,
      nodeId: value.nodeId,
      transportToken: value.transportToken,
    };
  }

  readSafe(): { config: RemoteConfig | null; vaultLocked: boolean } {
    try {
      return { config: this.read(), vaultLocked: false };
    } catch (error) {
      if (error instanceof VaultLockedError) return { config: null, vaultLocked: true };
      throw error;
    }
  }

  candidate(relayUrl?: string): RemoteConfig {
    const existing = this.read();
    return {
      enabled: true,
      relayUrl: normalizeRelayUrl(relayUrl ?? existing?.relayUrl ?? DEFAULT_RELAY_URL),
      nodeId: existing?.nodeId ?? `node_${crypto.randomBytes(24).toString('base64url')}`,
      transportToken: existing?.transportToken ?? crypto.randomBytes(32).toString('base64url'),
    };
  }

  save(config: RemoteConfig): void {
    this.write(config);
  }

  disable(): RemoteConfig | null {
    const config = this.read();
    if (!config) return null;
    const disabled = { ...config, enabled: false };
    this.write(disabled);
    return disabled;
  }

  private write(config: RemoteConfig): void {
    this.store.setCredentials(REMOTE_CONFIG_KEY, {
      enabled: String(config.enabled),
      relayUrl: config.relayUrl,
      nodeId: config.nodeId,
      transportToken: config.transportToken,
    });
  }
}

export function normalizeRelayUrl(input: string): string {
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('The remote relay must use HTTPS (HTTP is allowed only on loopback for development).');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}
