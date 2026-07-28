import type {
  ApplicationEnv,
  ApplicationEnvEntry,
  ApplicationEnvValueFrom,
  ApplicationManifest,
  ApplicationManifestResources,
} from '@flui-cloud/spec';
import {
  AppComponentPlan,
  AppDomainPlan,
  AppEnvPlain,
  AppPlan,
  AppSecretPlan,
  AppVolumePlan,
} from './app.model';
import { APP_DOMAIN_TOKEN, NormalizeError, cpuToPodman, memToPodman, sanitize } from './spec-normalize';

/** Pure projection of a `kind: Application` manifest onto a single-host AppPlan. Unlike a
 * CatalogApp, the image is a deploy-time INPUT (vops never builds); K8s-only fields (`scaling`,
 * `resources.requests/profile`) are dropped with a warning rather than silently ignored. */

/** Logical component name: an Application manifest describes exactly one container. */
const COMPONENT = 'app';

export interface ApplicationInput {
  /** Install handle; defaults to `metadata.name`. */
  name?: string;
  /** Fully-qualified image the app runs from — resolved before normalization. */
  image: string;
}

export interface ApplicationPlan {
  plan: AppPlan;
  warnings: string[];
}

export function normalizeApplication(manifest: ApplicationManifest, input: ApplicationInput): ApplicationPlan {
  const appId = manifest.metadata.name;
  const name = sanitize(input.name ?? appId);
  const deploy = manifest.deploy;
  const warnings: string[] = [];

  if (!input.image?.trim()) {
    throw new NormalizeError(
      'An Application manifest is built from your repository, so it carries no image. ' +
        'Pass --image <ref>, or build it first with `vops build run`.',
    );
  }
  const { env, secrets } = splitEnv(name, deploy.env, warnings);
  warnings.push(...unsupported(manifest));

  const component: AppComponentPlan = {
    name: COMPONENT,
    container: `vops-${name}-${COMPONENT}`,
    image: input.image.trim(),
    env,
    secrets,
    ports: [
      {
        name: 'http',
        container: deploy.port,
        expose: deploy.exposure !== 'internal',
        protocol: 'http',
      },
    ],
    volumes: (deploy.volumes ?? []).map((v) => toVolume(name, v)),
    ...limits(deploy.resources, warnings),
    ...(deploy.healthcheck
      ? { health: { type: 'http' as const, path: deploy.healthcheck.path, port: deploy.healthcheck.port ?? deploy.port } }
      : {}),
    dependsOn: [],
    ...(deploy.startCommand ? { command: ['sh', '-c', deploy.startCommand] } : {}),
  };

  const needsAppDomain = env.some((e) => hasDomainToken(e.value));
  const plan: AppPlan = {
    name,
    appId,
    displayName: appId,
    kind: 'application',
    mode: 'rootful',
    components: [component],
    primary: COMPONENT,
    smokeTest: deploy.healthcheck
      ? { type: 'http', path: deploy.healthcheck.path, expectedStatus: 200, timeoutSeconds: 120 }
      : { type: 'tcp', port: deploy.port, timeoutSeconds: 120 },
    domain: toDomain(deploy.domain),
    needsAppDomain,
  };
  if (warnings.length) plan.warnings = warnings;
  return { plan, warnings };
}

/** `{{app.domain}}` survives normalization — the ingress resolves it at deploy. */
function hasDomainToken(value: string): boolean {
  const found = APP_DOMAIN_TOKEN.test(value);
  APP_DOMAIN_TOKEN.lastIndex = 0;
  return found;
}

/** Split `deploy.env` into plain values and Podman secrets; accepts both the map form and the
 * deprecated array form (flui-spec already warns on the latter). */
function splitEnv(app: string, env: ApplicationEnv | undefined, warnings: string[]): { env: AppEnvPlain[]; secrets: AppSecretPlan[] } {
  const entries = toEntries(env);
  const plain: AppEnvPlain[] = [];
  const secrets: AppSecretPlan[] = [];

  for (const [key, entry] of entries) {
    const placed = placeEnv(app, key, entry, warnings);
    if (placed.env) plain.push(placed.env);
    if (placed.secret) secrets.push(placed.secret);
  }
  return { env: plain, secrets };
}

function toEntries(env: ApplicationEnv | undefined): Array<[string, ApplicationEnvEntry]> {
  if (!env) return [];
  if (Array.isArray(env)) {
    return env.map((e) => [
      e.name,
      { value: e.value, valueFrom: e.valueFrom, secret: e.secret, description: e.description },
    ]);
  }
  return Object.entries(env).map(([k, v]) => [k, typeof v === 'string' ? { value: v } : v]);
}

function placeEnv(
  app: string,
  key: string,
  entry: ApplicationEnvEntry,
  warnings: string[],
): { env?: AppEnvPlain; secret?: AppSecretPlan } {
  const name = `vops-${app}-${COMPONENT}-${sanitize(key)}`;
  const vf = entry.valueFrom;

  if (entry.delivery === 'build') {
    warnings.push(`env ${key} is delivery: build — it belongs in build.args and is not injected at runtime.`);
    return {};
  }
  if (vf?.service) {
    throw new NormalizeError(
      `env ${key} references another Flui service (valueFrom.service) — vops deploys one app per manifest. ` +
        'Point it at a concrete URL, or install the dependency as a building block and reference its host.',
    );
  }
  if (vf?.generate) {
    return { secret: { name, target: key, generate: { length: vf.length ?? 32, format: vf.format ?? 'base64url' } } };
  }
  if (vf?.secretRef) return { secret: { name, target: key, value: '' } };
  if (vf?.userInput) return userInputEnv(name, key, vf, entry);
  if (entry.secret) return { secret: { name, target: key, value: entry.value ?? '' } };
  if (entry.value === undefined) {
    warnings.push(`env ${key} declares neither value nor valueFrom — it will not be injected.`);
    return {};
  }
  return { env: { name: key, value: entry.value } };
}

/** A prompted value: sensitive → a Podman secret pushed with `--set`; otherwise
 * a plain env seeded with its default. */
function userInputEnv(
  name: string,
  key: string,
  vf: ApplicationEnvValueFrom,
  entry: ApplicationEnvEntry,
): { env?: AppEnvPlain; secret?: AppSecretPlan } {
  const ui = vf.userInput;
  if (ui.sensitive) return { secret: { name, target: key, value: '' } };
  const value = ui.default ?? entry.value ?? '';
  // Only flagged when there is genuinely nothing to fall back on — a prompt with
  // a default is already satisfied, and deploy must not stop to ask for it.
  return { env: { name: key, value, ...(value ? {} : { required: true }) } };
}

function toVolume(app: string, v: { name: string; mountPath: string; size?: string }): AppVolumePlan {
  return { name: v.name, volume: `vops-${app}-${COMPONENT}-${sanitize(v.name)}`, mountPath: v.mountPath, size: v.size };
}

function limits(r: ApplicationManifestResources | undefined, warnings: string[]): { cpu?: string; memory?: string } {
  if (r?.profile) {
    warnings.push(
      `deploy.resources.profile: ${r.profile} is not applied — vops sets Podman limits from resources.limits.cpu/memory.`,
    );
  }
  if (r?.requests && !r.limits) {
    warnings.push('deploy.resources.requests is a scheduler hint with no meaning on a single host — set resources.limits to cap the container.');
  }
  return { cpu: cpuToPodman(r?.limits?.cpu), memory: memToPodman(r?.limits?.memory) };
}

function toDomain(d: ApplicationManifest['deploy']['domain']): AppDomainPlan | undefined {
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

/** Manifest blocks a single host cannot honour — reported, never silently dropped. */
function unsupported(manifest: ApplicationManifest): string[] {
  return [
    ...(manifest.deploy.scaling
      ? ['deploy.scaling is not applied — vops runs a single replica on one host.']
      : []),
    ...(manifest.environments
      ? [
          'environments{} is not applied — vops deploys one environment per install. ' +
            'Use one manifest per environment, or override values with --set.',
        ]
      : []),
  ];
}
