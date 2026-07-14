import { VopsFirewallRule } from '../dto/firewall.dto';
import { hasNativeFirewall, resolveProvider } from '../lib/providers';

/**
 * The simple, non-devops-facing firewall model: a list of named services (a port
 * + where it's allowed from). It compiles to the portable `VopsFirewallRule` shape
 * both engines already speak (provider-native and host nftables), and back — so the
 * CLI and the dashboard render the exact same toggles over either engine.
 */
export interface FirewallService {
  /** Well-known key ('ssh'|'http'|'https') or a stable 'port-<proto>-<port>'. */
  id: string;
  label: string;
  protocol: 'tcp' | 'udp';
  port: string;
  enabled: boolean;
  /** Allowed source CIDRs; empty = from anywhere. */
  sources: string[];
}

interface WellKnown {
  id: string;
  label: string;
  protocol: 'tcp' | 'udp';
  port: string;
}

export const WELL_KNOWN_SERVICES: readonly WellKnown[] = [
  { id: 'ssh', label: 'SSH', protocol: 'tcp', port: '22' },
  { id: 'http', label: 'Web (HTTP)', protocol: 'tcp', port: '80' },
  { id: 'https', label: 'Web (HTTPS)', protocol: 'tcp', port: '443' },
];

const KNOWN_BY_PORT = new Map(WELL_KNOWN_SERVICES.map((s) => [`${s.protocol}:${s.port}`, s]));

/** Enabled services → portable inbound firewall rules. */
export function servicesToRules(services: FirewallService[]): VopsFirewallRule[] {
  return services
    .filter((s) => s.enabled)
    .map((s) => ({
      description: s.label,
      direction: 'in' as const,
      protocol: s.protocol,
      port: s.port,
      ...(s.sources.length ? { sourceIps: s.sources } : {}),
    }));
}

const PORT_SPEC = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;
const V4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const V6_CIDR = /^[0-9a-fA-F:]+(?:\/(\d{1,3}))?$/;

function portOk(port: string): boolean {
  return PORT_SPEC.test(port) && port.split(/[,-]/).every((n) => Number(n) >= 1 && Number(n) <= 65535);
}
function cidrOk(src: string): boolean {
  const s = src.trim();
  const m4 = V4_CIDR.exec(s);
  if (m4) return m4.slice(1, 5).every((o) => Number(o) <= 255) && (m4[5] === undefined || Number(m4[5]) <= 32);
  const m6 = V6_CIDR.exec(s);
  return !!m6 && s.includes(':') && (m6[1] === undefined || Number(m6[1]) <= 128);
}

/**
 * Validate the enabled services BEFORE they reach an engine — a legal, bounded port
 * and CIDR-shaped sources. Fails closed on an empty/garbage port (which the renderer
 * would otherwise widen to 0-65535) and rejects newline-bearing sources that could
 * break out of the delivery heredoc. Returns the first problem, or null.
 */
export function firstServiceError(services: FirewallService[]): string | null {
  for (const s of services) {
    if (!s.enabled) continue;
    if (!portOk((s.port ?? '').trim())) return `Invalid port '${s.port}' for ${s.label} — use 8080, 8000-8100 or 80,443 (1-65535).`;
    for (const src of s.sources ?? []) {
      if (!cidrOk(src)) return `Invalid source '${src}' for ${s.label} — use a CIDR like 203.0.113.4/32.`;
    }
  }
  return null;
}

/** A rule the simple-service model can represent (inbound tcp/udp with a port). */
export function isServiceRule(r: VopsFirewallRule): boolean {
  return r.direction === 'in' && (r.protocol === 'tcp' || r.protocol === 'udp') && !!r.port;
}

/** Does any tcp rule allow `port` (exact, comma-list member, or range)? */
export function rulesAllowPort(rules: VopsFirewallRule[], port: number): boolean {
  const target = String(port);
  return rules.some((r) => r.protocol === 'tcp' && !!r.port && r.port.split(',').some((part) => {
    const p = part.trim();
    if (p === target) return true;
    const m = /^(\d+)-(\d+)$/.exec(p);
    return !!m && Number(m[1]) <= port && port <= Number(m[2]);
  }));
}

/** Inbound rules → simple service list, deduped by proto:port (well-known named, else "Port N"). */
export function rulesToServices(rules: VopsFirewallRule[]): FirewallService[] {
  const byKey = new Map<string, FirewallService>();
  for (const r of rules.filter(isServiceRule)) {
    const proto = r.protocol as 'tcp' | 'udp';
    const port = r.port;
    const key = `${proto}:${port}`;
    if (byKey.has(key)) continue; // one row per service; first rule wins
    const known = KNOWN_BY_PORT.get(key);
    byKey.set(key, {
      id: known?.id ?? `port-${proto}-${port}`,
      label: known?.label ?? `Port ${port}`,
      protocol: proto,
      port,
      enabled: true,
      sources: r.sourceIps ?? [],
    });
  }
  return [...byKey.values()];
}

/**
 * Parse one CLI service token into a FirewallService. Forms:
 *   ssh | http | https            well-known name
 *   8080 | 8080/tcp | 51820/udp   raw port (tcp default)
 *   …@203.0.113.0/24              restrict the source (appended with '@')
 */
export function parseServiceSpec(token: string): FirewallService {
  const [portPart, source] = token.trim().split('@');
  const sources = source ? [source] : [];
  const known = WELL_KNOWN_SERVICES.find((s) => s.id === portPart.toLowerCase());
  if (known) return { ...known, enabled: true, sources };
  const [port, proto] = portPart.split('/');
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(port)) throw new Error(`Bad service '${token}'. Use a name (ssh/http/https) or a port like 8080, 8000-8100 or 51820/udp.`);
  const protocol = proto === 'udp' ? 'udp' : 'tcp';
  return { id: `port-${protocol}-${port}`, label: `Port ${port}`, protocol, port, enabled: true, sources };
}

/**
 * The operator's IP as the HOST sees it — first field of `$SSH_CONNECTION`
 * ("<client-ip> <client-port> <server-ip> <server-port>"). Offline: the server
 * reports it, no external IP-echo service, keeping vops local-first / no-telemetry.
 */
export function parseClientIp(sshConnection: string): string | null {
  const first = sshConnection.trim().split(/\s+/)[0] ?? '';
  return first.length > 0 && /^[0-9a-fA-F:.]+$/.test(first) ? first : null;
}

/** Which firewall engine manages a given host. */
export type FirewallEngine = 'provider' | 'nftables' | 'none';

function providerHasNativeFirewall(name: string): boolean {
  try {
    return hasNativeFirewall(resolveProvider(name));
  } catch {
    return false;
  }
}

/**
 * Provider-native where the provider offers one for free (Hetzner, Scaleway);
 * otherwise vops' own nftables over SSH (Contabo, OVH, BYOS). 'none' only when a
 * host has no native firewall AND is provider-only (no SSH to manage nftables).
 */
export function resolveFirewallEngine(host: { provider?: string; sshManaged?: boolean }): FirewallEngine {
  if (host.provider && providerHasNativeFirewall(host.provider)) return 'provider';
  if (host.sshManaged !== false) return 'nftables';
  return 'none';
}
