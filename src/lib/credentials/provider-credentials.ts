import { CloudProvider } from '@flui-cloud/infra';
import { LocalConfigStore } from '../config/local-config-store';
import { ensureVaultUnlocked } from '../keyring/unlock';
import { VaultLockedError } from '../keyring/vault-session';

/**
 * Providers whose credentials the UI form (and `config set`) manages today.
 * OVH is excluded on purpose: it authenticates through OpenStack (a richer set of
 * OS_* variables than its capability's credentialFields expose), so it stays on
 * the manual `.env` route until that path is unified — see the README.
 */
export const CONFIGURABLE_PROVIDERS: CloudProvider[] = [
  CloudProvider.HETZNER,
  CloudProvider.SCALEWAY,
  CloudProvider.CONTABO,
  CloudProvider.CHERRY,
];

/**
 * Env-based providers read their credentials through `ConfigService` inside
 * @flui-cloud/infra, not from the encrypted store. To keep the store the single
 * source of truth, we hydrate `process.env` from it at boot: this maps each
 * stored credential-record key → the environment variable the provider reads.
 * Hetzner/Scaleway are absent — they read the store natively.
 */
export const ENV_CREDENTIAL_MAP: Partial<
  Record<CloudProvider, Record<string, string>>
> = {
  [CloudProvider.CONTABO]: {
    clientId: 'CONTABO_CLIENT_ID',
    clientSecret: 'CONTABO_CLIENT_SECRET',
    username: 'CONTABO_API_USER',
    password: 'CONTABO_API_PASSWORD',
  },
  [CloudProvider.CHERRY]: {
    apiKey: 'CHERRY_API_KEY',
    projectId: 'CHERRY_PROJECT_ID',
  },
};

/**
 * Copy stored credentials into `process.env` for env-based providers.
 *
 * At boot (`force` false) an explicit environment/.env value always wins, so an
 * existing manual setup is never overridden. Right after a UI save (`force` true)
 * the freshly stored value is applied immediately so the change takes effect
 * without a restart.
 */
export function hydrateEnvFromStore(
  store: LocalConfigStore,
  opts: { force?: boolean; only?: CloudProvider } = {},
): void {
  for (const [provider, map] of Object.entries(ENV_CREDENTIAL_MAP)) {
    if (opts.only && provider !== opts.only) continue;
    const creds = store.getCredentials(provider);
    if (!creds) continue;
    for (const [key, envVar] of Object.entries(map)) {
      const value = creds[key];
      if (value && (opts.force || !process.env[envVar])) {
        process.env[envVar] = value;
      }
    }
  }
}

/** Remove a provider's env vars (used when its credentials are deleted). */
export function clearEnvForProvider(provider: CloudProvider): void {
  const map = ENV_CREDENTIAL_MAP[provider];
  if (!map) return;
  for (const envVar of Object.values(map)) delete process.env[envVar];
}

/**
 * Why a credential is or is not usable without asking for anything. The two negative
 * answers have different remedies — `unconfigured` needs `vops config set`, `sealed`
 * needs an unlock — and a caller that leaves the provider out has to be able to say
 * which, or the user cannot tell a gap they must fill from one they already filled.
 */
export type CredentialReach = 'reachable' | 'unconfigured' | 'sealed';

/**
 * Whether a credential for this provider can be had *without asking for anything*:
 * the store holds one, and the vault is legacy, already open, or openable from
 * VOPS_PASSPHRASE / a keyring that is already running. A still-sealed vault answers
 * `sealed` rather than prompting, so a read whose credential is optional can leave the
 * provider out instead of turning "nothing configured" into a passphrase prompt.
 */
export async function credentialReach(
  provider: CloudProvider,
): Promise<CredentialReach> {
  try {
    await ensureVaultUnlocked({ interactive: false });
    return isProviderConfigured(new LocalConfigStore(), provider)
      ? 'reachable'
      : 'unconfigured';
  } catch (e) {
    if (e instanceof VaultLockedError) return 'sealed';
    throw e;
  }
}

export async function hasReachableCredential(
  provider: CloudProvider,
): Promise<boolean> {
  return (await credentialReach(provider)) === 'reachable';
}

/**
 * Whether a provider has usable credentials, without decrypting/returning any
 * secret. True when the encrypted store holds a token or a credentials record,
 * or (for env-based providers) when all mapped environment variables are set.
 */
export function isProviderConfigured(
  store: LocalConfigStore,
  provider: CloudProvider,
): boolean {
  if (store.getToken(provider)) return true;
  const record = store.getCredentials(provider);
  if (record && Object.values(record).some(Boolean)) return true;
  const map = ENV_CREDENTIAL_MAP[provider];
  return map ? Object.values(map).every((envVar) => !!process.env[envVar]) : false;
}
