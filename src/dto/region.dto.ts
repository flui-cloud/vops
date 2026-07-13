/** Unified, provider-agnostic region view — the map + the region list consume this. */
export interface VopsRegion {
  provider: string;
  code: string;
  city: string;
  country: string;
  continent: string;
  lat: number;
  lng: number;
  fromHourly: number | null;
  fromMonthly: number | null;
  currency: string;
  /** true = priced from the provider live now; false = from the bundled seed snapshot. */
  live: boolean;
}

export interface VopsRegionsResult {
  /** 'live' = all priced live, 'snapshot' = all from seed, 'mixed' = some of each. */
  source: 'live' | 'snapshot' | 'mixed';
  updatedAt: string;
  currency: string;
  regions: VopsRegion[];
}
