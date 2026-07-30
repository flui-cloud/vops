/** The unlocked vault-domain key for this process's lifetime — never the master,
 * so a heap dump here can't yield keys for any other domain (session, Dymmi). */
let key: Buffer | null = null;

/** Thrown when a sealed vault is read without an unlock. Carries the fix.
 *
 * `credentialStoreLocked` is the marker `@flui-cloud/infra` duck-types on: the
 * provider layer meets this error inside its own degrade-to-empty catch, and
 * without the marker it swallowed it into a generic "Failed to fetch node sizes"
 * — so the local API answered 502 instead of 423 and the dashboard could not
 * offer an unlock. Deliberately NOT `isCredentialError`: a locked vault is a
 * third state, whose remedy is an unlock rather than a new credential. */
export class VaultLockedError extends Error {
  readonly credentialStoreLocked = true;

  constructor(
    message = 'The vops vault is locked. Run `vops keyring unlock` (or set VOPS_PASSPHRASE).',
  ) {
    super(message);
    this.name = 'VaultLockedError';
  }
}

export function setVaultKey(next: Buffer): void {
  if (key && key !== next) key.fill(0);
  key = next;
}

export function vaultKey(): Buffer | null {
  return key;
}

export function requireVaultKey(): Buffer {
  if (!key) throw new VaultLockedError();
  return key;
}

export function clearVaultKey(): void {
  key?.fill(0);
  key = null;
}
