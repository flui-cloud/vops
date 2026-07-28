/** Pure renderers for the vops ingress — a per-host Traefik v3 singleton fronting apps with a real
 * hostname + ACME TLS. Runs as ONE rootful Quadlet `.container` with `Network=host`, the only
 * configuration where host-network Traefik can still reach an app bound to 127.0.0.1. */

/** Pinned Traefik v3 (byte-exact, like the app catalog). No auto-update: an ingress
 * that self-upgrades is unattended blast-radius — upgrades are an explicit action. */
export const TRAEFIK_IMAGE = 'docker.io/library/traefik:v3.7.8';

export const INGRESS_CONF_DIR = '/etc/vops/ingress';
/** Host-side marker recording which backend (`traefik`|`caddy`) this host's ingress runs. */
export const INGRESS_PROXY_MARKER = `${INGRESS_CONF_DIR}/proxy`;
export const INGRESS_DYNAMIC_DIR = `${INGRESS_CONF_DIR}/dynamic`;
export const INGRESS_ACME_FILE = `${INGRESS_CONF_DIR}/acme.json`;
export const INGRESS_ACME_STAGING_FILE = `${INGRESS_CONF_DIR}/acme-staging.json`;
export const INGRESS_STATIC_FILE = `${INGRESS_CONF_DIR}/traefik.yml`;
/** Traefik `ping` entrypoint — loopback-only, used as the `ingress up` health gate. */
export const INGRESS_PING_PORT = 8099;

export const INGRESS_UNIT_DIR = '/etc/containers/systemd/vops-ingress';
export const INGRESS_CONTAINER = 'vops-ingress';
export const INGRESS_SERVICE = 'vops-ingress.service';

/** Named cert resolvers (must match the two acme storage files). */
export const RESOLVER_PROD = 'le';
export const RESOLVER_STAGING = 'le-staging';

export function ingressRouteFile(app: string): string {
  return `${INGRESS_DYNAMIC_DIR}/${app}.yml`;
}

export interface TraefikStaticOptions {
  email: string;
  /** Override the prod resolver's ACME directory (used by the Pebble test rig). */
  caServer?: string;
}

/** The Traefik static config (`traefik.yml`). Two ACME HTTP-01 resolvers — prod
 * (`le`) and staging (`le-staging`) — with SEPARATE storage (different CAs must
 * never share an acme.json). */
export function renderTraefikStatic(o: TraefikStaticOptions): string {
  const prodAcme = [
    `      email: ${yamlStr(o.email)}`,
    `      storage: ${INGRESS_ACME_FILE}`,
    ...(o.caServer ? [`      caServer: ${yamlStr(o.caServer)}`] : []),
    '      httpChallenge:',
    '        entryPoint: web',
  ];
  return [
    'entryPoints:',
    '  web:',
    '    address: ":80"',
    '  websecure:',
    '    address: ":443"',
    '  ping:',
    `    address: "127.0.0.1:${INGRESS_PING_PORT}"`,
    'ping:',
    '  entryPoint: ping',
    'providers:',
    '  file:',
    `    directory: ${INGRESS_DYNAMIC_DIR}`,
    '    watch: true',
    'certificatesResolvers:',
    `  ${RESOLVER_PROD}:`,
    '    acme:',
    ...prodAcme,
    `  ${RESOLVER_STAGING}:`,
    '    acme:',
    `      email: ${yamlStr(o.email)}`,
    `      storage: ${INGRESS_ACME_STAGING_FILE}`,
    '      caServer: https://acme-staging-v02.api.letsencrypt.org/directory',
    '      httpChallenge:',
    '        entryPoint: web',
    'log:',
    '  level: INFO',
    '',
  ].join('\n');
}

export interface RouteEntry {
  hostPort: number;
  /** Path prefix under the hostname; `/` = root. */
  path: string;
  stripPrefix: boolean;
}

/** An ingress-level HTTP basic-auth gate for one app's route — a single user + a
 * bcrypt hash. Fronts the whole hostname so an app with no/weak native auth (or a
 * first-visit installer) is never exposed naked. The hash (not the password) is what
 * lands in the plaintext route file. */
export interface RouteAuth {
  user: string;
  hash: string;
}

/** Username charset: letters, digits, and `. _ -` only — a gate user lands verbatim in
 * a root-parsed proxy config, so nothing that could break out of it (newline, `{`, `:`). */
export const AUTH_USER_RE = /^[A-Za-z0-9._-]{1,32}$/;
/** A bcrypt modular-crypt hash (`$2a/2b/2y$<cost>$<53 base64 chars>`). */
export const AUTH_HASH_RE = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

/** Config-injection guard: reject any basic-auth user/hash that isn't a plain username
 * + a well-formed bcrypt hash BEFORE it is interpolated into a Caddyfile/Traefik config.
 * Defends the render even on the redeploy path that re-uses a persisted hash. */
export function assertRouteAuth(a: RouteAuth): void {
  if (!AUTH_USER_RE.test(a.user)) throw new Error(`Unsafe basic-auth user '${a.user}'.`);
  if (!AUTH_HASH_RE.test(a.hash)) throw new Error('Malformed basic-auth hash.');
}

export interface RouteOptions {
  app: string;
  hostname: string;
  /** false = plain-HTTP routers (the pre-ACME reachability probe); true = TLS + redirect. */
  tls: boolean;
  certResolver: string;
  /** One or more HTTP routes under `hostname` (exactly one is the root, path `/`). */
  routes: RouteEntry[];
  /** Optional basic-auth gate applied to every app router (not the HTTP→HTTPS redirect). */
  auth?: RouteAuth;
}

/** One app's Traefik dynamic route file: a router+service per route (root `Host()`,
 * others `Host() && PathPrefix()` — longer rule auto-wins in v3), plus, when TLS is
 * on, one catch-all HTTP→HTTPS redirect. Plain-HTTP first (for the laptop-side
 * reachability preflight), then rewritten with TLS. */
export function renderRoute(o: RouteOptions): string {
  if (o.auth) assertRouteAuth(o.auth);
  const entry = o.tls ? 'websecure' : 'web';
  const authMw = o.auth ? `vops-${o.app}-auth` : null;
  const routerLines = o.routes.flatMap((r) => {
    const name = routeName(o.app, r.path);
    const strip = r.stripPrefix && r.path !== '/';
    const mws = [...(strip ? [`${name}-strip`] : []), ...(authMw ? [authMw] : [])];
    return [
      `    ${name}:`,
      `      rule: ${yamlStr(routeRule(o.hostname, r.path))}`,
      `      entryPoints: [${entry}]`,
      `      service: ${name}`,
      ...(mws.length ? [`      middlewares: [${mws.join(', ')}]`] : []),
      ...(o.tls ? ['      tls:', `        certResolver: ${o.certResolver}`] : []),
    ];
  });
  const redirectRouter = o.tls
    ? [
        `    vops-${o.app}-http:`,
        `      rule: ${yamlStr(routeRule(o.hostname, '/'))}`,
        '      entryPoints: [web]',
        `      service: ${routeName(o.app, o.routes[0].path)}`,
        '      middlewares: [vops-https-redirect]',
      ]
    : [];
  const serviceLines = o.routes.flatMap((r) => {
    const backend = `http://127.0.0.1:${r.hostPort}`;
    return [
      `    ${routeName(o.app, r.path)}:`,
      '      loadBalancer:',
      '        servers:',
      `          - url: ${yamlStr(backend)}`,
    ];
  });
  const stripMiddlewares = o.routes
    .filter((r) => r.stripPrefix && r.path !== '/')
    .flatMap((r) => [`    ${routeName(o.app, r.path)}-strip:`, '      stripPrefix:', `        prefixes: [${r.path}]`]);
  const redirectMiddleware = o.tls
    ? ['    vops-https-redirect:', '      redirectScheme:', '        scheme: https', '        permanent: true']
    : [];
  const userLine = o.auth ? `${o.auth.user}:${o.auth.hash}` : '';
  const authMiddleware = o.auth
    ? [`    ${authMw}:`, '      basicAuth:', '        users:', `          - ${yamlStr(userLine)}`]
    : [];
  const middlewares = [...stripMiddlewares, ...redirectMiddleware, ...authMiddleware];
  return [
    'http:',
    '  routers:',
    ...routerLines,
    ...redirectRouter,
    '  services:',
    ...serviceLines,
    ...(middlewares.length ? ['  middlewares:', ...middlewares] : []),
    '',
  ].join('\n');
}

/** Router/service name for a route: `vops-<app>` for the root, `vops-<app>-<slug>` else. */
function routeName(app: string, path: string): string {
  if (path === '/') return `vops-${app}`;
  return `vops-${app}-${path.split('/').filter(Boolean).join('-')}`;
}

function routeRule(hostname: string, path: string): string {
  const host = `Host(\`${hostname}\`)`;
  return path === '/' ? host : `${host} && PathPrefix(\`${path}\`)`;
}

export interface IngressContainerOptions {
  selinux: boolean;
  /** Extra `Environment=` lines (e.g. LEGO_CA_CERTIFICATES for the Pebble rig). */
  env?: Record<string, string>;
  image?: string;
}

/** The `vops-ingress.container` Quadlet unit (host network, config dir bind-mount). */
export function renderIngressContainer(o: IngressContainerOptions): string {
  const z = o.selinux ? ':Z' : '';
  const env = Object.entries(o.env ?? {}).map(([k, v]) => `Environment=${k}=${v}`);
  return [
    '[Unit]',
    'Description=vops ingress (Traefik)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Container]',
    `ContainerName=${INGRESS_CONTAINER}`,
    `Image=${o.image ?? TRAEFIK_IMAGE}`,
    'Network=host',
    // Bind the whole config DIR (not individual files): Traefik's file-provider
    // watch misses events when a watched file's inode is replaced (scp/rename),
    // which is exactly how route files arrive.
    `Volume=${INGRESS_CONF_DIR}:${INGRESS_CONF_DIR}${z}`,
    `Exec=--configFile=${INGRESS_STATIC_FILE}`,
    ...env,
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

/** Minimal YAML double-quoted scalar (escapes `\` and `"`). Inputs are validated
 * hostnames/emails/URLs upstream, so this only guards structural characters. */
function yamlStr(v: string): string {
  return '"' + v.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`) + '"';
}
