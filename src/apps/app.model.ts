/** Internal contracts for `vops app` — a provider-agnostic, normalized view of a K8s-shaped
 * flui.yaml workload as it maps onto a single host running rootful Podman + Quadlet. Pure data: no NestJS, no I/O. */

export const APP_INSTALL_VERSION = 1 as const;

/** v1 ships rootful only; the field exists so rootless is an addition, not a migration. */
export type AppMode = 'rootful';

export type AppKind = 'standalone' | 'composed' | 'application';

export interface AppPortPlan {
  name: string;
  /** Port the container listens on. */
  container: number;
  /** Whether this port is meant to be reachable from outside the host. */
  expose: boolean;
  protocol: 'http' | 'tcp';
  /** Explicit ingress routing for this HTTP port (e.g. an API at `/api`). Absent =
   * the primary's HTTP port is the root; a secondary's port is not ingress-fronted. */
  route?: PortRoutePlan;
}

/** Normalized ingress routing hint for one HTTP port. */
export interface PortRoutePlan {
  /** Path prefix under the app hostname, normalized to a leading-slash form (`/api`, `/`). */
  path: string;
  /** Strip the path prefix before proxying to the backend. */
  stripPrefix: boolean;
}

export interface AppVolumePlan {
  /** Logical name from the manifest. */
  name: string;
  /** Podman named volume: `vops-<app>-<name>`. */
  volume: string;
  mountPath: string;
  /** Informational only — Podman named volumes carry no quota. */
  size?: string;
}

export interface AppEnvPlain {
  name: string;
  value: string;
  /** A userInput marked `required` on a non-secret env → deploy must collect a value. */
  required?: boolean;
  /** userInput `group` id → member of an "at least one of" set (individually optional). */
  group?: string;
}

/** A value injected as a Podman secret rather than a plain env var: `generate` secrets are
 * created host-side and reused across redeploys, `value` secrets carry a known value pushed once. */
export interface AppSecretPlan {
  /** Podman secret name: `vops-<app>-<owner>-<key>`. */
  name: string;
  /** Env var the secret is exposed as inside the container. */
  target: string;
  generate?: { length: number; format: 'base64url' | 'hex' };
  value?: string;
  /** userInput `required: false` → deploy may leave it unset (then it is not injected). */
  optional?: boolean;
  /** userInput `group` id → member of an "at least one of" set (individually optional). */
  group?: string;
}

export interface AppHealthPlan {
  type: 'http' | 'tcp' | 'exec';
  path?: string;
  port?: number;
  command?: string[];
  /** Extra request headers for an http probe (e.g. a Host the app trusts). */
  httpHeaders?: Record<string, string>;
  initialDelay?: string;
  interval?: string;
  timeout?: string;
  retries?: number;
}

export interface AppComponentPlan {
  /** Logical name (standalone → 'app'; composed → manifest component name). */
  name: string;
  /** Podman container name / DNS name on the shared network: `vops-<app>-<name>`. */
  container: string;
  /** Fully-qualified image reference `registry/repo:tag`. */
  image: string;
  env: AppEnvPlain[];
  secrets: AppSecretPlan[];
  ports: AppPortPlan[];
  volumes: AppVolumePlan[];
  /** CPU limit in Podman form (e.g. '0.3', '1'); undefined = unset. */
  cpu?: string;
  /** Memory limit in Podman form (e.g. '256m', '1g'); undefined = unset. */
  memory?: string;
  health?: AppHealthPlan;
  /** Logical names of components this one depends on (ordering + network). */
  dependsOn: string[];
  command?: string[];
}

export interface SmokeTestPlan {
  type: 'http' | 'tcp' | 'script' | 'skip';
  path?: string;
  expectedStatus?: number;
  port?: number;
  timeoutSeconds?: number;
  retries?: number;
  inline?: string;
  reason?: string;
}

/** Host-independent projection of the manifest `spec.domain` block — carries only toggles, the
 * hostname is a deploy-time input. `certChallenge` is advisory: only `http-01` is implemented. */
export interface AppDomainPlan {
  auto: boolean;
  tls: boolean;
  userCustomizable: boolean;
  hostnameMode: 'ip' | 'domain';
  certChallenge: 'http-01' | 'dns-01';
  provider: 'lets-encrypt' | 'lets-encrypt-staging';
}

/** How the user reaches the app after install — resolved from the manifest `access` block. */
export type AppAccessMode = 'credentials' | 'firstVisit' | 'none';

/** How the app authenticates its own users, as the manifest declares it and vops can honour it
 * (see `effectiveAuthMode`). Undefined = the manifest says nothing, so vops assumes nothing. */
export type AppAuthMode = 'oidc' | 'proxy' | 'native' | 'none';

/** Where a manifest says the app belongs: `internal` = host-local, not published. On a single vops
 * host this is **advisory** — the operator's `--domain` still wins, so an `internal` app that is
 * given one is exposed with a warning saying exactly that (see `internalExposureWarnings`). */
export type AppExposure = 'public' | 'internal';

/** One credential part. `value` is a known non-secret literal safe to print; `userSet`/`generated`
 * carry only the Podman secret NAME — read back on explicit reveal, never stored or printed at deploy. */
export interface AppAccessPart {
  kind: 'value' | 'userSet' | 'generated';
  value?: string;
  secret?: string;
  /** For kind 'value' from a plain env — the env name, to refresh after `--set` overrides. */
  envName?: string;
}

export interface AppAccessPlan {
  mode: AppAccessMode;
  /** Login path under the app URL (`/`, `/admin`, `/_/`). */
  path: string;
  username?: AppAccessPart;
  password?: AppAccessPart;
  note?: string;
}

/** A manifest `postInstall` step this install will run: one command inside one container, after
 * the app is up — some apps (e.g. Home Assistant's reverse-proxy config) are configurable no other way. */
export interface AppPostInstallStep {
  name: string;
  /** Logical component name whose container runs the command. */
  component: string;
  command: string[];
  /** Reads `{{install.resolvedFqdn}}` → cannot run until a domain exists. */
  needsFqdn: boolean;
}

/** The normalized, host-independent deployment plan (pure output of normalize). */
export interface AppPlan {
  /** Install handle, sanitized: `/^[a-z0-9][a-z0-9-]*$/`. */
  name: string;
  /** Catalog id or manifest metadata.name. */
  appId: string;
  displayName: string;
  kind: AppKind;
  mode: AppMode;
  /**
   * Quadlet pod name for a composed app (`vops-<app>`). Components share the pod's
   * network namespace → they reach each other on 127.0.0.1 (no bridge DNS needed).
   */
  pod?: string;
  components: AppComponentPlan[];
  /** Logical name of the component used for the endpoint + smoke test. */
  primary: string;
  smokeTest?: SmokeTestPlan;
  /** Projected `spec.domain` (undefined when the manifest declares no domain). */
  domain?: AppDomainPlan;
  /** Some env value references `{{app.domain}}` → it resolves to the ingress hostname, or to
   * the install's loopback origin (`127.0.0.1:<port>`) when it is deployed without a domain. */
  needsAppDomain: boolean;
  /** Resolved login/credentials block (undefined when the manifest declares no `access`). */
  access?: AppAccessPlan;
  /** Effective `spec.auth` mode (undefined when the manifest declares no `auth`). */
  authMode?: AppAuthMode;
  /** Declared `spec.exposure` (undefined when the manifest declares none) — advisory, see `AppExposure`. */
  exposure?: AppExposure;
  /** Manifest `postInstall` steps this install will actually run (see post-install.ts). */
  postInstall?: AppPostInstallStep[];
  /** Manifest fields a single host cannot honour, reported rather than dropped silently. */
  warnings?: string[];
}

/** A resolved deploy-time ingress decision passed into host binding: the routed HTTP port binds
 * loopback-only unless `exposeDirect`, and `{{app.domain}}` env references resolve to `hostname`. */
export interface IngressBinding {
  /** Fully-qualified hostname Traefik routes (sslip.io default or BYO). */
  hostname: string;
  tls: boolean;
  /** Keep routed ports on 0.0.0.0 as well (direct access alongside ingress). */
  exposeDirect: boolean;
  /** One or more HTTP routes under `hostname` (exactly one has path `/` = root). */
  routes: IngressRoute[];
}

/** One routed HTTP endpoint of an app: a component's container port at a path. */
export interface IngressRoute {
  /** Logical name of the routed component. */
  component: string;
  /** The container port that is routed. */
  containerPort: number;
  /** Path prefix under the hostname (`/` = root). */
  path: string;
  stripPrefix: boolean;
}

export interface PublishedPort {
  host: number;
  container: number;
  bind: string;
}

export interface AppEndpoint {
  component: string;
  port: number;
  url: string;
  /** How the URL is reachable: `ingress` (Traefik/domain), `public` (0.0.0.0), `loopback` (127.0.0.1, tunnel only). */
  reach?: 'ingress' | 'public' | 'loopback';
}

/** An auto-created DNS A-record, remembered so detach/remove can delete it. */
export interface IngressDnsRecord {
  provider: string;
  zoneId: string;
  /** Apex of the owning zone (e.g. `example.com`) — used to query its authoritative NS. */
  zoneName: string;
  recordId: string;
  name: string;
}

/** A persisted ingress basic-auth gate, re-applied on every redeploy so it can never silently drop.
 * Holds the bcrypt HASH (safe to persist); the plaintext lives only in the root-only Podman `secret`. */
export interface AppIngressAuthState {
  mode: 'basic';
  user: string;
  secret: string;
  hash: string;
}

/** Persisted ingress route for an install (undefined = not fronted by Traefik). */
export interface AppIngressState {
  hostname: string;
  tls: boolean;
  /** Whether Let's Encrypt staging was used (browser-untrusted). */
  staging: boolean;
  /** The ROOT route's component + host port (path `/`). Kept flat for back-compat:
   * installs saved before multi-route have only this, no `routes`. */
  component: string;
  hostPort: number;
  /** Extra non-root HTTP routes (e.g. `/api`); absent = a single root route. */
  routes?: AppIngressRoute[];
  /** The routed port is also bound 0.0.0.0 (direct access kept). */
  exposeDirect: boolean;
  /** Named cert resolver referenced in the dynamic route file. */
  certResolver: string;
  /** Remote path of the Traefik dynamic route file. */
  routeFile: string;
  /** Auto-created A-record (absent for sslip.io / manually-managed DNS). */
  dns?: IngressDnsRecord;
  /** Ingress basic-auth gate fronting this app (absent = no gate). */
  auth?: AppIngressAuthState;
  attachedAt: string;
}

/** A persisted non-root HTTP route (an extra endpoint like an API under `/api`). */
export interface AppIngressRoute {
  component: string;
  containerPort: number;
  hostPort: number;
  path: string;
  stripPrefix: boolean;
}

/** A stored install (persisted whole as JSON in the app_installs table). */
export interface AppInstallV1 {
  version: typeof APP_INSTALL_VERSION;
  name: string;
  appId: string;
  displayName: string;
  host: string;
  mode: AppMode;
  kind: AppKind;
  /** Quadlet pod name (composed apps); undefined for standalone. */
  pod?: string;
  /** Logical name of the primary component (endpoint / logs / smoke target). */
  primary: string;
  components: Array<{
    name: string;
    container: string;
    image: string;
    published: PublishedPort[];
  }>;
  /** Rendered unit files (remote path → content) — kept for rollback + remove. */
  units: Record<string, string>;
  /** Podman secret names created for this install (host-side; values never stored). */
  secrets: string[];
  /** Podman named volumes for this install (removed only on `--purge`). */
  volumes: string[];
  endpoints: AppEndpoint[];
  /** Traefik ingress route, when the app is fronted by a domain + TLS. */
  ingress?: AppIngressState;
  /** Resolved login/credentials (secret values never stored — names only, read back on reveal). */
  access?: AppAccessPlan;
  /** Raw-port publish intent: `loopback` (127.0.0.1, tunnel/ingress only) or `public` (0.0.0.0).
   * Absent on legacy installs saved before this field — inferred from stored binds on redeploy. */
  publish?: 'loopback' | 'public';
  /** `installing` = the row was written before the host was touched and never confirmed: the
   * install is either still running or was interrupted (kill, crash, lost connection), so
   * whatever it created is on the host and `app remove` is the way to take it back off. */
  status: 'installing' | 'deployed' | 'failed' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export interface AppInstallSummary {
  name: string;
  appId: string;
  displayName: string;
  host: string;
  kind: AppKind;
  status: AppInstallV1['status'];
  endpoints: AppEndpoint[];
  /** Public hostname + TLS flag when fronted by ingress (UI badge). */
  ingress?: { hostname: string; tls: boolean; staging: boolean };
  /** Resolved login/credentials block for the UI (secret values never included). */
  access?: AppAccessPlan;
  /** The deploy host is gone from inventory — vops can't reach it; only a local
   * forget is possible. Set by the service at list time, not persisted. */
  hostMissing?: boolean;
  updatedAt: string;
}

export function installSummary(i: AppInstallV1): AppInstallSummary {
  return {
    name: i.name,
    appId: i.appId,
    displayName: i.displayName,
    host: i.host,
    kind: i.kind,
    status: i.status,
    endpoints: i.endpoints,
    ...(i.ingress ? { ingress: { hostname: i.ingress.hostname, tls: i.ingress.tls, staging: i.ingress.staging } } : {}),
    ...(i.access ? { access: i.access } : {}),
    updatedAt: i.updatedAt,
  };
}
