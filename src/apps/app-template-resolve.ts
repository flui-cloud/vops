import type {
  CatalogComponent,
  CatalogEnvVar,
  CatalogSpecStandalone,
} from '@flui-cloud/spec';
import { AppComponentPlan, AppEnvPlain, AppHealthPlan, AppSecretPlan } from './app.model';
import { imageRef, resourceLimits, startCommand, toHealth, toPort, toVolume } from './app-plan-converters';
import { APP_ID_TOKEN, NormalizeError, inputRequired, sanitize } from './spec-normalize';

/** `{{env.KEY}}` — a reference to another env var in the SAME component. */
const ENV_SELF_TOKEN = /\{\{\s{0,8}env\.(\w{1,64})\s{0,8}\}\}/g;

/** `{{app.domain}}` — resolved to the ingress hostname at deploy time, not here. */
const APP_DOMAIN_TOKEN = /\{\{\s{0,8}app\.domain\s{0,8}\}\}/g;

export interface RawComponent {
  logical: string;
  container: string;
  src: CatalogComponent | CatalogSpecStandalone;
  /** What each env resolves to when referenced by ANOTHER component's template. */
  index: Map<string, EnvRef>;
}

export type EnvRef =
  | { kind: 'plain'; value: string }
  | { kind: 'secret'; secret: AppSecretPlan };

export function rawComponent(
  app: string,
  logical: string,
  src: CatalogComponent | CatalogSpecStandalone,
): RawComponent {
  const index = new Map<string, EnvRef>();
  for (const e of src.env ?? []) index.set(e.name, indexEnv(app, logical, e));
  return { logical, container: `vops-${app}-${logical}`, src, index };
}

/** Classify an env for CROSS-reference (what another component's template sees). */
function indexEnv(app: string, logical: string, e: CatalogEnvVar): EnvRef {
  const name = secretName(app, logical, e.name);
  const vf = e.valueFrom;
  if (vf && 'generate' in vf) {
    return { kind: 'secret', secret: { name, target: e.name, generate: { length: vf.length, format: vf.format ?? 'base64url' } } };
  }
  if (vf && 'secretRef' in vf) return { kind: 'secret', secret: { name, target: e.name, value: '' } };
  if (vf && 'userInput' in vf && vf.userInput.sensitive) {
    const ui = vf.userInput;
    return { kind: 'secret', secret: { name, target: e.name, value: '', optional: !inputRequired(ui), ...(ui.group ? { group: ui.group } : {}) } };
  }
  if (e.secret) return { kind: 'secret', secret: { name, target: e.name, value: e.value ?? '' } };
  const raw = e.value ?? (vf && 'userInput' in vf ? vf.userInput.default ?? '' : '');
  return { kind: 'plain', value: raw.replace(APP_ID_TOKEN, app) };
}

const TEMPLATE = /\{\{\s{0,8}components\.([\w-]+)\.(host|env\.\w+)\s{0,8}\}\}/g;

export function resolveComponent(
  app: string,
  r: RawComponent,
  byLogical: Map<string, RawComponent>,
): AppComponentPlan {
  const env: AppEnvPlain[] = [];
  const secrets: AppSecretPlan[] = [];

  for (const e of r.src.env ?? []) {
    const placed = placeEnv(app, r.logical, e, byLogical);
    if (placed.env) env.push(placed.env);
    if (placed.secret) secrets.push(placed.secret);
  }

  const src = r.src;
  return {
    name: r.logical,
    container: r.container,
    image: imageRef(src.image),
    env,
    secrets,
    ports: (src.ports ?? []).map((p) => toPort(p)),
    volumes: (src.volumes ?? []).map((v) => toVolume(app, r.logical, v)),
    ...resourceLimits(src.resources),
    health: resolveHealth(app, r.logical, toHealth(src.healthcheck), byLogical),
    dependsOn: 'dependsOn' in src ? src.dependsOn ?? [] : [],
    command: startCommand(src),
  };
}

/** Resolve `{{app.id}}` / `{{env.KEY}}` inside a healthcheck's exec command. */
export function resolveHealth(
  app: string,
  logical: string,
  health: AppHealthPlan | undefined,
  byLogical: Map<string, RawComponent>,
): AppHealthPlan | undefined {
  if (!health?.command) return health;
  return { ...health, command: health.command.map((c) => resolveString(app, logical, c, byLogical)) };
}

/** Decide the final placement (plain env vs injected secret) for one env var. */
function placeEnv(
  app: string,
  logical: string,
  e: CatalogEnvVar,
  byLogical: Map<string, RawComponent>,
): { env?: AppEnvPlain; secret?: AppSecretPlan } {
  const own = secretName(app, logical, e.name);
  const vf = e.valueFrom;
  const ui = vf && 'userInput' in vf ? vf.userInput : undefined;
  if (vf && 'generate' in vf) {
    return { secret: { name: own, target: e.name, generate: { length: vf.length, format: vf.format ?? 'base64url' } } };
  }
  if (vf && 'secretRef' in vf) return { secret: { name: own, target: e.name, value: '' } };
  if (ui?.sensitive) {
    return { secret: { name: own, target: e.name, value: '', optional: !inputRequired(ui), ...(ui.group ? { group: ui.group } : {}) } };
  }

  const raw = e.value ?? ui?.default ?? '';
  const whole = wholeSecretTemplate(raw, byLogical) ?? wholeSelfSecret(raw, logical, byLogical);
  if (whole) return { secret: { name: whole.name, target: e.name } }; // inject; the owner creates it
  const resolved = resolveString(app, logical, raw, byLogical);
  if (e.secret) return { secret: { name: own, target: e.name, value: resolved } };
  // A non-secret userInput marked `required` must still be collected at deploy;
  // a group member is individually optional (the group enforces "at least one").
  const required = !!ui && inputRequired(ui);
  return { env: { name: e.name, value: resolved, ...(required ? { required: true } : {}), ...(ui?.group ? { group: ui.group } : {}) } };
}

/** A whole-value `{{env.KEY}}` pointing at a secret in the SAME component (e.g.
 * `REDISCLI_AUTH: '{{env.VALKEY_PASSWORD}}'`) → reuse that generated secret. */
function wholeSelfSecret(
  value: string,
  logical: string,
  byLogical: Map<string, RawComponent>,
): AppSecretPlan | null {
  const m = /^\{\{\s{0,8}env\.(\w{1,64})\s{0,8}\}\}$/.exec(value.trim());
  if (!m) return null;
  const ref = byLogical.get(logical)?.index.get(m[1]);
  return ref?.kind === 'secret' ? ref.secret : null;
}

function wholeSecretTemplate(
  value: string,
  byLogical: Map<string, RawComponent>,
): AppSecretPlan | null {
  const m = /^\{\{\s{0,8}components\.([\w-]+)\.env\.(\w+)\s{0,8}\}\}$/.exec(value.trim());
  if (!m) return null;
  const ref = byLogical.get(m[1])?.index.get(m[2]);
  return ref?.kind === 'secret' ? ref.secret : null;
}

function secretName(app: string, logical: string, envName: string): string {
  return `vops-${app}-${logical}-${sanitize(envName)}`;
}

function resolveString(
  app: string,
  logical: string,
  value: string,
  byLogical: Map<string, RawComponent>,
): string {
  const out = value
    .replaceAll(APP_ID_TOKEN, app)
    .replaceAll(TEMPLATE, (_all, comp: string, rest: string) => refValue(comp, rest, byLogical))
    .replaceAll(ENV_SELF_TOKEN, (_all, key: string) => refValue(logical, `env.${key}`, byLogical));
  // `{{app.domain}}` is resolved later (deploy-time hostname), so it is not
  // "unresolved" here — everything else left over is a genuine error.
  const leftover = out.replaceAll(APP_DOMAIN_TOKEN, '');
  APP_DOMAIN_TOKEN.lastIndex = 0;
  if (/\{\{/.test(leftover)) throw new NormalizeError(`Unresolved template in value: '${value}'.`);
  return out;
}

/** Plain value of `<comp>.host` / `<comp>.env.KEY` for in-string interpolation. */
function refValue(comp: string, rest: string, byLogical: Map<string, RawComponent>): string {
  const target = byLogical.get(comp);
  if (!target) throw new NormalizeError(`Template references unknown component '${comp}'.`);
  // Composed apps run as one Quadlet pod → components share the netns and reach
  // each other on loopback. `{{components.X.host}}` therefore resolves to 127.0.0.1.
  if (rest === 'host') return '127.0.0.1';
  const key = rest.slice('env.'.length);
  const ref = target.index.get(key);
  if (!ref) throw new NormalizeError(`Template references unknown env '${comp}.${key}'.`);
  if (ref.kind === 'plain') return ref.value;
  throw new NormalizeError(
    `Cannot interpolate secret '${comp}.env.${key}' inside a string — reference it as the whole value.`,
  );
}
