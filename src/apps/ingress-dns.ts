/** Auto A-record via the flui-infra DNS layer. Zone lookup is by longest-suffix across ALL
 * configured DNS providers (the zone may live elsewhere than the host's cloud), never keyed off it.
 * Writing is guarded by `ingress-dns-plan.ts`: anything not already ours stops the deploy. */
import {
  DnsProvider,
  DnsProviderFactory,
  DnsRecordInfo,
  DnsRecordType,
  DnsZoneInfo,
  IDnsProvider,
} from '@flui-cloud/infra';
import { IngressDnsRecord } from './app.model';
import { pickZone, recordName } from './ingress-hostname';
import { DnsConflictError, DnsPlan, planARecord } from './ingress-dns-plan';

const RECORD_TTL = 300;

export interface DnsZoneMatch {
  provider: string;
  zoneId: string;
  zoneName: string;
  /** Record name relative to the zone (`@` at the apex). */
  name: string;
}

/** The zone that owns `fqdn`, across every configured provider. Null = none. */
export async function findZone(
  factory: DnsProviderFactory,
  fqdn: string,
): Promise<{ match: DnsZoneMatch; svc: IDnsProvider } | null> {
  for (const provider of factory.getSupportedProviders()) {
    const svc = factory.getDnsProvider(provider);
    if (!svc) continue;
    let zones: DnsZoneInfo[];
    try {
      zones = await svc.listZones();
    } catch {
      continue; // provider present but unconfigured (no token) → not our zone host
    }
    const zone = pickZone(zones, fqdn);
    if (!zone) continue;
    return {
      svc,
      match: {
        provider: String(provider),
        zoneId: zone.zoneId,
        zoneName: zone.name,
        name: recordName(fqdn, zone.name),
      },
    };
  }
  return null;
}

/** Every zone vops can write to, for offering the user a hostname it can finish. */
export async function listWritableZones(factory: DnsProviderFactory): Promise<Array<{ provider: string; zoneName: string }>> {
  const out: Array<{ provider: string; zoneName: string }> = [];
  for (const provider of factory.getSupportedProviders()) {
    const svc = factory.getDnsProvider(provider);
    if (!svc) continue;
    try {
      for (const z of await svc.listZones()) out.push({ provider: String(provider), zoneName: z.name });
    } catch {
      continue;
    }
  }
  return out;
}

export interface DnsPreflight {
  zone: DnsZoneMatch | null;
  plan: DnsPlan | null;
}

/** What would happen, without changing anything. Shown by preflight/dry-run. */
export async function previewARecord(
  factory: DnsProviderFactory,
  fqdn: string,
  ip: string,
): Promise<DnsPreflight> {
  const found = await findZone(factory, fqdn);
  if (!found) return { zone: null, plan: null };
  const records = await found.svc.listRecords(found.match.zoneId);
  return { zone: found.match, plan: planARecord(records, found.match.name, fqdn, ip) };
}

/** How the record got to point here. A name vops has just written is still propagating to
 * its authoritative nameservers; one that already pointed here is not. */
export type DnsEnsureAction = 'created' | 'reused' | 'repointed';

export interface EnsuredRecord {
  record: IngressDnsRecord;
  action: DnsEnsureAction;
}

export async function ensureARecord(
  factory: DnsProviderFactory,
  fqdn: string,
  ip: string,
  opts: { force?: boolean } = {},
): Promise<EnsuredRecord | null> {
  const found = await findZone(factory, fqdn);
  if (!found) return null;
  const { svc, match } = found;

  const records = await svc.listRecords(match.zoneId);
  const plan = planARecord(records, match.name, fqdn, ip);

  if (plan.action === 'conflict' && !opts.force) throw new DnsConflictError(fqdn, plan);
  if (plan.action === 'reuse' && plan.existing) {
    return { record: record(match, fqdn, plan.existing.recordId), action: 'reused' };
  }

  // Delete-then-create rather than updateRecord: Hetzner Cloud DNS encodes the
  // value into the record id, so an in-place "update" to a new IP adds a SECOND
  // A value (round-robin to a dead host) instead of replacing.
  const repointed = plan.stale.length > 0;
  for (const stale of plan.stale) await svc.deleteRecord(match.zoneId, stale.recordId);
  const created = await create(svc, match, ip);
  return { record: record(match, fqdn, created.recordId), action: repointed ? 'repointed' : 'created' };
}

export async function deleteARecord(factory: DnsProviderFactory, dns: IngressDnsRecord): Promise<void> {
  const svc = factory.getDnsProvider(dns.provider as DnsProvider);
  if (!svc) return;
  try {
    await svc.deleteRecord(dns.zoneId, dns.recordId);
  } catch {
    // Best-effort: a record removed out of band (or a rotated token) must not
    // block app teardown.
  }
}

function create(svc: IDnsProvider, match: DnsZoneMatch, ip: string): Promise<DnsRecordInfo> {
  return svc.createRecord({
    zoneId: match.zoneId,
    type: DnsRecordType.A,
    name: match.name,
    value: ip,
    ttl: RECORD_TTL,
  });
}

function record(match: DnsZoneMatch, fqdn: string, recordId: string): IngressDnsRecord {
  return {
    provider: match.provider,
    zoneId: match.zoneId,
    zoneName: match.zoneName,
    recordId,
    name: fqdn,
  };
}
