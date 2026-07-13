import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapabilitiesProviderFactory, CloudProvider } from '@flui-cloud/infra';
import { VopsCatalogService } from '../catalog/vops-catalog.service';
import { SUPPORTED, resolveProvider } from '../lib/providers';
import { VopsRegion, VopsRegionsResult } from '../dto/region.dto';

interface GeoEntry {
  code: string; city: string; country: string; cc: string;
  lat: number; lng: number; provider: string; continent: string;
}
interface SnapEntry {
  provider: string; code: string;
  fromHourly: number | null; fromMonthly: number | null; currency: string;
}
interface Priced { fromHourly: number | null; fromMonthly: number | null; currency: string; live: boolean }

/**
 * Unified, provider-agnostic region catalogue with a "from X" price per region.
 * Sourcing order: an optional Flui-hosted cached pricing API (VOPS_PRICING_URL) →
 * each provider live (the user's own credentials) → a bundled seed snapshot. The
 * snapshot keeps the map populated even with zero provider credentials configured.
 */
@Injectable()
export class VopsRegionsService {
  private readonly logger = new Logger(VopsRegionsService.name);
  private readonly geo = this.loadJson<GeoEntry[]>('region-geo.json', []);
  private readonly snapshot = this.loadJson<{ updatedAt?: string; regions: SnapEntry[] }>(
    'pricing-snapshot.json',
    { regions: [] },
  );

  constructor(
    private readonly catalog: VopsCatalogService,
    private readonly capabilities: CapabilitiesProviderFactory,
  ) {}

  async regions(refresh = false): Promise<VopsRegionsResult> {
    const remote = await this.fromFluiApi();
    if (remote) return remote;

    const prices = new Map<string, Priced>();
    let live = 0;
    let snap = 0;
    for (const provider of SUPPORTED) {
      const currency = this.currency(provider);
      try {
        for (const r of await this.catalog.regionPrices(provider, refresh)) {
          prices.set(this.key(provider, r.location), { ...r, currency, live: true });
          live++;
        }
      } catch {
        this.logger.warn(`Live pricing for ${provider} unavailable — using seed snapshot.`);
        for (const s of this.snapshot.regions.filter((x) => x.provider === provider)) {
          prices.set(this.key(provider, s.code), {
            fromHourly: s.fromHourly, fromMonthly: s.fromMonthly, currency: s.currency, live: false,
          });
          snap++;
        }
      }
    }

    const regions: VopsRegion[] = this.geo.map((g) => {
      const p = prices.get(this.key(g.provider, g.code));
      return {
        provider: g.provider, code: g.code, city: g.city, country: g.country,
        continent: g.continent, lat: g.lat, lng: g.lng,
        fromHourly: p?.fromHourly ?? null, fromMonthly: p?.fromMonthly ?? null,
        currency: p?.currency ?? this.currency(resolveProvider(g.provider)),
        live: p?.live ?? false,
      };
    });

    let source: VopsRegionsResult['source'] = 'live';
    if (live && snap) source = 'mixed';
    else if (snap) source = 'snapshot';
    return {
      source,
      updatedAt: new Date().toISOString(),
      currency: regions[0]?.currency ?? 'EUR',
      regions,
    };
  }

  /** Future: a Flui-hosted cached pricing API (no per-user provider credentials needed). */
  private async fromFluiApi(): Promise<VopsRegionsResult | null> {
    const url = process.env.VOPS_PRICING_URL;
    if (!url) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as VopsRegionsResult;
    } catch (e) {
      this.logger.warn(`VOPS_PRICING_URL fetch failed (${String(e)}) — falling back to live/snapshot.`);
      return null;
    }
  }

  private key(provider: string, code: string): string {
    return `${provider}:${code}`;
  }

  private currency(provider: CloudProvider): string {
    return this.capabilities
      .getCapabilitiesService(provider)
      .getStaticCapabilities().pricing.currency;
  }

  private loadJson<T>(name: string, fallback: T): T {
    try {
      const p = path.join(__dirname, '..', 'lib', name);
      return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
}
