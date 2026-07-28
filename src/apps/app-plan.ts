import { AppEndpoint, AppPlan, AppPortPlan, AppSecretPlan, IngressBinding, IngressRoute, PublishedPort } from './app.model';
import { APP_DOMAIN_TOKEN } from './spec-normalize';
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
  secrets: AppSecretPlan[];
  /** Container `.service` names in dependency (start) order. */
  services: string[];
  /** Volume + pod `.service` names, started before the containers. */
  prereqServices: string[];
  pod?: string;
  endpoints: AppEndpoint[];
}

const PUBLISH_BIND = '0.0.0.0';
const LOOPBACK_BIND = '127.0.0.1';

/** Raw-port exposure intent. `loopback` (default) = reachable only from the host
 * (ingress in the host netns, or an SSH tunnel); `public` = bound on 0.0.0.0. */
export type PublishIntent = 'loopback' | 'public';

export function planHostDeploy(
  plan: AppPlan,
  facts: HostFacts,
  hostAddress: string,
  ingress?: IngressBinding,
  publish: PublishIntent = 'loopback',
): HostDeployPlan {
  const coexistence = facts.k3s;
  const used = new Set(facts.listeningPorts);
  if (ingress) {
    // Traefik (host network) owns 80/443 — never let an app land on them.
    used.add(80);
    used.add(443);
    substituteAppDomain(plan, ingress.hostname);
  }
  const ports: Record<string, PublishedPort[]> = {};
  const endpoints: AppEndpoint[] = [];

  for (const comp of plan.components) {
    const published: PublishedPort[] = [];
    for (const p of comp.ports) {
      if (!p.expose) continue;
      const bound = bindExposedPort(comp.name, p, { used, coexistence, hostAddress, ingress, publish });
      published.push(bound.published);
      endpoints.push(bound.endpoint);
    }
    ports[comp.name] = published;
  }

  const ctx: RenderContext = { selinux: facts.selinux, ports };
  const { units, secrets, pod } = renderDeploy(plan, ctx);
  const volumes = plan.components.flatMap((c) => c.volumes.map((v) => v.volume));

  return {
    unitDir: appUnitDir(plan.name),
    coexistence,
    ports,
    units,
    secrets,
    services: orderServices(plan),
    prereqServices: prereqServiceNames(pod, volumes),
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
}

/** Resolve one exposed port to a published binding + endpoint. Binds 0.0.0.0 only when public
 * or `exposeDirect`; every other port — including a bare deploy — binds 127.0.0.1, never the internet. */
function bindExposedPort(component: string, p: AppPortPlan, ctx: BindCtx): { published: PublishedPort; endpoint: AppEndpoint } {
  const route = routeFor(component, p, ctx.ingress);
  const routed = route != null;
  const host = allocatePort(p.container, ctx.used, ctx.coexistence, routed);
  const direct = routed && !!ctx.ingress?.exposeDirect;
  const isPublic = ctx.publish === 'public' || direct;
  const reach: AppEndpoint['reach'] = reachFor(routed, isPublic);
  return {
    published: { host, container: p.container, bind: isPublic ? PUBLISH_BIND : LOOPBACK_BIND },
    endpoint: { component, port: host, url: endpointUrl(route, p, host, ctx, isPublic), reach },
  };
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

/** Substitute `{{app.domain}}` in every env value with the resolved hostname. */
function substituteAppDomain(plan: AppPlan, hostname: string): void {
  for (const comp of plan.components) {
    for (const e of comp.env) {
      e.value = e.value.replace(APP_DOMAIN_TOKEN, hostname);
      APP_DOMAIN_TOKEN.lastIndex = 0;
    }
  }
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
