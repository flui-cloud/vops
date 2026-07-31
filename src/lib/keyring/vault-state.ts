import { vaultKey } from './vault-session';
import { vaultExists } from './vault-store';

/** `legacy` = no sealed vault on disk (the `.key` beside `secrets.json.enc` path). */
export type VaultState = 'legacy' | 'locked' | 'unlocked';

/** Reads the credential state WITHOUT unlocking anything — a status probe must never
 * trigger a passphrase prompt, which is the whole premise of the progressive unlock. */
export function vaultState(dir: string): VaultState {
  if (!vaultExists(dir)) return 'legacy';
  return vaultKey() ? 'unlocked' : 'locked';
}
