/** Stable vops firewall contract — mirrors the provider shapes, never leaks them. */
export interface VopsFirewallRule {
  id?: string;
  description: string;
  direction: 'in' | 'out';
  protocol: 'tcp' | 'udp' | 'icmp';
  port?: string;
  sourceIps?: string[];
  destinationIps?: string[];
}

export interface VopsFirewallTarget {
  serverId: string;
  serverName?: string;
}

export interface VopsFirewall {
  provider: string;
  id: string;
  name: string;
  rules: VopsFirewallRule[];
  labels: Record<string, string>;
  appliedTo: VopsFirewallTarget[];
}

export interface VopsFirewallCreateInput {
  provider: string;
  name: string;
  rules?: VopsFirewallRule[];
  applyToServerIds?: string[];
}
