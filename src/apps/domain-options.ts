import { sanitize } from './spec-normalize';
import { sslipHostname } from './ingress-hostname';

/** What hostnames this install could actually use, ranked — shown as real choices for the
 * user's setup rather than requiring they know `--domain auto`/sslip.io/zone internals exist. */
export type DomainOptionKind = 'managed-zone' | 'byo' | 'sslip';

export interface DomainOption {
  kind: DomainOptionKind;
  /** The proposed hostname. Empty for `byo` — the user types that one. */
  hostname: string;
  zone?: string;
  provider?: string;
  recommended: boolean;
  /** Who creates the A record. */
  dns: 'automatic' | 'manual' | 'not-needed';
  /** Whether a certificate can be counted on. */
  tls: 'reliable' | 'best-effort';
  title: string;
  detail: string;
}

export interface DomainOptionInput {
  hostAddress: string;
  installName: string;
  zones: ReadonlyArray<{ provider: string; zoneName: string }>;
}

export function domainOptions(input: DomainOptionInput): DomainOption[] {
  const label = sanitize(input.installName);
  const managed = dedupeZones(input.zones).map((z, i) => ({
    kind: 'managed-zone' as const,
    hostname: `${label}.${z.zoneName}`,
    zone: z.zoneName,
    provider: z.provider,
    // Only the first is preselected; the rest are equally good, just not chosen.
    recommended: i === 0,
    dns: 'automatic' as const,
    tls: 'reliable' as const,
    title: `${label}.${z.zoneName}`,
    detail: `vops creates the A record in your ${z.provider} zone and gets the certificate. Nothing for you to do.`,
  }));

  return [
    ...managed,
    {
      kind: 'byo',
      hostname: '',
      recommended: false,
      dns: 'manual',
      tls: 'reliable',
      title: 'A domain you own',
      detail: `You will need an A record pointing at ${input.hostAddress} before the certificate can be issued.`,
    },
    {
      kind: 'sslip',
      hostname: sslipHostname(input.hostAddress, input.installName),
      // Only worth recommending when there is nothing better available.
      recommended: managed.length === 0,
      dns: 'not-needed',
      tls: 'best-effort',
      title: 'No domain — use a temporary one',
      detail:
        'Works immediately with no DNS at all. The certificate is best-effort: sslip.io is one ' +
        'registered domain shared by everyone using it, and Let’s Encrypt allows 50 certificates ' +
        'per domain per week across all of them.',
    },
  ];
}

/** Zones that exist in a provider's API but not on the public internet — e.g. Scaleway's VPC
 * private DNS (`<uuid>.<uuid>.privatedns`), which passes listing but fails LE cert issuance after deploy.
 * The rest are the RFC-reserved special-use suffixes (`.local`, `.home.arpa`, `.test`, `.invalid`, `.example`). */
const PRIVATE_SUFFIXES = [
  '.privatedns',
  '.local',
  '.localdomain',
  '.internal',
  '.home.arpa',
  '.lan',
  '.intranet',
  '.corp',
  '.home',
  '.test',
  '.invalid',
  '.example',
];

export function isPubliclyResolvable(zoneName: string): boolean {
  const z = zoneName.replace(/\.$/, '').toLowerCase();
  if (!z.includes('.')) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => z === suffix.slice(1) || z.endsWith(suffix));
}

/** The same zone can be listed by two providers; the first one wins. */
function dedupeZones(
  zones: ReadonlyArray<{ provider: string; zoneName: string }>,
): Array<{ provider: string; zoneName: string }> {
  const seen = new Set<string>();
  const out: Array<{ provider: string; zoneName: string }> = [];
  for (const z of zones) {
    const key = z.zoneName.replace(/\.$/, '').toLowerCase();
    if (seen.has(key) || !isPubliclyResolvable(key)) continue;
    seen.add(key);
    out.push({ provider: z.provider, zoneName: key });
  }
  // Shortest first: among a user's own domains the apex is almost always the one
  // they think of as "their" domain, and it is the one to preselect.
  return out.sort((a, b) => a.zoneName.length - b.zoneName.length || a.zoneName.localeCompare(b.zoneName));
}
