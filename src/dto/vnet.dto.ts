/** Stable vops private-network contract — mirrors the provider shapes. */
export interface VopsSubnet {
  id?: string;
  ipRange: string;
  networkZone: string;
  gateway?: string;
}

export interface VopsRoute {
  destination: string;
  gateway: string;
}

export interface VopsVnet {
  provider: string;
  id: string;
  name: string;
  ipRange: string;
  subnets: VopsSubnet[];
  routes: VopsRoute[];
  attachedServerIds: string[];
  labels: Record<string, string>;
  created: string | null;
}

export interface VopsVnetCreateInput {
  provider: string;
  name: string;
  ipRange: string;
  subnets?: Array<{ ipRange: string; networkZone: string }>;
}
