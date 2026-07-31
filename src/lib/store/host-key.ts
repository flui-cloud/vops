import * as crypto from 'node:crypto';
import { VopsHost } from '../../hosts/host.model';

/** Minted per host, once. Short because it is only ever compared, never typed. */
export function newHostUid(): string {
  return crypto.randomBytes(6).toString('hex');
}

export type HostIdentity = Pick<VopsHost, 'provider' | 'providerServerId' | 'address' | 'port' | 'name'> & {
  uid?: string;
};

/**
 * The key a host's time series is stored under.
 *
 * `name` is the only identity `hosts.json` has today, and it is the wrong one to
 * key seven days of history on: `remove` then re-add under the same name would
 * graft an old machine's history onto a new one. `host-forget.ts` already states
 * the codebase's rule for real identity — match on (provider, serverId) or on
 * address, never on name alone — and this mirrors it.
 *
 * The `uid` on top of that rule matters because the derived key is not stable
 * either: `ensureFromServer` fills in provider + providerServerId on a host that
 * was added by address, which would flip its key mid-life and split its history
 * in two. A minted uid survives that, a rename, and a change of address.
 */
export function hostKey(h: HostIdentity): string {
  if (h.uid) return `u:${h.uid}`;
  if (h.provider && h.providerServerId) return `p:${h.provider}:${h.providerServerId}`;
  if (h.address) return `a:${h.address}:${h.port ?? 22}`;
  return `n:${h.name}`;
}

/** True when this host has no stable id yet — the prober mints one and rekeys. */
export function needsUid(h: HostIdentity): boolean {
  return !h.uid;
}
