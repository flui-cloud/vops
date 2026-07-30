import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ProviderFactory,
  CapabilitiesProviderFactory,
  CloudProvider,
  NodeSizeDto,
} from '@flui-cloud/infra';
import {
  DISPLAY_NAMES,
  COMPARE_PROVIDERS,
  isGuided,
  needsCredentialToPrice,
  resolveProvider,
} from '../lib/providers';
import { credentialReach } from '../lib/credentials/provider-credentials';
import { VaultLockedError } from '../lib/keyring/vault-session';
import { LocalStore } from '../lib/store/local-store';
import { CloudClient, RemoteAvailabilityReport } from '../lib/cloud-client';
import {
  VopsAvailabilityResult,
  VopsCompareFailure,
  VopsCompareReport,
  VopsCompareRow,
  VopsCompareSkip,
  VopsCompareSkipCause,
  VopsPlan,
  VopsPlanAvailability,
} from '../dto/plan.dto';
import { dedupeVirtualTwins } from './virtual-twins';

export interface CompareQuery {
  cpu?: number;
  ramGb?: number;
  region?: string;
  hourlyOnly?: boolean;
  provider?: string;
  refresh?: boolean;
  /** Include retired plans/regions (hidden by default — they aren't purchasable). */
  includeDeprecated?: boolean;
}

const NODE_SIZES_TTL_SECONDS = 3600;
// Availability moves; plan shapes and prices do not. Short enough that a reading
// is never badly out of date, long enough that one dashboard render is one call.
const AVAILABILITY_TTL_SECONDS = 60;

interface CachedAvailability {
  report: RemoteAvailabilityReport;
  fetchedAt: number;
}

/** Add the time an entry sat in the local cache to the server-reported age. */
function agedBy(report: RemoteAvailabilityReport, heldMs: number): RemoteAvailabilityReport {
  if (report.meta?.ageSeconds == null) return report;
  const ageSeconds = report.meta.ageSeconds + Math.max(0, Math.round(heldMs / 1000));
  return {
    ...report,
    meta: { ...report.meta, ageSeconds, stale: ageSeconds > report.meta.staleAfterSeconds },
  };
}

const nodeSizesKey = (provider: CloudProvider): string => `nodesizes:${provider}`;

/** Says which of the two unreachable states left the provider out, in the user's terms —
 * "configure it" and "unlock the vault you already filled" are different instructions. */
function skipReason(
  provider: CloudProvider,
  cause: VopsCompareSkipCause,
): { cause: VopsCompareSkipCause; reason: string } {
  const priced = 'its plans are priced through its authenticated API';
  return cause === 'sealed'
    ? { cause, reason: `the vault is sealed, so no credential for ${provider} could be read without a passphrase — ${priced}` }
    : { cause, reason: `no credential is configured for ${provider} — ${priced}` };
}

/** Live compute research over the shared provider services (getNodeSizes). */
@Injectable()
export class VopsCatalogService {
  constructor(
    private readonly providers: ProviderFactory,
    private readonly capabilities: CapabilitiesProviderFactory,
    private readonly store: LocalStore,
  ) {}

  async plans(name: string, refresh = false): Promise<VopsPlan[]> {
    const provider = resolveProvider(name);
    const sizes = await this.nodeSizes(provider, refresh);
    const currency = this.currency(provider);
    return sizes.map((s) => this.toPlan(provider, s, currency));
  }

  /** Resolve a single plan's raw node size by name or id (for provisioning). */
  async planNodeSize(name: string, plan: string): Promise<NodeSizeDto | null> {
    const provider = resolveProvider(name);
    const sizes = await this.nodeSizes(provider);
    const wanted = plan.toLowerCase();
    return (
      sizes.find((s) => s.name.toLowerCase() === wanted || s.id === plan) ?? null
    );
  }

  /**
   * Per-location availability, served from the hosted vops catalog rather than
   * the user's own provider credentials.
   *
   * Deliberately ONE path, not "own keys with a fallback". The provider SDKs
   * swallow an unconfigured-credentials error into a generic failure (Hetzner
   * rethrows a bare "Failed to fetch node sizes"), so a fallback keyed on catching
   * errors could not tell "no keys" from "provider is down" — and would quietly
   * serve a cached snapshot during a real outage. Going through the catalog for
   * everyone keeps the answer honest and makes the command work on a fresh
   * install with nothing configured, which is the point.
   *
   * The cost is that the reading is a snapshot, never live; `stale`/`ageSeconds`
   * are returned so the caller can say so out loud.
   */
  async availability(
    name: string,
    family?: string,
    refresh = false,
  ): Promise<VopsAvailabilityResult> {
    const provider = resolveProvider(name);
    const report = await this.availabilityReport(provider, refresh);
    const matches = (plan: string) =>
      !family || plan.toLowerCase().startsWith(family.toLowerCase());

    const limited: VopsPlanAvailability[] = report.limited
      .filter((p) => matches(p.plan))
      .map((p) => ({
        id: p.plan,
        name: p.plan,
        locations: p.regions.map((r) => ({ location: r.code, available: r.up })),
      }));

    // `everywhere` plans arrive as bare names — the catalog drops their region
    // list precisely because every region is up. Flagged, not faked.
    const everywhere: VopsPlanAvailability[] = report.everywhere
      .filter(matches)
      .map((plan) => ({ id: plan, name: plan, locations: [], everywhere: true }));

    return {
      plans: [...limited, ...everywhere],
      live: report.live,
      ageSeconds: report.meta?.ageSeconds ?? null,
      stale: report.meta?.stale ?? false,
    };
  }

  /** Cheapest hourly/monthly price per location — the "from X" per region. */
  async regionPrices(
    name: string,
    refresh = false,
  ): Promise<Array<{ location: string; fromHourly: number | null; fromMonthly: number | null }>> {
    const provider = resolveProvider(name);
    const sizes = await this.nodeSizes(provider, refresh);
    const byLoc = new Map<string, { h: number[]; m: number[] }>();
    for (const size of sizes) {
      for (const p of size.prices) {
        const slot = byLoc.get(p.location) ?? { h: [], m: [] };
        const h = Number.parseFloat(p.priceHourly?.net ?? '');
        const m = Number.parseFloat(p.priceMonthly?.net ?? '');
        if (Number.isFinite(h) && h > 0) slot.h.push(h);
        if (Number.isFinite(m) && m > 0) slot.m.push(m);
        byLoc.set(p.location, slot);
      }
    }
    return [...byLoc.entries()].map(([location, v]) => ({
      location,
      fromHourly: v.h.length ? Math.min(...v.h) : null,
      fromMonthly: v.m.length ? Math.min(...v.m) : null,
    }));
  }

  /**
   * Just the rows, for callers with nowhere to put a partial result (the local API).
   * A provider that failed is re-thrown rather than dropped: silently returning the
   * survivors would be the very omission `compareReport` exists to prevent, and this
   * signature has no channel to name it.
   */
  async compare(query: CompareQuery): Promise<VopsCompareRow[]> {
    const report = await this.compareReport(query);
    if (report.failed.length) throw report.failed[0].error;
    return report.rows;
  }

  /** The comparison plus the providers it could not ask and the ones that failed: a
   * fan-out that quietly drops a provider reads as "these are all the options", and one
   * provider's outage must not cost the user the four that answered. */
  async compareReport(query: CompareQuery): Promise<VopsCompareReport> {
    const targets = query.provider
      ? [resolveProvider(query.provider)]
      : COMPARE_PROVIDERS;
    const rows: VopsCompareRow[] = [];
    const skipped: VopsCompareSkip[] = [];
    const failed: VopsCompareFailure[] = [];
    for (const provider of targets) {
      const outcome = await this.providerSizes(provider, query);
      if ('skip' in outcome) {
        skipped.push({ provider: DISPLAY_NAMES[provider] ?? provider, ...skipReason(provider, outcome.skip) });
        continue;
      }
      if ('error' in outcome) {
        failed.push({ provider: DISPLAY_NAMES[provider] ?? provider, error: outcome.error });
        continue;
      }
      const currency = this.currency(provider);
      for (const size of outcome.sizes) {
        const row = this.toCompareRow(provider, size, currency, query);
        if (row) rows.push(row);
      }
    }
    // Sort by effective hourly cost so monthly-only providers (Contabo) interleave
    // by real price instead of dumping at the bottom (~730 h/month).
    const effHourly = (r: VopsCompareRow) =>
      r.hourly ?? (r.monthly == null ? Infinity : r.monthly / 730);
    const sorted = [...rows].sort((a, b) => effHourly(a) - effHourly(b));
    return { rows: sorted, skipped, failed };
  }

  /**
   * One provider's contribution to the fan-out, isolated: a rejection is captured and
   * reported beside the other providers' rows instead of propagating out of the loop and
   * emptying the whole comparison. Only the fan-out is isolated — when the user names a
   * provider it is the only thing they asked for, so its failure is the command's failure
   * and is thrown the way it always was.
   *
   * A sealed vault reaching here is the very condition `comparableSizes` screens for up
   * front, arriving by a path it does not screen (a provider that prices publicly but whose
   * client still reads a credential). It stays a *skip*: `compare()` rethrows the first
   * failure, so recording it as one would turn the command that must work on a fresh
   * install back into an error.
   */
  private async providerSizes(
    provider: CloudProvider,
    query: CompareQuery,
  ): Promise<{ sizes: NodeSizeDto[] } | { skip: VopsCompareSkipCause } | { error: unknown }> {
    if (query.provider) return { sizes: await this.nodeSizes(provider, query.refresh) };
    try {
      return await this.comparableSizes(provider, query.refresh);
    } catch (error) {
      if (error instanceof VaultLockedError) return { skip: 'sealed' };
      return { error };
    }
  }

  /**
   * One provider's sizes for the comparison fan-out. `compare` is the command that
   * has to work on a fresh install with nothing configured, so it must never make
   * the vault ask for a passphrase: a provider that prices only through its
   * authenticated API, with no credential reachable without prompting, is left out
   * of the comparison rather than dragged into the credential path. A cached
   * catalog needs no credential at all, so it is preferred over the check.
   *
   * Naming a provider (`--provider hetzner`) still goes the ordinary way: there the
   * credential is exactly what the user asked to spend.
   *
   * `skip` means "left out", never "has nothing" — and it carries which of the two
   * unreachable states it was, because the remedies differ.
   */
  private async comparableSizes(
    provider: CloudProvider,
    refresh?: boolean,
  ): Promise<{ sizes: NodeSizeDto[] } | { skip: VopsCompareSkipCause }> {
    const cached = refresh
      ? null
      : await this.store.getCache<NodeSizeDto[]>(nodeSizesKey(provider));
    if (cached) return { sizes: cached };
    if (needsCredentialToPrice(provider)) {
      const reach = await credentialReach(provider);
      if (reach !== 'reachable') return { skip: reach };
    }
    return { sizes: await this.nodeSizes(provider, refresh) };
  }

  private toCompareRow(
    provider: CloudProvider,
    size: NodeSizeDto,
    currency: string,
    query: CompareQuery,
  ): VopsCompareRow | null {
    if (query.cpu && size.cores < query.cpu) return null;
    if (query.ramGb && size.memory < query.ramGb) return null;
    // Buy-new view: a fully-retired plan isn't purchasable — hide it unless asked.
    if (size.deprecated && !query.includeDeprecated) return null;
    const plan = this.toPlan(provider, size, currency);
    // "hourly only" strictly hides non-hourly (monthly-billed / bare-metal) plans.
    if (query.hourlyOnly && !plan.createAllowed) return null;
    const priced = this.cheapestRegion(size, query.region, query.includeDeprecated);
    if (query.region && !priced) return null;
    const regions = this.regionsFor(size, query.includeDeprecated);
    return {
      provider: DISPLAY_NAMES[provider] ?? provider,
      plan: size.name,
      cores: size.cores,
      memoryGb: size.memory,
      diskGb: size.disk,
      cpuType: size.cpuType,
      bareMetal: size.bareMetal,
      region: priced?.location ?? size.prices[0]?.location ?? '-',
      hourly: plan.hourly,
      monthly: plan.monthly,
      currency,
      createAllowed: plan.createAllowed,
      guided: plan.guided,
      deprecated: size.deprecated ?? false,
      regions,
    };
  }

  /** Locations the provider is retiring for this plan (per-location deprecated flag). */
  private deprecatedLocations(size: NodeSizeDto): Set<string> {
    return new Set(
      (size.availability ?? [])
        .filter((a) => a.deprecated)
        .map((a) => a.location.toLowerCase()),
    );
  }

  /**
   * Full region set for a plan: every priced region (coverage, `up: null`)
   * merged with the provider's live stock where reported. `deprecated` is a
   * distinct state (retiring — existing servers keep running), NOT folded into
   * sold-out. Deprecated regions are dropped unless includeDeprecated. Ordered
   * active up → unknown → down, deprecated last.
   */
  private regionsFor(
    size: NodeSizeDto,
    includeDeprecated?: boolean,
  ): Array<{ code: string; up: boolean | null; deprecated: boolean }> {
    const retired = this.deprecatedLocations(size);
    const byCode = new Map<
      string,
      { code: string; up: boolean | null; deprecated: boolean }
    >();
    for (const p of size.prices) {
      const key = p.location.toLowerCase();
      const deprecated = retired.has(key);
      if (deprecated && !includeDeprecated) continue;
      if (!byCode.has(key)) byCode.set(key, { code: p.location, up: null, deprecated });
    }
    for (const a of size.availability ?? []) {
      const key = a.location.toLowerCase();
      if (a.deprecated && !includeDeprecated) continue;
      const existing = byCode.get(key);
      if (existing) existing.up = a.available;
      else byCode.set(key, { code: a.location, up: a.available, deprecated: a.deprecated });
    }
    const rank = (r: { up: boolean | null; deprecated: boolean }): number => {
      if (r.deprecated) return 3;
      if (r.up === true) return 0;
      if (r.up === null) return 1;
      return 2;
    };
    return [...byCode.values()].sort((a, b) => rank(a) - rank(b));
  }

  /** Cheapest priced location (effective hourly), pinned to a region if given. */
  private cheapestRegion(
    size: NodeSizeDto,
    region?: string,
    includeDeprecated?: boolean,
  ) {
    const retired = this.deprecatedLocations(size);
    const eff = (p: NodeSizeDto['prices'][number]): number => {
      const h = Number.parseFloat(p.priceHourly?.net ?? '');
      if (Number.isFinite(h) && h > 0) return h;
      const m = Number.parseFloat(p.priceMonthly?.net ?? '');
      if (Number.isFinite(m) && m > 0) return m / 730;
      return Infinity;
    };
    const pool = size.prices.filter((p) => {
      if (retired.has(p.location.toLowerCase()) && !includeDeprecated) return false;
      return !region || p.location === region;
    });
    if (!pool.length) return null;
    return [...pool].sort((a, b) => eff(a) - eff(b))[0];
  }

  private toPlan(
    provider: CloudProvider,
    size: NodeSizeDto,
    currency: string,
  ): VopsPlan {
    const hourly = this.cheapest(size, 'priceHourly');
    const monthly = this.cheapest(size, 'priceMonthly');
    const createAllowed = !size.bareMetal && size.supportsHourlyBilling;
    const guided = !size.bareMetal && !createAllowed && isGuided(provider);
    return {
      id: size.id,
      name: size.name,
      cores: size.cores,
      memoryGb: size.memory,
      diskGb: size.disk,
      arch: size.architecture,
      cpuType: size.cpuType,
      bareMetal: size.bareMetal,
      hourly,
      monthly,
      currency,
      hourlyBilling: size.supportsHourlyBilling,
      createAllowed,
      guided,
    };
  }

  private cheapest(
    size: NodeSizeDto,
    field: 'priceHourly' | 'priceMonthly',
  ): number | null {
    const values = size.prices
      .map((p) => Number.parseFloat(p[field]?.net ?? ''))
      .filter((n) => Number.isFinite(n) && n > 0);
    return values.length ? Math.min(...values) : null;
  }

  /**
   * Cached catalog read. The dashboard fans out one availability request per
   * provider on every page load, so without this a single home render was one
   * round trip to the hosted API per provider, every time.
   *
   * The TTL is short on purpose: availability is the thing that moves (the server
   * itself calls a snapshot stale after 600s), so the hour-long TTL used for plan
   * shapes and prices would be wrong here.
   *
   * `fetchedAt` is stored alongside because `meta.ageSeconds` is the age *at the
   * server, when we fetched*. Replaying it verbatim from cache would under-report
   * the age by however long the entry has been sitting here — and printing a
   * reading as fresher than it is defeats the point of printing the age at all.
   */
  private async availabilityReport(
    provider: CloudProvider,
    refresh: boolean,
  ): Promise<RemoteAvailabilityReport> {
    const key = `availability:${provider}`;
    if (!refresh) {
      const cached = await this.store.getCache<CachedAvailability>(key);
      if (cached?.report) return agedBy(cached.report, Date.now() - cached.fetchedAt);
    }
    const report = await new CloudClient().availabilityReport(provider);
    const entry: CachedAvailability = { report, fetchedAt: Date.now() };
    await this.store.setCache(key, entry, AVAILABILITY_TTL_SECONDS);
    return report;
  }

  private async nodeSizes(
    provider: CloudProvider,
    refresh = false,
  ): Promise<NodeSizeDto[]> {
    const key = nodeSizesKey(provider);
    if (!refresh) {
      const cached = await this.store.getCache<NodeSizeDto[]>(key);
      if (cached) return cached;
    }
    const service = this.providers.getProvider(provider);
    if (!service.getNodeSizes) {
      throw new BadRequestException(
        `Provider ${provider} does not expose plan/pricing data.`,
      );
    }
    // Collapse same-machine billing twins (Cherry B1/B2) before caching, so every
    // consumer — compare, plans, region prices — sees one row per real machine.
    const sizes = dedupeVirtualTwins(await service.getNodeSizes(true));
    await this.store.setCache(key, sizes, NODE_SIZES_TTL_SECONDS);
    return sizes;
  }

  private currency(provider: CloudProvider): string {
    // Defensive: fall back to EUR if a provider has no registered capabilities service.
    try {
      return this.capabilities
        .getCapabilitiesService(provider)
        .getStaticCapabilities().pricing.currency;
    } catch {
      return 'EUR';
    }
  }
}
