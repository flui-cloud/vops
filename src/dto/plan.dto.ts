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

/** Why a provider was never asked for a price. Two different remedies, so they are
 * two different states: `unconfigured` needs a credential, `sealed` needs an unlock. */
export type VopsCompareSkipCause = 'unconfigured' | 'sealed';

/** A provider left out of a cross-provider comparison, and why — so "cheapest" is
 * never read as complete when a provider was never asked. */
export interface VopsCompareSkip {
  provider: string;
  cause: VopsCompareSkipCause;
  reason: string;
}

/** A provider that WAS asked and failed. Distinct from a skip: nothing is known about
 * its prices, and the error is carried verbatim so the command layer maps it to the same
 * code and exit it would have had if it were the only provider in the fan-out. */
export interface VopsCompareFailure {
  provider: string;
  error: unknown;
}

export interface VopsCompareReport {
  rows: VopsCompareRow[];
  skipped: VopsCompareSkip[];
  failed: VopsCompareFailure[];
}
