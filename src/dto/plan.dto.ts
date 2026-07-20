/** Stable vops contracts for compute plans, availability and comparison. */
export interface VopsPlan {
  id: string;
  name: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  arch: string;
  cpuType: string;
  bareMetal: boolean;
  hourly: number | null;
  monthly: number | null;
  currency: string;
  hourlyBilling: boolean;
  /** Real provisioning allowed: hourly-billed and not bare metal. */
  createAllowed: boolean;
  /** Non-hourly provider: vops shows how to create but never provisions it. */
  guided: boolean;
}

export interface VopsPlanAvailability {
  id: string;
  name: string;
  locations: Array<{ location: string; available: boolean }>;
  /**
   * Up in every region. The catalog omits the region list for these plans, so
   * `locations` is empty — which is NOT the same as "available nowhere" and must
   * never be rendered as such.
   */
  everywhere?: boolean;
}

/** A catalog answer plus where it came from, so callers can label it. */
export interface VopsAvailabilityResult {
  plans: VopsPlanAvailability[];
  /** false when the provider publishes no real per-location availability. */
  live: boolean;
  ageSeconds: number | null;
  stale: boolean;
}

export interface VopsCompareRow {
  provider: string;
  plan: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  /** 'shared' (contended vCPU) vs 'dedicated' (reserved cores). Bare metal reads dedicated. */
  cpuType: string;
  /** Whole physical machine (no hypervisor) — the Bare metal tier. */
  bareMetal: boolean;
  region: string;
  hourly: number | null;
  monthly: number | null;
  currency: string;
  createAllowed: boolean;
  guided: boolean;
  /** Whole plan retired by the provider — hidden unless explicitly requested. */
  deprecated: boolean;
  /**
   * Every region this plan is offered in (coverage). `up`: true=in stock,
   * false=sold out, null=no signal. `deprecated`: the provider is retiring this
   * location (a distinct state from sold-out — existing servers keep running).
   * Deprecated regions are omitted unless the query opts into them.
   */
  regions: Array<{ code: string; up: boolean | null; deprecated: boolean }>;
}
