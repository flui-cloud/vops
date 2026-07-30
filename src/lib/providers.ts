import { BadRequestException } from '@nestjs/common';
import { CloudProvider } from '@flui-cloud/infra';

export const SUPPORTED: CloudProvider[] = [
  CloudProvider.HETZNER,
  CloudProvider.SCALEWAY,
  CloudProvider.CONTABO,
  CloudProvider.OVH,
  CloudProvider.CHERRY,
];

/**
 * Providers shown in the price COMPARISON and region map. Kept distinct from
 * SUPPORTED so a comparison-only provider (catalog but no capabilities/provisioning)
 * could be added here without becoming creatable. Today every supported provider
 * is also comparison-wide, so the two sets coincide.
 */
export const COMPARE_PROVIDERS: CloudProvider[] = [...SUPPORTED];

export const DISPLAY_NAMES: Record<string, string> = {
  [CloudProvider.HETZNER]: 'Hetzner Cloud',
  [CloudProvider.SCALEWAY]: 'Scaleway',
  [CloudProvider.CONTABO]: 'Contabo',
  [CloudProvider.OVH]: 'OVHcloud',
  [CloudProvider.CHERRY]: 'Cherry Servers',
};

/**
 * Providers with NO hourly billing (e.g. Contabo). vops never provisions these
 * itself — real creation would place a monthly commitment. Instead it shows the
 * plan and HOW to create it ("guided"), leaving the actual order to the user.
 * Single source of truth for the guided-create behaviour.
 */
export const GUIDED_PROVIDERS: ReadonlySet<CloudProvider> = new Set([
  CloudProvider.CONTABO,
]);

export const isGuided = (provider: CloudProvider): boolean =>
  GUIDED_PROVIDERS.has(provider);

/**
 * Providers whose plans and prices only exist behind their AUTHENTICATED API:
 * Hetzner's `/v1/server_types` and Scaleway's product catalogue both need a token
 * before they will name a price. OVH, Contabo and Cherry price from public
 * sources, which is why `vops compare` works on a fresh install at all.
 *
 * `compare` uses this to leave a provider out of the fan-out when no credential is
 * reachable, instead of entering the credential path (and asking for the vault
 * passphrase) for a comparison that reads nothing.
 */
export const CREDENTIAL_PRICED_PROVIDERS: ReadonlySet<CloudProvider> = new Set([
  CloudProvider.HETZNER,
  CloudProvider.SCALEWAY,
]);

export const needsCredentialToPrice = (provider: CloudProvider): boolean =>
  CREDENTIAL_PRICED_PROVIDERS.has(provider);

/**
 * Providers whose native, network-edge firewall is a usable option. On these the
 * provider firewall (`vops firewall`) is the right tool — it filters before traffic
 * ever reaches the host — so vops does NOT layer its host-level nftables firewall on
 * top of them.
 *
 * The host-level firewall exists precisely for the OTHERS — providers that do NOT
 * offer a usable native firewall:
 *   • Contabo  — no per-instance firewall API at all
 *   • OVH      — security groups exist in the API but ship with quota 0 per project
 *                (blocked at the platform level), so in practice unusable
 *   • Cherry   — no per-server firewall API; filtering is host-side only
 * For those, the nftables firewall applied on the host via cloud-init is the path.
 */
export const NATIVE_FIREWALL_PROVIDERS: ReadonlySet<CloudProvider> = new Set([
  CloudProvider.HETZNER,
  CloudProvider.SCALEWAY,
]);

export const hasNativeFirewall = (provider: CloudProvider): boolean =>
  NATIVE_FIREWALL_PROVIDERS.has(provider);

/**
 * Default SSH login user per provider. OVH's cloud images (we default to Ubuntu)
 * disable root and expect the `ubuntu` user; the others allow root. Override any
 * time with `vops ssh --user`.
 */
const DEFAULT_SSH_USER: Partial<Record<CloudProvider, string>> = {
  [CloudProvider.OVH]: 'ubuntu',
};

export const defaultSshUser = (provider: CloudProvider): string =>
  DEFAULT_SSH_USER[provider] ?? 'root';

export function resolveProvider(name: string): CloudProvider {
  // Accept the enum id ('hetzner'), the display name ('Hetzner Cloud'), or a
  // close alias ('ovhcloud') — the UI/API round-trips display names, so the
  // machine id and the label must both resolve here.
  const n = name.toLowerCase().replaceAll(/\s+/g, '');
  const provider = COMPARE_PROVIDERS.find(
    (p) =>
      n === p ||
      n.startsWith(p) ||
      DISPLAY_NAMES[p].toLowerCase().replaceAll(/\s+/g, '') === n,
  );
  if (!provider) {
    throw new BadRequestException(
      `Unknown provider '${name}'. Supported: ${COMPARE_PROVIDERS.join(', ')}`,
    );
  }
  return provider;
}
