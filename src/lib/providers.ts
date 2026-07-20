import { BadRequestException } from '@nestjs/common';
import { CloudProvider } from '@flui-cloud/infra';

export const SUPPORTED: CloudProvider[] = [
  CloudProvider.HETZNER,
  CloudProvider.SCALEWAY,
  CloudProvider.CONTABO,
  CloudProvider.OVH,
];

/**
 * Providers that appear in the price COMPARISON and region map but are not fully
 * integrated for capabilities / firewall / provisioning. Cherry Servers is
 * read-only in @flui-cloud/infra (public credential-free catalog, EUR prices,
 * per-region stock — no provisioning API, no capabilities service), so it rides
 * the catalog + regions fan-out only and must never reach CapabilitiesProviderFactory.
 * SUPPORTED stays the capability-backed set; anything comparison-wide uses this.
 */
export const COMPARE_PROVIDERS: CloudProvider[] = [...SUPPORTED, CloudProvider.CHERRY];

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
 * Providers vops can price and compare but never provisions: @flui-cloud/infra
 * exposes no write path for them (Cherry Servers is catalog-only). Distinct from
 * "guided" (a provider that COULD be created but places a monthly commitment) —
 * these have no provisioning route at all, so their compare rows carry no Create.
 */
export const READ_ONLY_PROVIDERS: ReadonlySet<CloudProvider> = new Set([
  CloudProvider.CHERRY,
]);

export const isReadOnly = (provider: CloudProvider): boolean =>
  READ_ONLY_PROVIDERS.has(provider);

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
  const n = name.toLowerCase().replace(/\s+/g, '');
  const provider = COMPARE_PROVIDERS.find(
    (p) =>
      n === p ||
      n.startsWith(p) ||
      DISPLAY_NAMES[p].toLowerCase().replace(/\s+/g, '') === n,
  );
  if (!provider) {
    throw new BadRequestException(
      `Unknown provider '${name}'. Supported: ${COMPARE_PROVIDERS.join(', ')}`,
    );
  }
  return provider;
}
