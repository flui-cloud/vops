/**
 * Rate limit for passphrase attempts arriving over the local HTTP API.
 *
 * This is defence in depth, NOT a security boundary. Anything that can read the
 * profile's session token runs as the same uid, and can therefore read
 * `secrets.vault.json` and attack it offline at full speed with no HTTP in the
 * path. What this buys is protection from a sloppy local peer — a browser
 * extension, a script that got the token out of a URL — taking an online attack
 * from thousands of guesses a second down to a handful an hour.
 *
 * Serializing matters as much as the backoff: scrypt at N=2^16 costs ~0.1-1s of
 * CPU, so parallel attempts would both multiply an attacker's throughput and let
 * anyone pin the machine.
 */
export interface UnlockThrottleOptions {
  now?: () => number;
}

export interface ThrottleState {
  failures: number;
  retryInMs: number;
}

export interface ThrottleCheck extends ThrottleState {
  allowed: boolean;
  busy: boolean;
}

/** Wait imposed after N consecutive failures; index 0 is the clean state. */
const BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const LOCKOUT_AFTER = 10;
const LOCKOUT_MS = 15 * 60_000;

export class UnlockThrottle {
  private failures = 0;
  private nextAllowedAt = 0;
  private busy = false;
  private readonly now: () => number;

  constructor(opts: UnlockThrottleOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  check(): ThrottleCheck {
    const retryInMs = Math.max(0, this.nextAllowedAt - this.now());
    return { allowed: !this.busy && retryInMs === 0, busy: this.busy, failures: this.failures, retryInMs };
  }

  /** Claims the single attempt slot. A `false` return means the caller must answer
   * without deriving anything — running the KDF first is exactly what this prevents. */
  begin(): boolean {
    if (!this.check().allowed) return false;
    this.busy = true;
    return true;
  }

  /** Releases the slot without judging the attempt — for a server fault, which is
   * neither a wrong guess to penalise nor a success to reset the counter on. */
  release(): void {
    this.busy = false;
  }

  /** Releases the slot and scores the attempt. Every `begin()` must reach this or
   * `release()`, or the single-attempt lock stays held for the process's life. */
  record(ok: boolean): void {
    this.busy = false;
    if (ok) {
      this.failures = 0;
      this.nextAllowedAt = 0;
      return;
    }
    this.failures += 1;
    this.nextAllowedAt = this.now() + this.penaltyMs();
  }

  state(): ThrottleState {
    const { failures, retryInMs } = this.check();
    return { failures, retryInMs };
  }

  private penaltyMs(): number {
    if (this.failures >= LOCKOUT_AFTER) return LOCKOUT_MS;
    return BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
  }
}
