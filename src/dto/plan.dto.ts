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
}

export interface VopsCompareRow {
  provider: string;
  plan: string;
  cores: number;
  memoryGb: number;
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
