/** Ingress backend abstraction so the same orchestration drives either **Traefik** or **Caddy**.
 * A host records its backend in a marker file; hosts from before markers existed default to Traefik. */
import { splitSections } from '../host-ops/status-battery';
import {
  RouteAuth,
  RouteEntry,
  TRAEFIK_IMAGE,
  ingressRouteFile,
  renderIngressContainer,
  renderRoute,
  renderTraefikStatic,
} from './ingress-render';
import { CADDY_IMAGE, caddyRouteFile, renderCaddyRoute, renderCaddyContainer, renderCaddyfile } from './caddy-render';
import {
  buildCertProbeScript,
  buildIngressInstallScript,
  buildIngressStatusScript,
  buildRouteRemoveScript,
  buildRouteWriteScript,
} from './ingress-scripts';
import {
  buildCaddyCertProbeScript,
  buildCaddyInstallScript,
  buildCaddyRouteRemoveScript,
  buildCaddyRouteWriteScript,
  buildCaddyStatusScript,
} from './caddy-scripts';
import {
  CertProbe,
  IngressInstallOutcome,
  IngressStatusInfo,
  parseCertProbe,
  parseIngressInstall,
  parseIngressStatus,
} from './app-parse';

export type ProxyKind = 'traefik' | 'caddy';

/** The default backend for a fresh host (no `--proxy`, no existing marker). Caddy for
 * the single-node target: ~½ the RAM and ⅓ the image of Traefik, automatic HTTPS.
 * Traefik stays selectable with `--proxy traefik` (and existing hosts keep theirs). */
export const DEFAULT_PROXY: ProxyKind = 'caddy';

export interface ProxyInstallRender {
  staticConfig: string;
  unit: string;
}
export interface ProxyRenderInstallInput {
  email: string;
  selinux: boolean;
  caServer?: string;
  caBundle?: { path: string; content: string };
}
export interface ProxyRouteRenderInput {
  app: string;
  hostname: string;
  tls: boolean;
  staging: boolean;
  /** Traefik resolver name; Caddy ignores it (uses `staging` for a `tls { ca }`). */
  certResolver: string;
  routes: RouteEntry[];
  /** Optional basic-auth gate fronting the app (both backends render it). */
  auth?: RouteAuth;
}
export interface ProxyInstallScriptInput {
  staticConfig: string;
  unit: string;
  image: string;
  caBundle?: { path: string; content: string };
}

export interface IngressProxy {
  kind: ProxyKind;
  image: string;
  routeFile(app: string): string;
  renderInstall(o: ProxyRenderInstallInput): ProxyInstallRender;
  buildInstall(o: ProxyInstallScriptInput): string;
  renderRoute(o: ProxyRouteRenderInput): string;
  buildRouteWrite(app: string, content: string): string;
  buildRouteRemove(app: string): string;
  buildStatus(): string;
  buildCertProbe(hostname: string): string;
  parseInstall(stdout: string): IngressInstallOutcome;
  parseStatus(stdout: string): IngressStatusInfo;
  parseCertProbe(stdout: string): CertProbe;
}

const TRAEFIK_PROXY: IngressProxy = {
  kind: 'traefik',
  image: TRAEFIK_IMAGE,
  routeFile: ingressRouteFile,
  renderInstall: (o) => ({
    staticConfig: renderTraefikStatic({ email: o.email, caServer: o.caServer }),
    unit: renderIngressContainer({ selinux: o.selinux, env: o.caBundle ? { LEGO_CA_CERTIFICATES: o.caBundle.path } : undefined }),
  }),
  buildInstall: buildIngressInstallScript,
  renderRoute: (o) => renderRoute({ app: o.app, hostname: o.hostname, tls: o.tls, certResolver: o.certResolver, routes: o.routes, auth: o.auth }),
  buildRouteWrite: buildRouteWriteScript,
  buildRouteRemove: buildRouteRemoveScript,
  buildStatus: buildIngressStatusScript,
  buildCertProbe: buildCertProbeScript,
  parseInstall: parseIngressInstall,
  parseStatus: parseIngressStatus,
  parseCertProbe,
};

const CADDY_PROXY: IngressProxy = {
  kind: 'caddy',
  image: CADDY_IMAGE,
  routeFile: caddyRouteFile,
  renderInstall: (o) => ({
    staticConfig: renderCaddyfile({ email: o.email, caServer: o.caServer, caRootPath: o.caBundle?.path }),
    unit: renderCaddyContainer({ selinux: o.selinux }),
  }),
  buildInstall: buildCaddyInstallScript,
  renderRoute: (o) => renderCaddyRoute({ app: o.app, hostname: o.hostname, tls: o.tls, staging: o.staging, routes: o.routes, auth: o.auth }),
  buildRouteWrite: buildCaddyRouteWriteScript,
  buildRouteRemove: buildCaddyRouteRemoveScript,
  buildStatus: buildCaddyStatusScript,
  buildCertProbe: buildCaddyCertProbeScript,
  parseInstall: parseIngressInstall,
  parseStatus: parseIngressStatus,
  parseCertProbe,
};

const PROXIES: Record<ProxyKind, IngressProxy> = { traefik: TRAEFIK_PROXY, caddy: CADDY_PROXY };

export function isProxyKind(v: string): v is ProxyKind {
  return v === 'traefik' || v === 'caddy';
}

export function ingressProxy(kind: ProxyKind): IngressProxy {
  return PROXIES[kind];
}

/** The backend recorded in a host's marker, or null when the host has no ingress yet. */
export function parseProxyKind(stdout: string): ProxyKind | null {
  const v = (splitSections(stdout).proxy ?? '').trim();
  return isProxyKind(v) ? v : null;
}
