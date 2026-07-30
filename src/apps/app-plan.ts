import { AppEndpoint, AppPlan, AppPortPlan, AppSecretPlan, IngressBinding, IngressRoute, PublishedPort } from './app.model';
import { APP_DOMAIN_URL_TOKEN, APP_SCHEME_TOKEN } from './spec-normalize';
import { HostFacts, allocatePort } from './app-parse';
import { RenderContext, renderDeploy } from './quadlet-render';
import { appUnitDir, prereqServiceNames } from './app-scripts';

/** Pure host-binding step (Podman 5+ / `.pod`): AppPlan + live host facts → ports, units,
 * ordered services, endpoints. Composed apps share one pod, so only port allocation is needed here. */
export interface HostDeployPlan {
  unitDir: string;
  coexistence: boolean;
  ports: Record<string, PublishedPort[]>;
  units: Record<string, string>;
  /** Health timer/service pairs for `SYSTEM_UNIT_DIR` (podman-static schedules none itself). */
  healthUnits: Record<string, string>;
  secrets: AppSecretPlan[];
  /** Container `.service` names in dependency (start) order. */
  services: string[];
  /** Volume + pod `.service` names, started before the containers. */
  prereqServices: string[];
  /** Podman named volumes this deploy needs (created by the `.volume` units). */
  volumes: string[];
  pod?: string;
  endpoints: AppEndpoint[];
}

const PUBLISH_BIND = '0.0.0.0';
const LOOPBACK_BIND = '127.0.0.1';

/** Raw-port exposure intent. `loopback` (default) = reachable only from the host
 * (ingress in the host netns, or an SSH tunnel); `public` = bound on 0.0.0.0. */
export type PublishIntent = 'loopback' | 'public';

/** Host ports the install ledger — not the live `ss` scan — already accounts for. An app owns
 * its ports until it is removed: a stopped app listens on nothing, so the scan alone would both
 * reallocate its own port on redeploy and hand it to the next app. */
export interface PortReservations {
  /** This app's ports from its previous install, by component name — reused as they are. */
  own: Record<string, PublishedPort[]>;
  /** Host ports registered by the OTHER installs on this host, running or not. */
  others: number[];
}

export function planHostDeploy(
  plan: AppPlan,
  facts: HostFacts,
  hostAddress: string,
  ingress?: IngressBinding,
  publish: PublishIntent = 'loopback',
  reservations?: PortReservations,
): HostDeployPlan {
  const coexistence = facts.k3s;
  const used = new Set(facts.listeningPorts);
  const own = ownPorts(reservations?.own);
  for (const p of [...own.values(), ...(reservations?.others ?? [])]) used.add(p);
  if (ingress) {
    // Traefik (host network) owns 80/443 — never let an app land on them.
    used.add(80);
    used.add(443);
  }
  const ports: Record<string, PublishedPort[]> = {};
  const endpoints: AppEndpoint[] = [];

  for (const comp of plan.components) {
    const published: PublishedPort[] = [];
    for (const p of comp.ports) {
      if (!p.expose) continue;
      const bound = bindExposedPort(comp.name, p, { used, coexistence, hostAddress, ingress, publish, own });
      published.push(bound.published);
      endpoints.push(bound.endpoint);
    }
    ports[comp.name] = published;
  }

  // After allocation: without a domain the token resolves to the port the app just got.
  substituteAppDomain(plan, ingress, ports);

  const ctx: RenderContext = { selinux: facts.selinux, ports };
  const { units, healthUnits, secrets, pod } = renderDeploy(plan, ctx);
  const volumes = plan.components.flatMap((c) => c.volumes.map((v) => v.volume));

  return {
    unitDir: appUnitDir(plan.name),
    coexistence,
    ports,
    units,
    healthUnits,
    secrets,
    services: orderServices(plan),
    prereqServices: prereqServiceNames(pod, volumes),
    volumes,
    pod,
    endpoints,
  };
}

interface BindCtx {
  used: Set<number>;
  coexistence: boolean;
  hostAddress: string;
  ingress?: IngressBinding;
  publish: PublishIntent;
  /** `portKey(component, containerPort)` → the host port this app already holds. */
  own: Map<string, number>;
}

/** Resolve one exposed port to a published binding + endpoint. Binds 0.0.0.0 only when public
 * or `exposeDirect`; every other port — including a bare deploy — binds 127.0.0.1, never the internet. */
function bindExposedPort(component: string, p: AppPortPlan, ctx: BindCtx): { published: PublishedPort; endpoint: AppEndpoint } {
  const route = routeFor(component, p, ctx.ingress);
  const routed = route != null;
  const host = keptPort(component, p, ctx) ?? allocatePort(p.container, ctx.used, ctx.coexistence, routed);
  const direct = routed && !!ctx.ingress?.exposeDirect;
  const isPublic = ctx.publish === 'public' || direct;
  const reach: AppEndpoint['reach'] = reachFor(routed, isPublic);
  return {
    published: { host, container: p.container, bind: isPublic ? PUBLISH_BIND : LOOPBACK_BIND },
    endpoint: { component, port: host, url: endpointUrl(route, p, host, ctx, isPublic), reach },
  };
}

/** The port this app already published for `component:containerPort`, unless the current shape
 * forbids it: 80/443 belong to the ingress, and a k3s host keeps everything above 1024. */
function keptPort(component: string, p: AppPortPlan, ctx: BindCtx): number | undefined {
  const port = ctx.own.get(portKey(component, p.container));
  if (port == null) return undefined;
  if (ctx.ingress && (port === 80 || port === 443)) return undefined;
  if (ctx.coexistence && port < 1024) return undefined;
  return port;
}

function ownPorts(previous?: Record<string, PublishedPort[]>): Map<string, number> {
  return new Map(
    Object.entries(previous ?? {}).flatMap(([component, ports]) =>
      ports.map((p) => [portKey(component, p.container), p.host] as const),
    ),
  );
}

function portKey(component: string, containerPort: number): string {
  return `${component}#${containerPort}`;
}

function reachFor(routed: boolean, isPublic: boolean): AppEndpoint['reach'] {
  if (routed) return 'ingress';
  return isPublic ? 'public' : 'loopback';
}

/** The ingress route (if any) that fronts this component's port. */
function routeFor(component: string, p: AppPortPlan, ingress?: IngressBinding): IngressRoute | undefined {
  return ingress?.routes.find((r) => r.component === component && r.containerPort === p.container);
}

function endpointUrl(route: IngressRoute | undefined, p: AppPortPlan, host: number, ctx: BindCtx, isPublic: boolean): string {
  if (route && ctx.ingress) {
    const scheme = ctx.ingress.tls ? 'https' : 'http';
    const path = route.path === '/' ? '' : route.path;
    return `${scheme}://${ctx.ingress.hostname}${path}`;
  }
  const scheme = p.protocol === 'http' ? 'http' : 'tcp';
  // A loopback-bound port does not answer on the host's public address — advertise
  // the honest 127.0.0.1 URL (reachable via `vops app tunnel` / `ssh -L`).
  return `${scheme}://${isPublic ? ctx.hostAddress : LOOPBACK_BIND}:${host}`;
}

/** Resolve `{{app.domain}}` / `{{app.scheme}}` in every env value against the origin the app is
 * really served on: the routed hostname behind an ingress, the primary's loopback `host:port`
 * without one. A scheme a manifest wrote in front of the token (`https://{{app.domain}}`) is
 * REPLACED by that origin's scheme, never kept — on `--no-tls`, or with no domain at all, keeping
 * it bakes in a URL claiming a TLS origin nothing answers on. */
function substituteAppDomain(plan: AppPlan, ingress: IngressBinding | undefined, ports: Record<string, PublishedPort[]>): void {
  const scheme = ingress?.tls ? 'https' : 'http';
  const authority = ingress ? ingress.hostname : loopbackAuthority(plan, ports);
  for (const comp of plan.components) {
    for (const e of comp.env) {
      e.value = e.value
        .replaceAll(APP_DOMAIN_URL_TOKEN, (_m: string, written?: string) => (written ? `${scheme}://${authority}` : authority))
        .replaceAll(APP_SCHEME_TOKEN, scheme);
    }
  }
  if (!ingress && plan.needsAppDomain) {
    plan.warnings = [
      ...(plan.warnings ?? []),
      `No --domain given → ${plan.name} is configured for http://${authority} (loopback only). Run \`vops app expose ${plan.name} --domain <host>\` to give it a public hostname.`,
    ];
  }
}

/** Where a domain-less install actually answers: the primary's published HTTP port on loopback. */
function loopbackAuthority(plan: AppPlan, ports: Record<string, PublishedPort[]>): string {
  const primary = plan.components.find((c) => c.name === plan.primary);
  const http = primary?.ports.find((p) => p.expose && p.protocol === 'http');
  const published = ports[plan.primary] ?? [];
  const pub = published.find((p) => p.container === http?.container) ?? published[0];
  return pub ? `${LOOPBACK_BIND}:${pub.host}` : LOOPBACK_BIND;
}

/** Topological start order over `dependsOn` (deps first). Small N → simple Kahn. */
function orderServices(plan: AppPlan): string[] {
  const remaining = new Map(plan.components.map((c) => [c.name, new Set(c.dependsOn)]));
  const order: string[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every((d) => !remaining.has(d)));
    const batch = (ready.length ? ready : [...remaining.entries()]).map(([name]) => name);
    for (const name of batch) remaining.delete(name);
    order.push(...batch);
  }
  return order.map((name) => `${plan.components.find((c) => c.name === name).container}.service`);
}
