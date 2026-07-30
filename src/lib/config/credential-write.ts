export interface CredentialWrite {
  provider: string;
  profile: string;
  /** Absolute path of the profile directory the write lands in. */
  profileDir: string;
  /** The profile store already holds a token or credentials record for this provider. */
  existing: boolean;
  force: boolean;
}

/**
 * Why a credential write must be refused, or null when it may proceed.
 *
 * An overwrite is unrecoverable: the store keeps one value per provider and no
 * previous copy, and a provider API token is usually shown once. A validation run
 * replaced a live Hetzner token with a placeholder this way — `vops config set`
 * exited 0 and the real token was gone. Naming a profile is never implicit here.
 */
export function credentialWriteRefusal(w: CredentialWrite): string | null {
  if (!w.existing || w.force) return null;
  return (
    `${w.provider} already has a credential in profile "${w.profile}" (${w.profileDir}). ` +
    'Replacing it is not reversible: vops keeps no previous copy and most providers show an ' +
    'API token once. Re-run with --force to replace it, or set VOPS_PROFILE to write to a ' +
    'different profile.'
  );
}

/** Confirmation that names the profile a credential landed in, so a `config set` cannot silently
 * write to one the user did not mean. */
export function credentialWriteSummary(w: Omit<CredentialWrite, 'force'>): string {
  const verb = w.existing ? 'Replaced' : 'Stored';
  return `✓ ${verb} ${w.provider} credentials in profile "${w.profile}" — ${w.profileDir} (AES-256-GCM, never sent anywhere).`;
}
