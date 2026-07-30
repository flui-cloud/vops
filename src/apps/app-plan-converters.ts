import type {
  CatalogComponent,
  CatalogDomainSpec,
  CatalogHealthcheck,
  CatalogImageSource,
  CatalogPort,
  CatalogPortRoute,
  CatalogResources,
  CatalogSmokeTest,
  CatalogSpecStandalone,
  CatalogVolume,
} from '@flui-cloud/spec';
import { AppDomainPlan, AppHealthPlan, AppPortPlan, AppVolumePlan, PortRoutePlan, SmokeTestPlan } from './app.model';
import { NormalizeError, cpuToPodman, memToPodman, normalizeRoutePath, sanitize } from './spec-normalize';

export function imageRef(img: CatalogImageSource): string {
  const registry = img.registry ?? 'docker.io';
  const repo = img.repository ?? '';
  const tag = img.tag ?? 'latest';
  if (!repo) throw new NormalizeError('Component image has no repository.');
  return `${registry}/${repo}:${tag}`;
}

export function toPort(p: CatalogPort): AppPortPlan {
  const protocol = p.protocol ?? 'tcp';
  if (p.route && protocol !== 'http') {
    throw new NormalizeError(`Port '${p.name}' declares a route but is not an HTTP port.`);
  }
  return {
    name: p.name,
    container: p.internal,
    expose: !!p.expose,
    protocol,
    ...(p.route ? { route: toRoute(p.name, p.route) } : {}),
  };
}

function toRoute(portName: string, r: CatalogPortRoute): PortRoutePlan {
  if (r.subdomain) {
    throw new NormalizeError(`Port '${portName}': subdomain routing is not yet supported — use route.path (e.g. /api).`);
  }
  return { path: normalizeRoutePath(r.path), stripPrefix: !!r.stripPrefix };
}

export function toVolume(app: string, logical: string, v: CatalogVolume): AppVolumePlan {
  return { name: v.name, volume: `vops-${app}-${logical}-${sanitize(v.name)}`, mountPath: v.mountPath, size: v.size };
}

export function resourceLimits(r?: CatalogResources): { cpu?: string; memory?: string } {
  const lim = r?.limits;
  return { cpu: cpuToPodman(lim?.cpu), memory: memToPodman(lim?.memory) };
}

export function toHealth(h?: CatalogHealthcheck): AppHealthPlan | undefined {
  if (!h) return undefined;
  return {
    type: h.type,
    path: h.path,
    port: h.port,
    command: h.command,
    httpHeaders: h.httpHeaders,
    initialDelay: h.initialDelay,
    interval: h.interval,
    timeout: h.timeout,
    retries: h.retries,
  };
}

export function toSmokeTest(s?: CatalogSmokeTest): SmokeTestPlan | undefined {
  if (!s) return undefined;
  if (s.type === 'http') {
    return { type: 'http', path: s.path, expectedStatus: s.expectedStatus, timeoutSeconds: s.timeoutSeconds, retries: s.retries };
  }
  if (s.type === 'tcp') return { type: 'tcp', port: s.port, timeoutSeconds: s.timeoutSeconds };
  if (s.type === 'script') return { type: 'script', inline: s.inline, timeoutSeconds: s.timeoutSeconds };
  return { type: 'skip', reason: s.reason };
}

export function startCommand(src: CatalogComponent | CatalogSpecStandalone): string[] | undefined {
  const cmd = 'startCommand' in src ? src.startCommand : undefined;
  return cmd ? ['sh', '-c', cmd] : undefined;
}

export function toDomain(d?: CatalogDomainSpec): AppDomainPlan | undefined {
  if (!d) return undefined;
  return {
    auto: d.auto ?? false,
    tls: d.tls ?? false,
    userCustomizable: d.userCustomizable ?? true,
    hostnameMode: d.hostnameMode ?? 'ip',
    certChallenge: d.certChallenge ?? 'http-01',
    provider: d.certificateProvider ?? 'lets-encrypt',
  };
}
