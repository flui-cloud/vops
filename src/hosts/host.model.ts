/**
 * A host is anything reachable over SSH. It may be linked to a provider server,
 * but a host needs no provider (users have machines vops did not create). The
 * provider-plane (`servers`) and this SSH-plane are deliberately separate worlds.
 */
import { VopsFirewallRule } from '../dto/firewall.dto';

export type OsFamily = 'debian' | 'rhel' | 'alpine' | 'unknown';

/** vops-managed host firewall (nftables engine) — the intended ruleset, persisted. */
export interface VopsHostFirewall {
  rules: VopsFirewallRule[];
  policy: 'drop' | 'accept';
  appliedAt: string;
}

export interface VopsHostOs {
  family: OsFamily;
  pretty: string;
}

/** Which local key vops would use to reach this host. */
export type SshKeyKind = 'ops' | 'user' | 'none';

/**
 * Cached SSH connection state — what the UI shows and every SSH-requiring action
 * gates on. `ready` = reachable + key accepted; the rest each map to one clear fix.
 */
export type SshConnState = 'ready' | 'unreachable' | 'no-key' | 'auth-failed' | 'unknown';

export interface HostConn {
  state: SshConnState;
  keyKind: SshKeyKind;
  /** Name + public half of the key vops would use (to authorize on the server). */
  keyName?: string;
  publicKey?: string;
  /** Structural ladder — each layer the UI shows and gates on. */
  reachable: boolean;
  hasKey: boolean;
  authorized: boolean;
  message: string;
  checkedAt: string;
}

export interface VopsHost {
  /** Unique handle (same charset rule as key names). */
  name: string;
  /** IP or FQDN. */
  address: string;
  /** Login user for USER sessions (default root). */
  user: string;
  /** SSH port (default 22). */
  port: number;
  /** Local key (ssh-key store) for interactive ssh. */
  userKeyName?: string;
  /** Whether the profile ops key is authorized on the host. */
  opsKeyInstalled: boolean;
  /** Set when imported from a provider server. */
  provider?: string;
  providerServerId?: string;
  /** Detected + cached OS. */
  os?: VopsHostOs;
  /** Cached SSH reachability/auth state (last probe). */
  conn?: HostConn;
  /**
   * Whether this host is managed over SSH. `false` = provider-only (watched via
   * the provider API, no SSH) — suppresses the SSH setup prompts. Undefined =
   * not decided (SSH management available, opt-in).
   */
  sshManaged?: boolean;
  /** Relay host id when `watch host` is set up (dead-man switch). */
  monitorHostId?: string;
  /** Whether the optional vops metrics agent is installed on the host. */
  agentInstalled?: boolean;
  /** vops-managed nftables firewall intent (engine for providers without a native one). */
  firewall?: VopsHostFirewall;
  tags: string[];
  addedAt: string;
}
