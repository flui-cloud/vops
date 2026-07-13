import { BillingModel } from '../safety/write-gate';

/** Stable vops contract — never expose internal Flui entity shapes directly. */
export interface VopsProviderFeatures {
  firewall: boolean;
  dns: boolean;
  privateNetwork: boolean;
  snapshots: boolean;
}

export interface VopsProviderSummary {
  provider: string;
  displayName: string;
  billingModel: BillingModel;
  writeEnabled: boolean;
  writeDisabledReason: string | null;
  /** Non-hourly provider: vops shows how to create but never provisions it. */
  guided: boolean;
  features: VopsProviderFeatures;
}

export interface VopsProviderCapabilities extends VopsProviderSummary {
  credentialType: string;
  currency: string;
  minimumCost: number;
  firewallBackend: string;
  privateNetworkRequired: boolean;
}

export interface VopsLocation {
  id: string;
  name: string;
  location: string;
  available: boolean;
  country: string | null;
}
