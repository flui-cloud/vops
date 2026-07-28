/** The unlocked vault-domain key for this process's lifetime — never the master,
 * so a heap dump here can't yield keys for any other domain (session, Dymmi). */
let key: Buffer | null = null;

/** Thrown when a sealed vault is read without an unlock. Carries the fix. */
export class VaultLockedError extends Error {
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
