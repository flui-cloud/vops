/** Pure helpers for ingress hostname resolution: sslip.io zero-config default, FQDN validation
 * (defends the Traefik rule + YAML from injection), routed ports, and DNS-zone matching. */
import { AppPlan } from './app.model';
import { sanitize } from './spec-normalize';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// A conservative FQDN: 1–63-char LDH labels, ≥2 labels, TLD is alphabetic.
const FQDN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** `1.2.3.4` → `1-2-3-4.sslip.io`, or `<name>.1-2-3-4.sslip.io` with an install name — the
 * prefix lets two apps auto-domain on the SAME host without colliding on the root ('/') route. */
export function sslipHostname(ip: string, installName?: string): string {
  const m = IPV4.exec(ip.trim());
  if (!m || m.slice(1).some((o) => Number.parseInt(o, 10) > 255)) {
    throw new Error(`Cannot derive an sslip.io hostname from '${ip}' (need an IPv4 address).`);
  }
  const base = `${m.slice(1).join('-')}.sslip.io`;
  return installName ? `${sanitize(installName)}.${base}` : base;
}

export function isSslip(hostname: string): boolean {
  return /\.sslip\.io$/i.test(hostname) || /\.nip\.io$/i.test(hostname);
}

export function isValidFqdn(s: string): boolean {
  return FQDN.test(s);
}

export function assertValidHostname(s: string): string {
  const h = s.trim().toLowerCase();
  if (!isValidFqdn(h)) throw new Error(`Invalid domain '${s}'. Expected a hostname like app.example.com.`);
  return h;
}

/** One HTTP endpoint the ingress fronts: a component's container port at a path. */
export interface RoutePort {
  component: string;
  containerPort: number;
  /** `/` for the root route. */
  path: string;
  stripPrefix: boolean;
}

/** Every HTTP port the ingress fronts: the primary's root (`/`) plus any exposed HTTP port with
 * an explicit `route`. A secondary port WITHOUT a route stays direct-published, so single-endpoint apps are unchanged. */
export function routedPorts(plan: AppPlan): RoutePort[] {
  const primary = plan.components.find((c) => c.name === plan.primary);
  const primaryHttp = primary?.ports.find((p) => p.expose && p.protocol === 'http');

  const routes: RoutePort[] = [];
  for (const comp of plan.components) {
    for (const p of comp.ports) {
      const fronted = p.expose && p.protocol === 'http' && (p.route != null || (comp === primary && p === primaryHttp));
      if (!fronted) continue;
      routes.push({ component: comp.name, containerPort: p.container, path: p.route?.path ?? '/', stripPrefix: p.route?.stripPrefix ?? false });
    }
  }
  assertUniqueRoutes(plan.name, routes);
  return routes;
}

function assertUniqueRoutes(app: string, routes: RoutePort[]): void {
  const seen = new Set<string>();
  let roots = 0;
  for (const r of routes) {
    if (seen.has(r.path)) throw new Error(`App '${app}' has two ingress routes at '${r.path}'.`);
    seen.add(r.path);
    if (r.path === '/') roots += 1;
  }
  if (roots > 1) throw new Error(`App '${app}' declares more than one root ('/') ingress route.`);
}

/** Longest-suffix match of `fqdn` against a set of zone names (the zone that owns it). */
export function pickZone<T extends { name: string }>(zones: T[], fqdn: string): T | null {
  const host = fqdn.replace(/\.$/, '').toLowerCase();
  let best: T | null = null;
  for (const z of zones) {
    const zone = z.name.replace(/\.$/, '').toLowerCase();
    const owns = host === zone || host.endsWith(`.${zone}`);
    if (owns && (!best || zone.length > best.name.replace(/\.$/, '').length)) best = z;
  }
  return best;
}

/** The record name of `fqdn` relative to `zoneName` (`@` for the apex). */
export function recordName(fqdn: string, zoneName: string): string {
  const host = fqdn.replace(/\.$/, '').toLowerCase();
  const zone = zoneName.replace(/\.$/, '').toLowerCase();
  if (host === zone) return '@';
  return host.slice(0, host.length - zone.length - 1);
}
