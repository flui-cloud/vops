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
  isReadOnly,
  resolveProvider,
} from '../lib/providers';
import { LocalStore } from '../lib/store/local-store';
import { CloudClient, RemoteAvailabilityReport } from '../lib/cloud-client';
import {
  VopsAvailabilityResult,
  VopsCompareRow,
  VopsPlan,
  VopsPlanAvailability,
} from '../dto/plan.dto';

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
  if (!report.meta || report.meta.ageSeconds == null) return report;
  const ageSeconds = report.meta.ageSeconds + Math.max(0, Math.round(heldMs / 1000));
  return {
    ...report,
    meta: { ...report.meta, ageSeconds, stale: ageSeconds > report.meta.staleAfterSeconds },
  };
}

/** A size's flat hourly rate (min across regions) — the twin-dedup discriminator. */
function sizeHourly(size: NodeSizeDto): number | null {
  const hs = size.prices
    .map((p) => Number.parseFloat(p.priceHourly?.net ?? ''))
    .filter((n) => Number.isFinite(n) && n > 0);
  return hs.length ? Math.min(...hs) : null;
}
/** A size's cheapest monthly — the price kept when collapsing twins. */
function sizeMonthly(size: NodeSizeDto): number {
  const ms = size.prices
    .map((p) => Number.parseFloat(p.priceMonthly?.net ?? ''))
    .filter((n) => Number.isFinite(n) && n > 0);
  return ms.length ? Math.min(...ms) : Number.POSITIVE_INFINITY;
}
const sizeRegions = (size: NodeSizeDto): Set<string> =>
  new Set(size.prices.map((p) => p.location.toLowerCase()));
/** Does `a` serve every region `b` does — so dropping `b` for `a` loses no coverage. */
function sizeCovers(a: NodeSizeDto, b: NodeSizeDto): boolean {
  const set = sizeRegions(a);
  return [...sizeRegions(b)].every((code) => set.has(code));
}

/**
 * Collapse "virtual twins": one machine a provider lists under two SKUs that
 * match on cores/RAM/disk/cpuType/arch AND an identical hourly rate, differing
 * only in the monthly commitment — Cherry's B1 (Gen-1 list) and B2 (Gen-2 promo)
 * "Cloud VPS 1" lines are identical in specs and €/h, so shown side by side the
 * dearer B1 reads as a rip-off. An identical hourly is the signature of "same
 * machine, different billing tier"; a genuinely different product carries a
 * different hourly (Cherry's G1/G2/P1/C1 VDS all do). Within a group keep the
 * cheapest monthly and drop a twin ONLY when the survivor also covers every one
 * of its regions — else both stay, so a promo scoped to fewer regions can never
 * silently drop the list SKU's extra regions. Bare metal is never collapsed: two
 * physical machines at one price are two machines, not billing twins.
 */
function dedupeVirtualTwins(sizes: NodeSizeDto[]): NodeSizeDto[] {
  const groups = new Map<string, NodeSizeDto[]>();
  const metal: NodeSizeDto[] = [];
  for (const s of sizes) {
    if (s.bareMetal) {
      metal.push(s);
      continue;
    }
    const h = sizeHourly(s);
    const key = `${s.cores}|${s.memory}|${s.disk ?? 0}|${s.cpuType ?? '?'}|${s.architecture ?? '?'}|${h == null ? 'm' : h.toFixed(4)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  const kept: NodeSizeDto[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const [best, ...rest] = [...group].sort((a, b) => sizeMonthly(a) - sizeMonthly(b));
    kept.push(best);
    // Keep any twin whose regions the survivor does not fully cover.
    for (const twin of rest) if (!sizeCovers(best, twin)) kept.push(twin);
  }
  return [...metal, ...kept];
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

  async compare(query: CompareQuery): Promise<VopsCompareRow[]> {
    const targets = query.provider
      ? [resolveProvider(query.provider)]
      : COMPARE_PROVIDERS;
    const rows: VopsCompareRow[] = [];
    for (const provider of targets) {
      const currency = this.currency(provider);
      const sizes = await this.nodeSizes(provider, query.refresh);
      for (const size of sizes) {
        const row = this.toCompareRow(provider, size, currency, query);
        if (row) rows.push(row);
      }
    }
    // Sort by effective hourly cost so monthly-only providers (Contabo) interleave
    // by real price instead of dumping at the bottom (~730 h/month).
    const effHourly = (r: VopsCompareRow) =>
      r.hourly ?? (r.monthly == null ? Infinity : r.monthly / 730);
    return rows.sort((a, b) => effHourly(a) - effHourly(b));
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
    // Read-only providers (Cherry) have no infra provisioning path, so a hourly
    // non-metal plan is still never creatable by vops — compare-only.
    const createAllowed =
      !size.bareMetal && size.supportsHourlyBilling && !isReadOnly(provider);
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
    const key = `nodesizes:${provider}`;
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
    // Read-only providers (Cherry) have no capabilities service; they quote EUR.
    try {
      return this.capabilities
        .getCapabilitiesService(provider)
        .getStaticCapabilities().pricing.currency;
    } catch {
      return 'EUR';
    }
  }
}
