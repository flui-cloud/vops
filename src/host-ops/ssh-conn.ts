import { SshConnState, SshKeyKind, VopsHost } from '../hosts/host.model';

type HostAddr = Pick<VopsHost, 'user' | 'address' | 'port'>;

const NETWORK_RE =
  /timed out|timeout|no route to host|network is unreachable|connection refused|could not resolve|name or service not known|host is down/;
const AUTH_RE = /permission denied|publickey|authentication failed|too many authentication|host key verification failed/;

/** First non-empty, non-banner stderr line — the salient reason to show the user. */
function reason(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('Warning:'));
  return line ?? 'unknown error';
}

export interface SshOutcome {
  reachable: boolean;
  authorized: boolean;
  reason: string;
}

/**
 * One ssh attempt → structural bools. An auth failure implies the TCP endpoint
 * answered (reachable=true); a network error means it did not.
 */
export function sshOutcome(code: number, stderr: string): SshOutcome {
  if (code === 0) return { reachable: true, authorized: true, reason: '' };
  const err = (stderr || '').toLowerCase();
  const r = reason(stderr);
  if (AUTH_RE.test(err)) return { reachable: true, authorized: false, reason: r };
  return { reachable: false, authorized: false, reason: r };
}

export interface DeriveInput {
  reachable: boolean;
  hasKey: boolean;
  authorized: boolean;
  keyKind: SshKeyKind;
  host: HostAddr;
  reason?: string;
}

/**
 * Structural connection state (reachable → key → authorized) → one clear state
 * plus the single fix for it. Order matters: an unreachable host isn't an auth
 * problem, and a missing key isn't a network problem.
 */
export function deriveConnState(i: DeriveInput): { state: SshConnState; message: string } {
  const at = `${i.host.user}@${i.host.address}:${i.host.port || 22}`;
  if (!i.hasKey) {
    return {
      state: 'no-key',
      message:
        'No SSH key is assigned for this host. Pick a local key (or generate one) below — its public half must then be authorized on the server.',
    };
  }
  if (!i.reachable) {
    return {
      state: 'unreachable',
      message:
        `Can't reach ${at} over SSH (${i.reason || 'no response'}). The host must accept SSH from this machine — ` +
        'open the port/firewall to your IP, or run vops from a machine that can reach it.',
    };
  }
  if (i.authorized) {
    return { state: 'ready', message: `Reachable and authorized (${i.keyKind} key).` };
  }
  return {
    state: 'auth-failed',
    message:
      `Reached ${i.host.address} but the ${i.keyKind} key isn't authorized. Add its public half to the server ` +
      '(provider console, or ~/.ssh/authorized_keys), then re-check.',
  };
}
