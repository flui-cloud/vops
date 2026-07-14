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
  /** Always keep inbound SSH open so a drop policy can't lock you out. Default true. */
  keepSshOpen?: boolean;
  /** SSH port to keep open. Default 22. */
  sshPort?: number;
  /**
   * Managed-engine guarantee (flui model): keep the SSH port open to the whole
   * world unconditionally — even if a rule tries to restrict/close it. Makes the
   * host firewall lock-out-proof by construction, so no rollback dance is needed.
   * Default false (the CLI renderer keeps the softer keepSshOpen behaviour).
   */
  sshAlwaysOpen?: boolean;
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
  const sshPort = opts.sshPort ?? 22;
  const sshAlwaysOpen = opts.sshAlwaysOpen ?? false;
  const allowOutbound = opts.allowOutbound ?? true;
  const allowPing = opts.allowPing ?? true;

  const inbound = rules.filter((r) => r.direction === 'in');
  const pingWanted = allowPing || inbound.some((r) => r.protocol === 'icmp');
  // Keep SSH reachable. Managed engine (sshAlwaysOpen): unconditional — the port
  // can't be closed. CLI renderer: the softer guard — inject only when the policy
  // drops AND the user hasn't opened the SSH port themselves (an explicit,
  // even source-restricted, SSH rule is respected there).
  const keepSshLine = sshAlwaysOpen || (keepSsh && policy === 'drop' && !inbound.some((r) => coversPort(r, sshPort)));
  const sshComment = sshAlwaysOpen ? 'vops: keep-ssh-open (not closable)' : 'vops: keep-ssh-open';

  const inputChain = [
    `    type filter hook input priority 0; policy ${policy};`,
    '    ct state established,related accept',
    '    ct state invalid drop',
    '    iif "lo" accept',
    ...(pingWanted ? ['    ip protocol icmp accept', '    meta l4proto icmpv6 accept'] : []),
    ...(keepSshLine ? [`    tcp dport ${sshPort} accept comment "${sshComment}"`] : []),
    ...buildInboundLines(inbound).map((l) => `    ${renderInbound(l)}`),
  ];

  const outputChain = [
    `    type filter hook output priority 0; policy ${allowOutbound ? 'accept' : 'drop'};`,
    ...(allowOutbound ? [] : ['    ct state established,related accept', '    oif "lo" accept']),
  ];

  // Own ONLY our table — never `flush ruleset`, which would wipe Docker/fail2ban/ufw
  // and vops' own harden rate-limit table. The empty declare makes the delete
  // idempotent; the whole file applies atomically via `nft -f`. No forward hook:
  // routing / Docker / WireGuard are left untouched (this firewall governs host inbound).
  const ruleset = [
    '#!/usr/sbin/nft -f',
    '',
    `table inet ${TABLE}`,
    `delete table inet ${TABLE}`,
    '',
    `table inet ${TABLE} {`,
    '  chain input {',
    ...inputChain,
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
  const indented = renderNftables(rules, opts)
    .trimEnd()
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
    indented,
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

/** Does an inbound TCP rule already open `port` (exact, list member, or range)? */
function coversPort(r: VopsFirewallRule, port: number): boolean {
  if (r.protocol !== 'tcp' || !r.port) return false;
  const p = r.port.trim();
  const s = String(port);
  if (p === s) return true;
  if (/^\d+(?:,\d+)+$/.test(p)) return p.split(',').includes(s);
  const range = /^(\d+)-(\d+)$/.exec(p);
  if (range) return Number(range[1]) <= port && port <= Number(range[2]);
  return false;
}

function portExpr(port?: string): string {
  const trimmed = (port ?? '').trim();
  if (trimmed === '') return '0-65535'; // portless rule = all ports for the protocol
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (/^\d+-\d+$/.test(trimmed)) return trimmed;
  // comma list whose members are each a port or a range → nft set
  if (/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)+$/.test(trimmed)) return `{ ${trimmed.replaceAll(',', ', ')} }`;
  // Never fall back to 0-65535: a malformed spec must fail closed, not open everything.
  throw new Error(`Invalid port spec '${port}'. Use a port (8080), range (8000-8100), or list (80,443).`);
}
