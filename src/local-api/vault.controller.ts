import { BadRequestException, Body, Controller, Get, HttpException, Post } from '@nestjs/common';
import { profileDir } from '../lib/profile';
import { UnlockThrottle } from '../lib/keyring/unlock-throttle';
import { ensureVaultUnlocked, keyringStatus, lockKeyring } from '../lib/keyring/unlock';
import { VaultAuthError } from '../lib/keyring/vault-format';
import { VaultLockedError } from '../lib/keyring/vault-session';
import { vaultState } from '../lib/keyring/vault-state';

const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY = 429;

/** One fixed string for every failed attempt. The underlying errors carry text
 * from the keyring daemon and from the vault format, and echoing either would
 * both leak internals and let a caller distinguish failure modes. */
const WRONG = 'Wrong passphrase.';

/**
 * Unlocking the vault from the dashboard. A service started at login has no
 * terminal, so `disablePrompting()` (bootstrap.ts) leaves the browser as the only
 * place a passphrase can be entered — without this, every credential page stays
 * dead until the user opens a terminal and runs `vops keyring unlock`.
 *
 * Session-guarded like the rest of /api. See `UnlockThrottle` for why the rate
 * limit here is defence in depth rather than a security boundary.
 */
@Controller('api/vault')
export class VaultController {
  constructor(private readonly throttle: UnlockThrottle) {}

  @Get()
  async status() {
    const dir = profileDir();
    return { state: vaultState(dir), keyring: await keyringStatus(dir), throttle: this.throttle.state() };
  }

  @Post('unlock')
  async unlock(@Body() body: { passphrase?: string }) {
    const passphrase = body?.passphrase ?? '';
    if (!passphrase) throw new BadRequestException('Passphrase required.');

    if (!this.throttle.begin()) throw this.tooMany();

    const dir = profileDir();
    try {
      // A non-empty passphrase short-circuits the prompt gate in ensureVaultUnlocked,
      // so this works after disablePrompting(). `useDaemon` leaves the 12h session
      // behind, so a later CLI command in a terminal doesn't ask again.
      await ensureVaultUnlocked({ dir, passphrase, useDaemon: true });
      this.throttle.record(true);
    } catch (e) {
      // Only an authentication failure counts against the throttle; an unreadable
      // vault or a broken keyring is a server fault and keeps its own status.
      if (!isAuthFailure(e)) {
        this.throttle.release();
        throw e;
      }
      this.throttle.record(false);
      throw this.wrongPassphrase();
    }

    return { state: vaultState(dir), keyring: await keyringStatus(dir), throttle: this.throttle.state() };
  }

  @Post('lock')
  async lock() {
    const dir = profileDir();
    await lockKeyring(dir);
    return { state: vaultState(dir), keyring: await keyringStatus(dir), throttle: this.throttle.state() };
  }

  private wrongPassphrase(): HttpException {
    const { failures, retryInMs } = this.throttle.state();
    return new HttpException(
      { statusCode: HTTP_UNAUTHORIZED, error: 'Unauthorized', message: WRONG, failures, retryInMs },
      HTTP_UNAUTHORIZED,
    );
  }

  private tooMany(): HttpException {
    const { failures, retryInMs } = this.throttle.check();
    const message = retryInMs > 0 ? 'Too many attempts. Wait before trying again.' : 'An unlock is already in progress.';
    return new HttpException(
      { statusCode: HTTP_TOO_MANY, error: 'Too Many Requests', message, failures, retryInMs },
      HTTP_TOO_MANY,
    );
  }
}

/**
 * The three shapes a wrong passphrase arrives in: the keyring daemon rejecting it,
 * local derivation failing to authenticate the payload, and — for an empty vault
 * read — the locked marker. None of them is a 502.
 */
function isAuthFailure(e: unknown): boolean {
  return e instanceof VaultAuthError || e instanceof VaultLockedError;
}
