/** Pure renderers for the Caddy ingress backend — the lighter-footprint alternative to Traefik
 * (~½ RAM, ⅓ image) for single-node hosts; same shape as ingress-render, one Caddyfile fragment per app. */
import { INGRESS_CONF_DIR, INGRESS_CONTAINER, RouteAuth, RouteEntry, assertRouteAuth } from './ingress-render';

/** Pinned Caddy 2 (byte-exact, no auto-update — upgrades are an explicit action). */
export const CADDY_IMAGE = 'docker.io/library/caddy:2.8.4';
export const CADDY_CONFIG_FILE = `${INGRESS_CONF_DIR}/Caddyfile`;
/** Caddy fragments live apart from Traefik's `.yml` (a `.caddy` in Traefik's dir would
 * break its file provider) — a host runs one backend, but the dirs never cross-parse. */
export const CADDY_DYNAMIC_DIR = `${INGRESS_CONF_DIR}/caddy`;
export const CADDY_DATA_DIR = `${INGRESS_CONF_DIR}/caddy-data`;
/** Caddy's admin API — loopback-only, used as the `ingress up` health gate. */
export const CADDY_ADMIN_PORT = 2019;
export const LE_STAGING_DIR = 'https://acme-staging-v02.api.letsencrypt.org/directory';

export function caddyRouteFile(app: string): string {
  return `${CADDY_DYNAMIC_DIR}/${app}.caddy`;
}

export interface CaddyStaticOptions {
  email: string;
  /** Override the ACME directory (the Pebble test rig) — global `acme_ca`. */
  caServer?: string;
  /** PEM path trusted as the ACME CA's root (Pebble serves its directory over TLS). */
  caRootPath?: string;
}

/** The global Caddyfile: email, loopback admin (health), optional test CA, and the
 * per-app fragment import. */
export function renderCaddyfile(o: CaddyStaticOptions): string {
  const globals = [
    `    email ${o.email}`,
    `    admin 127.0.0.1:${CADDY_ADMIN_PORT}`,
    ...(o.caServer ? [`    acme_ca ${o.caServer}`] : []),
    ...(o.caRootPath ? [`    acme_ca_root ${o.caRootPath}`] : []),
  ];
  return ['{', ...globals, '}', `import ${CADDY_DYNAMIC_DIR}/*.caddy`, ''].join('\n');
}

export interface CaddyRouteOptions {
  app: string;
  hostname: string;
  /** false = plain `http://` site (no auto-HTTPS) for the pre-ACME reachability probe. */
  tls: boolean;
  /** Issue from Let's Encrypt staging instead of production (per-site `tls { ca }`). */
  staging: boolean;
  routes: RouteEntry[];
  /** Optional basic-auth gate fronting the whole site (before any handle). */
  auth?: RouteAuth;
}

/** One app's Caddyfile fragment: path routes first, root last (Caddy takes the first match).
 * A matcher-less `basic_auth` runs before every handle by Caddy's fixed directive order, gating the whole hostname. */
export function renderCaddyRoute(o: CaddyRouteOptions): string {
  if (o.auth) assertRouteAuth(o.auth);
  const site = o.tls ? o.hostname : `http://${o.hostname}`;
  const extras = o.routes.filter((r) => r.path !== '/');
  const root = o.routes.find((r) => r.path === '/');
  const tlsBlock = o.tls && o.staging ? ['    tls {', `        ca ${LE_STAGING_DIR}`, '    }'] : [];
  const authBlock = o.auth ? ['    basic_auth {', `        ${o.auth.user} ${o.auth.hash}`, '    }'] : [];
  return [
    `${site} {`,
    ...tlsBlock,
    ...authBlock,
    ...extras.flatMap(routeHandle),
    ...(root ? rootHandle(root) : []),
    '}',
    '',
  ].join('\n');
}

function routeHandle(r: RouteEntry): string[] {
  const directive = r.stripPrefix ? 'handle_path' : 'handle';
  return [`    ${directive} ${r.path}/* {`, `        reverse_proxy 127.0.0.1:${r.hostPort}`, '    }'];
}

function rootHandle(r: RouteEntry): string[] {
  return ['    handle {', `        reverse_proxy 127.0.0.1:${r.hostPort}`, '    }'];
}

export interface CaddyContainerOptions {
  selinux: boolean;
  image?: string;
}

/** The `vops-ingress.container` Quadlet unit for Caddy (host network; config + cert
 * data under the shared conf-dir bind-mount). Same container NAME/unit dir as Traefik
 * — a host runs one backend or the other, never both. */
export function renderCaddyContainer(o: CaddyContainerOptions): string {
  const z = o.selinux ? ':Z' : '';
  return [
    '[Unit]',
    'Description=vops ingress (Caddy)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Container]',
    `ContainerName=${INGRESS_CONTAINER}`,
    `Image=${o.image ?? CADDY_IMAGE}`,
    'Network=host',
    `Volume=${INGRESS_CONF_DIR}:${INGRESS_CONF_DIR}${z}`,
    // Persist issued certs across restarts (LE duplicate-cert limits) via XDG_DATA_HOME.
    `Environment=XDG_DATA_HOME=${CADDY_DATA_DIR}`,
    `Exec=caddy run --config ${CADDY_CONFIG_FILE} --adapter caddyfile`,
    '',
    '[Service]',
    'Restart=always',
    'RestartSec=5',
    'TimeoutStartSec=120',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}
