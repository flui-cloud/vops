import { VopsFirewallRule } from '../dto/firewall.dto';

/**
 * Host-level firewall — provider-independent. It renders a portable set of rules
 * (the same VopsFirewallRule shape used everywhere) into an nftables ruleset that
 * runs ON the server, so it works identically on OVH, Contabo, Hetzner, Scaleway
 * and BYOS hosts — no dependency on any provider's firewall product or quota.
 *
 * Delivery is separate: at create time via cloud-init (renderCloudInit), or later
 * over SSH to a running host (push the ruleset + `nft -f`).
 */
export interface HostFirewallOptions {
  /** Inbound policy when no rule matches. Default 'drop' (deny-by-default). */
  defaultInboundPolicy?: 'drop' | 'accept';
  /** Always keep inbound SSH (22) open so a drop policy can't lock you out. Default true. */
  keepSshOpen?: boolean;
  /** Allow all outbound. Default true (egress filtering is opt-out, not the common case). */
  allowOutbound?: boolean;
  /** Accept inbound ICMP / ICMPv6 (ping, PMTU). Default true. */
  allowPing?: boolean;
}

const TABLE = 'vops_fw';

interface InboundLine {
  proto: 'tcp' | 'udp';
  portExpr: string;
  v4?: string[];
  v6?: string[];
}

export function renderNftables(
  rules: VopsFirewallRule[],
  opts: HostFirewallOptions = {},
): string {
  const policy = opts.defaultInboundPolicy ?? 'drop';
  const keepSsh = opts.keepSshOpen ?? true;
  const allowOutbound = opts.allowOutbound ?? true;
  const allowPing = opts.allowPing ?? true;

  const inbound = rules.filter((r) => r.direction === 'in');
  const pingWanted = allowPing || inbound.some((r) => r.protocol === 'icmp');
  // Only inject the broad anti-lockout SSH rule if the user hasn't opened 22 themselves
  // (an explicit — even source-restricted — SSH rule is respected, not overridden).
  const needsSshGuard = keepSsh && policy === 'drop' && !inbound.some((r) => coversPort22(r));

  const inputChain = [
    `    type filter hook input priority 0; policy ${policy};`,
    '    ct state established,related accept',
    '    ct state invalid drop',
    '    iif "lo" accept',
    ...(pingWanted ? ['    ip protocol icmp accept', '    ip6 nexthdr icmpv6 accept'] : []),
    ...(needsSshGuard ? ['    tcp dport 22 accept comment "vops: keep-ssh-open"'] : []),
    ...buildInboundLines(inbound).map((l) => `    ${renderInbound(l)}`),
  ];

  const outputChain = [
    `    type filter hook output priority 0; policy ${allowOutbound ? 'accept' : 'drop'};`,
    ...(allowOutbound ? [] : ['    ct state established,related accept', '    oif "lo" accept']),
  ];

  const ruleset = [
    '#!/usr/sbin/nft -f',
    '',
    'flush ruleset',
    '',
    `table inet ${TABLE} {`,
    '  chain input {',
    ...inputChain,
    '  }',
    '  chain forward {',
    '    type filter hook forward priority 0; policy drop;',
    '  }',
    '  chain output {',
    ...outputChain,
    '  }',
    '}',
  ];
  return ruleset.join('\n') + '\n';
}

/**
 * Standalone nftables ruleset that rate-limits NEW inbound SSH connections
 * (anti-brute-force), used by `host harden`. It lives in its OWN table with no
 * `flush ruleset`, so it composes with whatever firewall the host already runs and
 * can never lock you out: it only drops SYNs that exceed the rate, established
 * sessions and the burst allowance always pass.
 */
export function renderSshRateLimit(
  opts: { port?: number; ratePerMinute?: number; burst?: number } = {},
): string {
  const port = opts.port ?? 22;
  const rate = opts.ratePerMinute ?? 10;
  const burst = opts.burst ?? 5;
  return [
    '#!/usr/sbin/nft -f',
    '',
    'table inet vops_ssh_ratelimit {',
    '  chain input {',
    '    type filter hook input priority -10; policy accept;',
    `    tcp dport ${port} ct state new limit rate over ${rate}/minute burst ${burst} packets drop`,
    '  }',
    '}',
    '',
  ].join('\n');
}

/** A #cloud-config that installs nftables, writes the ruleset and applies it at boot. */
export function renderCloudInit(
  rules: VopsFirewallRule[],
  opts: HostFirewallOptions = {},
): string {
  const ruleset = renderNftables(rules, opts);
  const indented = ruleset
    .split('\n')
    .map((l) => (l.length ? `      ${l}` : ''))
    .join('\n');
  return [
    '#cloud-config',
    'package_update: true',
    'packages:',
    '  - nftables',
    'write_files:',
    '  - path: /etc/nftables.conf',
    '    permissions: "0755"',
    '    owner: root:root',
    '    content: |',
    indented.replace(/\n+$/, ''),
    'runcmd:',
    '  - systemctl enable nftables',
    '  - nft -f /etc/nftables.conf',
    '',
  ].join('\n');
}

function buildInboundLines(inbound: VopsFirewallRule[]): InboundLine[] {
  return inbound
    .filter((r) => r.protocol === 'tcp' || r.protocol === 'udp') // icmp handled separately
    .map((r) => {
      const { v4, v6 } = splitCidrs(r.sourceIps);
      return { proto: r.protocol as 'tcp' | 'udp', portExpr: portExpr(r.port), v4, v6 };
    });
}

function renderInbound(l: InboundLine): string {
  const v4 = l.v4 ?? [];
  const v6 = l.v6 ?? [];
  // No specific source on either family = from anywhere → one line, no saddr filter.
  if (v4.length === 0 && v6.length === 0) {
    return `${l.proto} dport ${l.portExpr} accept`;
  }
  const parts: string[] = [];
  if (v4.length) parts.push(`ip saddr ${set(v4)} ${l.proto} dport ${l.portExpr} accept`);
  if (v6.length) parts.push(`ip6 saddr ${set(v6)} ${l.proto} dport ${l.portExpr} accept`);
  return parts.join('\n    ');
}

function splitCidrs(cidrs?: string[]): { v4: string[]; v6: string[] } {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const c of cidrs ?? []) {
    if (c === '0.0.0.0/0') continue; // "any" — no filter needed
    if (c === '::/0') continue;
    (c.includes(':') ? v6 : v4).push(c);
  }
  return { v4, v6 };
}

function set(items: string[]): string {
  return items.length === 1 ? items[0] : `{ ${items.join(', ')} }`;
}

/** Does an inbound TCP rule already open port 22 (exact, list member, or range)? */
function coversPort22(r: VopsFirewallRule): boolean {
  if (r.protocol !== 'tcp' || !r.port) return false;
  const p = r.port.trim();
  if (p === '22') return true;
  if (/^\d+(,\d+)+$/.test(p)) return p.split(',').includes('22');
  const range = /^(\d+)-(\d+)$/.exec(p);
  if (range) return Number(range[1]) <= 22 && 22 <= Number(range[2]);
  return false;
}

function portExpr(port?: string): string {
  if (!port) return '0-65535';
  const trimmed = port.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (/^\d+-\d+$/.test(trimmed)) return trimmed;
  if (/^\d+(,\d+)+$/.test(trimmed)) return `{ ${trimmed.split(',').join(', ')} }`;
  return '0-65535';
}
