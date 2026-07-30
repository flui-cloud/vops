import { splitSections } from '../host-ops/status-battery';

/** Host facts gathered by the preflight probe (pure parse of its `@@` sections). */
export interface HostFacts {
  /** Podman version string (e.g. '5.4.2') or null when not installed. */
  podmanVersion: string | null;
  quadletGenerator: string | null;
  /** k3s active → coexistence mode (no firewall writes, no ports <1024). */
  k3s: boolean;
  selinux: boolean;
  arch: string;
  listeningPorts: Set<number>;
  freeKb: number;
  networks: string[];
}

export function parsePreflight(stdout: string): HostFacts {
  const s = splitSections(stdout);
  const podmanRaw = (s.podman ?? '').trim();
  return {
    podmanVersion: podmanRaw && podmanRaw !== 'MISSING' ? extractVersion(podmanRaw) : null,
    quadletGenerator: (s.quadlet ?? '').trim() || null,
    k3s: (s.k3s ?? '').trim() === 'active',
    selinux: (s.selinux ?? '').trim() === 'yes',
    arch: (s.arch ?? '').trim(),
    listeningPorts: parsePorts(s.ports ?? ''),
    freeKb: Number.parseInt((s.diskkb ?? '').trim(), 10) || 0,
    networks: (s.networks ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
  };
}

function extractVersion(raw: string): string | null {
  const m = /(\d{1,4}\.\d{1,4}\.\d{1,4})/.exec(raw);
  return m ? m[1] : null;
}

export function parsePorts(text: string): Set<number> {
  const out = new Set<number>();
  for (const line of text.split('\n')) {
    const addr = line.trim();
    if (!addr) continue;
    const idx = addr.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number.parseInt(addr.slice(idx + 1), 10);
    if (Number.isFinite(port) && port > 0) out.add(port);
  }
  return out;
}

/** True when the Podman version supports Quadlet pods (`.pod` floor, ≥5.0). */
export function supportsPod(version: string | null): boolean {
  if (!version) return false;
  const maj = Number.parseInt(version.split('.')[0], 10);
  return maj >= 5;
}

/** Images the host could neither find locally nor pull. An empty `@@pull` section (the script
 * never ran, e.g. an SSH timeout) is not "everything pulled" — the caller checks `ran`. */
export function parsePullOutput(stdout: string): { ran: boolean; failed: string[] } {
  const s = splitSections(stdout);
  const lines = (s.pull ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    ran: 'pull' in s && 'done' in s,
    failed: lines.filter((l) => l.startsWith('failed ')).map((l) => l.slice('failed '.length)),
  };
}

export interface DeployOutcome {
  ok: boolean;
  started: Record<string, string>;
  error?: string;
}

export function parseDeployOutput(stdout: string, services: string[]): DeployOutcome {
  const s = splitSections(stdout);
  if ('error' in s) return { ok: false, started: {}, error: (s.error || 'unknown error').trim() };
  const started: Record<string, string> = {};
  for (const line of (s.started ?? '').split('\n')) {
    const eq = line.lastIndexOf('=');
    if (eq > 0) started[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  const bad = services.filter((sv) => started[sv] !== 'active');
  if (!('ok' in s) || bad.length) {
    const which = bad.join(', ') || 'deploy aborted';
    const diag = (s.diag ?? '').trim();
    const error = diag ? `services not active: ${which}\n${diag}` : `services not active: ${which}`;
    return { ok: false, started, error };
  }
  return { ok: true, started };
}

export interface SmokeOutcome {
  ok: boolean;
  detail: string;
}

export function parseHttpSmoke(stdout: string, expect: number, port?: number): SmokeOutcome {
  const raw = (splitSections(stdout).http ?? '').trim();
  const code = Number.parseInt(raw, 10) || 0;
  // App is serving = expected status, or any 2xx/3xx. 000 (no response) / 5xx (error) fail.
  const ok = code === expect || (code >= 200 && code < 400);
  return { ok, detail: `HTTP ${raw || '000'}${probed(port)} (want ${expect} or 2xx/3xx)` };
}

export function parseTcpSmoke(stdout: string, port?: number): SmokeOutcome {
  const state = (splitSections(stdout).tcp ?? '').trim();
  return { ok: state === 'open', detail: `TCP ${state || 'closed'}${probed(port)}` };
}

/** Name the port the probe actually used: a bare `HTTP 000` cannot be told apart from
 * an app answering fine on a port the deploy no longer binds. */
function probed(port?: number): string {
  return port == null ? '' : ` on 127.0.0.1:${port}`;
}

export interface UnitStatus {
  service: string;
  active: string;
  sub: string;
}

export function parseStatusOutput(stdout: string): { units: UnitStatus[]; containers: string[] } {
  const s = splitSections(stdout);
  const units = (s.units ?? '')
    .split('\n')
    .map((l) => l.split('|'))
    .filter((p) => p[0])
    .map(([service, active, sub]) => ({ service, active: active ?? '', sub: sub ?? '' }));
  const containers = (s.containers ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return { units, containers };
}

export interface IngressPrecheck {
  /** vops-ingress.service is already active (re-configure, don't refuse on ports). */
  active: boolean;
  /** The vops-ingress Quadlet unit file exists. */
  unitPresent: boolean;
  /** Process holding :80 / :443, or null when free. */
  port80: string | null;
  port443: string | null;
  podmanVersion: string | null;
  arch: string;
  selinux: boolean;
}

export function parseIngressPrecheck(stdout: string): IngressPrecheck {
  const s = splitSections(stdout);
  const podmanRaw = (s.podman ?? '').trim();
  return {
    active: (s.active ?? '').trim() === 'active',
    unitPresent: (s.unit ?? '').trim() === 'present',
    port80: portOwner(s.listen ?? '', 80),
    port443: portOwner(s.listen ?? '', 443),
    podmanVersion: podmanRaw && podmanRaw !== 'MISSING' ? extractVersion(podmanRaw) : null,
    arch: (s.arch ?? '').trim(),
    selinux: (s.selinux ?? '').trim() === 'yes',
  };
}

/** Find the process name bound to `port` in `ss -ltnp` output, or null if free. */
export function portOwner(listen: string, port: number): string | null {
  for (const line of listen.split('\n')) {
    const [addr, users] = line.split('\t');
    if (!addr) continue;
    const colon = addr.trim().lastIndexOf(':');
    if (colon < 0) continue;
    if (Number.parseInt(addr.trim().slice(colon + 1), 10) !== port) continue;
    const proc = /"([^"]+)"/.exec(users ?? '');
    return proc ? proc[1] : 'unknown';
  }
  return null;
}

export interface IngressInstallOutcome {
  ok: boolean;
  active: boolean;
  health: boolean;
  pull: string;
  diag: string;
}

export function parseIngressInstall(stdout: string): IngressInstallOutcome {
  const s = splitSections(stdout);
  const active = (s.active ?? '').trim() === 'active';
  const health = (s.health ?? '').trim().split('\n').includes('ok');
  return {
    ok: active && health,
    active,
    health,
    pull: (s.pull ?? '').trim(),
    diag: (s.diag ?? '').trim(),
  };
}

export interface IngressStatusInfo {
  active: boolean;
  container: string | null;
  health: number;
  routes: string[];
}

export function parseIngressStatus(stdout: string): IngressStatusInfo {
  const s = splitSections(stdout);
  return {
    active: (s.active ?? '').trim() === 'active',
    container: (s.container ?? '').trim() || null,
    health: Number.parseInt((s.health ?? '').trim(), 10) || 0,
    routes: (s.routes ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
  };
}

export interface CertProbe {
  /** A certificate for the hostname is present in acme.json. */
  issued: boolean;
  /** A definitive ACME failure line (rate-limit / CAA / validation), or null. */
  hardError: string | null;
  log: string;
}

// ACME failures that will never succeed as-is, worth aborting the poll for. Deliberately not
// `rate ?limit` — that also matches Caddy's benign self-throttle retry, which succeeds.
const HARD_ACME =
  /rate ?limited|too many certificates|too many failed authoriz|caa record|no valid a records|dns problem|invalid response|:unauthorized|acme: error|urn:ietf:params:acme:error|could not obtain|unable to obtain/i;

export function parseCertProbe(stdout: string): CertProbe {
  const s = splitSections(stdout);
  const log = (s.log ?? '').trim();
  const hardError = log.split('\n').find((l) => HARD_ACME.test(l)) ?? null;
  return { issued: !!(s.acme ?? '').trim(), hardError, log };
}

const ALLOC_BASE = 20000;
const ALLOC_TOP = 20999;

/** Reuses the container port when free/allowed, else allocates from a high range clear of k3s's
 * NodePort band; `forceHigh` forces this for loopback/ingress backends, which must never sit on 80/443. */
export function allocatePort(containerPort: number, used: Set<number>, coexistence: boolean, forceHigh = false): number {
  const preferOk = !forceHigh && containerPort >= (coexistence ? 1024 : 1) && !used.has(containerPort);
  if (preferOk) {
    used.add(containerPort);
    return containerPort;
  }
  for (let p = ALLOC_BASE; p <= ALLOC_TOP; p += 1) {
    if (!used.has(p)) {
      used.add(p);
      return p;
    }
  }
  throw new Error('No free host port available in the allocation range.');
}
