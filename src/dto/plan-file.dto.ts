import { VopsFirewallRule } from './firewall.dto';

/** Host-level firewall (nftables) applied at boot via cloud-init — provider-independent. */
export interface VopsHostFirewall {
  rules: VopsFirewallRule[];
  policy?: 'drop' | 'accept';
  keepSshOpen?: boolean;
  allowPing?: boolean;
  allowOutbound?: boolean;
}

/** Portable, versioned provisioning plan — the `vops.plan.v1` contract. */
export interface VopsBillingGate {
  providerBilling: string;
  planSupportsHourly: boolean;
  bareMetal: boolean;
  /** Real provisioning allowed (hourly-billed, non-bare-metal). */
  allowed: boolean;
  /** Non-hourly provider: vops shows HOW to create but never provisions it. */
  guided: boolean;
  reason: string | null;
}

export interface VopsEstimatedCost {
  hourly: number | null;
  monthly: number | null;
  currency: string;
}

export interface VopsPlanFile {
  version: 'vops.plan.v1';
  action: 'server.create';
  provider: string;
  name: string;
  plan: string;
  location: string;
  image: string;
  sshKey: { mode: 'existing' | 'none'; id: string | null };
  hostFirewall?: VopsHostFirewall;
  billingGate: VopsBillingGate;
  estimatedCost: VopsEstimatedCost;
  createdAt: string;
}

export interface VopsServer {
  id: string;
  name: string;
  type: string;
  location: string;
  status: string;
  publicIp: string | null;
  /** True only for resources vops created — gates destructive UI actions. */
  managed: boolean;
}
