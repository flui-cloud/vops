/** Pure helpers for `VopsAppsService` deploy/expose orchestration, kept out of the
 * service so it stays testable and under the file-size limit. */
import { BadRequestException } from '@nestjs/common';
import { AppAccessPlan, AppEndpoint, AppEnvPlain, AppIngressState, AppInstallV1, AppPlan, AppSecretPlan, APP_INSTALL_VERSION } from './app.model';
import { HostFacts, supportsPod } from './app-parse';
import { HostDeployPlan } from './app-plan';
import { SecretMaterial } from './app-scripts';
import { VopsHost } from '../hosts/host.model';

export function readiness(f: HostFacts): string[] {
  const issues: string[] = [];
  if (!f.podmanVersion) issues.push('podman is not installed. Run `vops app setup <host>` to install podman 5.');
  else if (!supportsPod(f.podmanVersion)) {
    issues.push(`podman ${f.podmanVersion} is too old (need ≥5.0 for pods). Run \`vops app setup <host>\` to install podman 5.`);
  }
  if (f.podmanVersion && !f.quadletGenerator) issues.push('the Quadlet systemd generator was not found on PATH.');
  return issues;
}

export function httpPrimary(plan: AppPlan): boolean {
  const primary = plan.components.find((c) => c.name === plan.primary);
  return !!primary?.ports.some((p) => p.expose && p.protocol === 'http');
}

/** Apply `--set NAME=value` onto matching value-secrets (by target) or plain env (by name). */
export function applyOverrides(plan: AppPlan, set: Record<string, string>): void {
  for (const comp of plan.components) {
    for (const s of comp.secrets) {
      if (s.target in set && !s.generate) s.value = set[s.target];
    }
    for (const e of comp.env) {
      if (e.name in set) e.value = set[e.name];
    }
  }
}

/** Drop unset optional secrets from every component before rendering units, so no `Secret=`
 * line points at a non-existent podman secret; matches by name to catch cross-injected refs too. */
export function pruneUnsetOptional(plan: AppPlan): void {
  const all = plan.components.flatMap((c) => c.secrets);
  const provided = new Set(all.filter((s) => s.generate || (s.value !== undefined && s.value !== '')).map((s) => s.name));
  const drop = new Set(all.filter((s) => s.optional && !provided.has(s.name)).map((s) => s.name));
  if (!drop.size) return;
  for (const comp of plan.components) comp.secrets = comp.secrets.filter((s) => !drop.has(s.name));
}

export function assertSecretsSatisfied(plan: AppPlan): void {
  const secrets = plan.components.flatMap((c) => c.secrets);
  const envs = plan.components.flatMap((c) => c.env);
  // A secret is satisfied if SOME component owns it (generate or a real value) —
  // cross-injected references (owned by another component) must not be flagged.
  // `optional`/`group` members are governed elsewhere (prune / the group check).
  const owned = new Set(secrets.filter((s) => s.generate || (s.value !== undefined && s.value !== '')).map((s) => s.name));
  const missingSecrets = secrets.filter((s) => !s.generate && !s.value && !s.optional && !owned.has(s.name));
  // `required` non-secret inputs (userInput required:true, not sensitive) must also
  // carry a value — they reach the plan as plain env, filled via `--set` / the form.
  const missingEnv = envs.filter((e) => e.required && !e.value);
  const targets = [...new Set([...missingSecrets.map((s) => s.target), ...missingEnv.map((e) => e.name)])];
  if (targets.length) {
    const flags = targets.map((t) => `--set ${t}=…`).join(' ');
    throw new BadRequestException(`Missing required inputs: pass ${flags}`);
  }
  assertGroupsSatisfied(secrets, envs);
}

/** Every userInput `group` needs at least one member with a value ("at least one of"). */
function assertGroupsSatisfied(secrets: AppSecretPlan[], envs: AppEnvPlain[]): void {
  const members = [
    ...secrets.flatMap((s) => (s.group ? [{ group: s.group, key: s.target, filled: !!s.value }] : [])),
    ...envs.flatMap((e) => (e.group ? [{ group: e.group, key: e.name, filled: !!e.value }] : [])),
  ];
  const groups = new Map<string, { keys: Set<string>; filled: boolean }>();
  for (const m of members) {
    const g = groups.get(m.group) ?? { keys: new Set<string>(), filled: false };
    g.keys.add(m.key);
    groups.set(m.group, { keys: g.keys, filled: g.filled || m.filled });
  }
  for (const [group, g] of groups) {
    if (g.filled) continue;
    const opts = [...g.keys].map((k) => `--set ${k}=…`).join(' | ');
    throw new BadRequestException(`Missing required input group "${group}": provide at least one of ${opts}`);
  }
}

export function toMaterial(s: { name: string; generate?: { length: number; format: 'base64url' | 'hex' }; value?: string }): SecretMaterial {
  return { name: s.name, generate: s.generate, value: s.value };
}

export function toInstall(plan: AppPlan, host: VopsHost, hp: HostDeployPlan, prev: AppInstallV1 | null): AppInstallV1 {
  const now = new Date().toISOString();
  return {
    version: APP_INSTALL_VERSION,
    name: plan.name,
    appId: plan.appId,
    displayName: plan.displayName,
    host: host.name,
    mode: plan.mode,
    kind: plan.kind,
    pod: hp.pod,
    primary: plan.primary,
    components: plan.components.map((c) => ({
      name: c.name,
      container: c.container,
      image: c.image,
      published: hp.ports[c.name] ?? [],
    })),
    units: hp.units,
    secrets: hp.secrets.map((s) => s.name),
    volumes: plan.components.flatMap((c) => c.volumes.map((v) => v.volume)),
    endpoints: hp.endpoints,
    ...(plan.access ? { access: plan.access } : {}),
    status: 'deployed',
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Display view of the resolved credentials: the login URL + parts (never a secret value). */
export interface AppAccessView extends AppAccessPlan {
  /** Login URL (endpoint or ingress host + path) — filled at deploy time. */
  url?: string;
}

/** Compose the login URL from the endpoint (or ingress host) + `access.path`. */
export function accessView(
  access: AppAccessPlan | undefined,
  endpoints: AppEndpoint[],
  primary: string,
  ingress?: { hostname: string; tls: boolean },
): AppAccessView | undefined {
  if (!access) return undefined;
  let base: string | undefined;
  if (ingress) {
    base = `${ingress.tls ? 'https' : 'http'}://${ingress.hostname}`;
  } else {
    base = (endpoints.find((e) => e.component === primary) ?? endpoints[0])?.url;
  }
  if (!base) return { ...access };
  const path = access.path === '/' ? '' : access.path;
  return { ...access, url: stripTrailingSlashes(base) + path };
}

function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

/** All host ports fronted by ingress: the root route plus any extra path routes. */
export function ingressHostPorts(ingress?: AppIngressState): number[] {
  if (!ingress) return [];
  return [ingress.hostPort, ...(ingress.routes ?? []).map((r) => r.hostPort)];
}

/** Flip PublishPort binds for the given host ports from loopback back to 0.0.0.0 across all units. */
export function flipBind(units: Record<string, string>, hostPorts: number[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(units).map(([name, content]) => [
      name,
      hostPorts.reduce((c, hp) => c.replace(`PublishPort=127.0.0.1:${hp}:`, `PublishPort=0.0.0.0:${hp}:`), content),
    ]),
  );
}

/** Endpoint URLs are rendered from the TLS the deploy *asked* for; once the route is attached,
 * `ingress.tls` is what the host actually serves. Advertising `https://` on an app left on plain
 * HTTP hands every reader — user, agent, dashboard — a URL that does not answer. */
export function applyIngressScheme(endpoints: AppEndpoint[], ingress: AppIngressState): AppEndpoint[] {
  const served = ingress.tls ? 'https://' : 'http://';
  const stale = ingress.tls ? 'http://' : 'https://';
  return endpoints.map((e) =>
    e.reach === 'ingress' && e.url.startsWith(stale) ? { ...e, url: served + e.url.slice(stale.length) } : e,
  );
}

/** After unexpose the routed endpoints revert from `https://<fqdn>` to direct URLs —
 * on the public address when the install is `--public`, else the honest loopback URL. */
export function rebindEndpoints(install: AppInstallV1, hostAddress: string, reach: 'public' | 'loopback'): AppEndpoint[] {
  const routed = new Set(ingressHostPorts(install.ingress));
  return install.endpoints.map((e) =>
    routed.has(e.port) ? { component: e.component, port: e.port, url: `http://${hostAddress}:${e.port}`, reach } : e,
  );
}
