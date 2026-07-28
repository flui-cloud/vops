import { KdfParams, KeyDomain, deriveKey, deriveMaster } from './derive';
import { KeyringRequest, KeyringResponse, errorResponse } from './protocol';
import { VaultAuthError } from './vault-format';
import { secretEquals } from './constant-time';

/** The keyring's state machine, deliberately free of `net`/`fs` so the security-relevant
 * behaviour is unit-testable without sockets. Never returns the master, only a
 * key derived for one declared domain. */
/** Deliberately generous: asking every hour would push people toward `VOPS_PASSPHRASE`
 * in a shell profile, which is worse than a long-lived in-memory key. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export interface KeyringServerOptions {
  /** Shared secret every client must present; the transport ACL is not trusted. */
  cookie: string;
  /** Vault header lookup, read fresh at unlock so a re-keyed vault is picked up. */
  readHeader: () => { salt: Buffer; kdf: KdfParams };
  /** Proves a candidate master opens the vault (throws `VaultAuthError` if not) so a
   * typo surfaces here, not deep inside an unrelated command later. */
  verify?: (master: Buffer) => void;
  /** Sliding lifetime of an unlock, in ms. */
  ttlMs: number;
  /** Injectable clock — tests must not depend on wall time. */
  now?: () => number;
  /** Called when the keyring locks (TTL expiry or explicit lock). */
  onLock?: () => void;
}

export class KeyringServer {
  private master: Buffer | null = null;
  private expiresAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: KeyringServerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get unlocked(): boolean {
    this.expireIfDue();
    return this.master !== null;
  }

  handle(req: KeyringRequest): KeyringResponse {
    if (!secretEquals(req.cookie, this.opts.cookie)) {
      return errorResponse('unauthorized', 'Bad keyring cookie.');
    }
    this.expireIfDue();

    switch (req.op) {
      case 'status':
        return { ok: true, op: 'status', unlocked: this.master !== null, expiresAt: this.expiresAt };
      case 'unlock':
        return this.unlock(req.passphrase ?? '');
      case 'key':
        return this.key(req.domain);
      case 'lock':
        this.lock();
        return { ok: true, op: 'lock' };
      default:
        return errorResponse('bad-request', 'Unknown op.');
    }
  }

  /** Wipe the master and stop answering. Called on TTL expiry and `vops lock`. */
  lock(): void {
    this.master?.fill(0);
    this.master = null;
    this.expiresAt = null;
    this.opts.onLock?.();
  }

  private unlock(passphrase: string): KeyringResponse {
    let header: { salt: Buffer; kdf: KdfParams };
    try {
      header = this.opts.readHeader();
    } catch (e) {
      return errorResponse('internal', e instanceof Error ? e.message : String(e));
    }
    try {
      const master = deriveMaster(passphrase, header.salt, header.kdf);
      this.opts.verify?.(master);
      this.master?.fill(0);
      this.master = master;
      this.touch();
      return { ok: true, op: 'unlock' };
    } catch (e) {
      if (e instanceof VaultAuthError) return errorResponse('bad-passphrase', e.message);
      return errorResponse('internal', e instanceof Error ? e.message : String(e));
    }
  }

  private key(domain: KeyDomain): KeyringResponse {
    if (!this.master) return errorResponse('locked', 'Keyring is locked.');
    const { salt } = this.opts.readHeader();
    const key = deriveKey(this.master, domain, salt).toString('hex');
    this.touch();
    return { ok: true, op: 'key', key };
  }

  /** Sliding window: every authorised use pushes the expiry out. */
  private touch(): void {
    this.expiresAt = this.now() + this.opts.ttlMs;
  }

  private expireIfDue(): void {
    if (this.master && this.expiresAt !== null && this.now() >= this.expiresAt) this.lock();
  }
}
