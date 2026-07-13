import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ProviderFactory,
  CapabilitiesProviderFactory,
  CloudProvider,
  NodeSizeDto,
} from '@flui-cloud/infra';
import {
  DISPLAY_NAMES,
  SUPPORTED,
  isGuided,
  resolveProvider,
} from '../lib/providers';
import { LocalStore } from '../lib/store/local-store';
import {
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

  async availability(
    name: string,
    family?: string,
    refresh = false,
  ): Promise<VopsPlanAvailability[]> {
    const provider = resolveProvider(name);
    const sizes = await this.nodeSizes(provider, refresh);
    return sizes
      .filter((s) => !family || s.name.toLowerCase().startsWith(family.toLowerCase()))
      .map((s) => ({
        id: s.id,
        name: s.name,
        locations: (s.availability ?? []).map((a) => ({
          location: a.location,
          available: a.available,
        })),
      }));
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
      : SUPPORTED;
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
    const sizes = await service.getNodeSizes(true);
    await this.store.setCache(key, sizes, NODE_SIZES_TTL_SECONDS);
    return sizes;
  }

  private currency(provider: CloudProvider): string {
    return this.capabilities
      .getCapabilitiesService(provider)
      .getStaticCapabilities().pricing.currency;
  }
}
