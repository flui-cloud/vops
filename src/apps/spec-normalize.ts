import { CatalogAppType } from '@flui-cloud/spec';
import type {
  CatalogAccess,
  CatalogAccessValue,
  CatalogAppManifest,
  CatalogAuth,
  CatalogOption,
  CatalogPostInstallStep,
  CatalogComponent,
  CatalogSpecComposed,
  CatalogSpecStandalone,
  CatalogUserInputPrompt,
} from '@flui-cloud/spec';
import {
  AppAccessPart,
  AppAccessPlan,
  AppComponentPlan,
  AppPlan,
} from './app.model';
import { rawComponent, resolveComponent } from './app-template-resolve';
import { toDomain, toSmokeTest } from './app-plan-converters';
import { effectiveAuthMode, selectPostInstall } from './post-install';

/** `{{app.domain}}` — resolved to the ingress hostname at deploy time, not here. */
export const APP_DOMAIN_TOKEN = /\{\{\s{0,8}app\.domain\s{0,8}\}\}/g;
/** The same token WITH the URL scheme a manifest may have written in front of it
 * (`https://{{app.domain}}`) — every deploy resolves both together, because the scheme the app is
 * served on is decided by `--tls`/`--no-tls` (or by having no domain at all), never by the manifest. */
export const APP_DOMAIN_URL_TOKEN = /(https?:\/\/)?\{\{\s{0,8}app\.domain\s{0,8}\}\}/g;
/** `{{app.scheme}}` — the scheme the app is actually reached on: `https` behind a TLS ingress,
 * `http` for a bare (loopback-only) install. A manifest that hardcodes `https` in a
 * protocol-only env (Nextcloud's `OVERWRITEPROTOCOL`) makes the app redirect to a TLS origin
 * nothing listens on when no domain was asked for. Unlike `{{app.domain}}` it never implies
 * ingress — it only follows it. */
export const APP_SCHEME_TOKEN = /\{\{\s{0,8}app\.scheme\s{0,8}\}\}/g;
/** `{{app.id}}` — the install name (e.g. a database name/user derived from the app). */
export const APP_ID_TOKEN = /\{\{\s{0,8}app\.id\s{0,8}\}\}/g;

/** Pure projection of a CatalogApp manifest onto a single-host AppPlan: `standalone` (one
 * component) and `composed` (N components with `{{components.X.host|env.KEY}}` templating). */
export class NormalizeError extends Error {}

export function normalizeManifest(manifest: CatalogAppManifest, installName?: string): AppPlan {
  const appId = manifest.metadata.id;
  const name = sanitize(installName ?? appId);
  const spec = manifest.spec;

  let plan: AppPlan;
  if (spec.type === CatalogAppType.STANDALONE) {
    plan = buildPlan(name, appId, manifest.metadata.name, 'standalone', spec, [
      { logical: 'app', source: spec },
    ]);
  } else if (spec.type === CatalogAppType.COMPOSED) {
    const composed = spec;
    // Components gated by an install-time option (`when.option`) are included only
    // when that option is on. vops has no option picker, so options take their
    // declared default — e.g. Nextcloud's optional Collabora (`option: office`,
    // default off) is dropped rather than deployed and left broken.
    const enabled = new Set((composed.options ?? []).filter((o) => o.default).map((o) => o.key));
    const active = composed.components.filter((c) => !c.when?.option || enabled.has(c.when.option));
    plan = buildPlan(
      name,
      appId,
      manifest.metadata.name,
      'composed',
      composed,
      active.map((c) => ({ logical: c.name, source: c })),
    );
  } else if (spec.type === CatalogAppType.BUILDING_BLOCK) {
    // A building block is a standalone service with no domain/exposure — same
    // image/ports/env/volumes/healthcheck shape. vops installs it directly (e.g.
    // a database a user wants on its own), defaulting its ports to internal.
    const bb = spec as unknown as CatalogSpecStandalone;
    plan = buildPlan(name, appId, manifest.metadata.name, 'standalone', bb, [
      { logical: 'app', source: bb },
    ]);
  } else {
    throw new NormalizeError(
      `Unsupported CatalogApp spec.type '${(spec as { type: string }).type}' — supports standalone, composed and building-block.`,
    );
  }

  plan.access = resolveAccess(manifest, plan);
  const auth = (spec as { auth?: CatalogAuth }).auth;
  if (auth) plan.authMode = effectiveAuthMode(auth);
  // Advisory only: vops honours the operator's --domain over the manifest's own placement, but the
  // declaration has to reach the plan for the deploy to be able to say so.
  const exposure = 'exposure' in spec ? spec.exposure : undefined;
  if (exposure) plan.exposure = exposure;
  const steps = selectPostInstall((spec as { postInstall?: CatalogPostInstallStep[] }).postInstall, {
    primary: plan.primary,
    auth,
    options: (spec as { options?: CatalogOption[] }).options,
  });
  if (steps.length) plan.postInstall = steps;
  return plan;
}

/** Resolve the manifest `access` block against the built plan. Credential parts map to a Podman
 * secret NAME (read back on reveal) or a known non-secret value; the login URL is composed at deploy time. */
function resolveAccess(manifest: CatalogAppManifest, plan: AppPlan): AppAccessPlan | undefined {
  const access = (manifest.spec as { access?: CatalogAccess }).access;
  if (!access) return undefined;
  const mode = access.mode ?? 'credentials';
  const path = access.path ?? manifest.metadata.entrypointPath ?? '/';
  if (mode !== 'credentials') return { mode, path, note: access.note };
  return {
    mode,
    path,
    username: resolveAccessPart(access.username, plan),
    password: resolveAccessPart(access.password, plan),
    note: access.note,
  };
}

function resolveAccessPart(v: CatalogAccessValue | undefined, plan: AppPlan): AppAccessPart | undefined {
  if (!v) return undefined;
  if (v.value != null) return { kind: 'value', value: v.value };
  if (!v.fromEnv) return undefined;
  const comps = v.component ? plan.components.filter((c) => c.name === v.component) : plan.components;
  for (const c of comps) {
    const sec = c.secrets.find((s) => s.target === v.fromEnv);
    if (sec) return sec.generate ? { kind: 'generated', secret: sec.name } : { kind: 'userSet', secret: sec.name };
    const env = c.env.find((e) => e.name === v.fromEnv);
    if (env) return { kind: 'value', value: env.value, envName: env.name };
  }
  return undefined;
}

/** Re-read plain-env credential values from the (post-`--set`) plan so a custom username entered
 * at deploy time shows instead of the manifest default; secret parts are untouched. */
export function refreshAccessValues(plan: AppPlan): void {
  const a = plan.access;
  if (!a) return;
  for (const part of [a.username, a.password]) {
    if (part?.kind === 'value' && part.envName) {
      const env = plan.components.flatMap((c) => c.env).find((e) => e.name === part.envName);
      if (env) part.value = env.value;
    }
  }
}

export interface InstallCheck {
  ok: boolean;
  /** Why the app can't be installed on a single vops host as-is (present when !ok). */
  reason?: string;
}

/** Whether a catalog app can be installed on a single vops host as-is. A `dependencies` block
 * (e.g. FerretDB needs PostgreSQL) is not yet auto-provisioned — a typed reason, not a crash.
 * `linkedBuildingBlocks` is the same gap seen from the client side: nothing resolves the referenced
 * building block, so its env mapping would stay unset and the app would start against nothing. */
export function checkInstallable(manifest: CatalogAppManifest): InstallCheck {
  const spec = manifest.spec;
  const deps = 'dependencies' in spec ? spec.dependencies : undefined;
  if (deps?.length) {
    const refs = deps.map((d) => d.ref).join(', ');
    return { ok: false, reason: `needs a linked ${refs} — dependency auto-compose is not yet supported on vops` };
  }
  const linked = 'linkedBuildingBlocks' in spec ? spec.linkedBuildingBlocks : undefined;
  if (linked?.length) {
    const refs = linked.map((l) => l.ref).join(', ');
    const vars = linked.flatMap((l) => l.envMapping.map((m) => m.name)).join(', ');
    return {
      ok: false,
      reason: `needs a linked ${refs} to connect to (${vars} would stay unset) — wiring an app to a building block is not yet supported on vops`,
    };
  }
  return { ok: true };
}

interface CompSource {
  logical: string;
  source: CatalogComponent | CatalogSpecStandalone;
}

function buildPlan(
  name: string,
  appId: string,
  displayName: string,
  kind: 'standalone' | 'composed',
  spec: CatalogSpecStandalone | CatalogSpecComposed,
  sources: CompSource[],
): AppPlan {
  const multi = sources.length > 1;
  const pod = multi ? `vops-${name}` : undefined;

  // Pass 1: raw components with their own env/secrets and a resolution index.
  const raws = sources.map((s) => rawComponent(name, s.logical, s.source));
  const byLogical = new Map(raws.map((r) => [r.logical, r]));

  // Pass 2: resolve {{components.X.host|env.KEY}} templates across components.
  const components = raws.map((r) => resolveComponent(name, r, byLogical));

  const primary = pickPrimary(components, sources);
  const needsAppDomain = components.some((c) =>
    c.env.some((e) => APP_DOMAIN_TOKEN.test(e.value)),
  );
  APP_DOMAIN_TOKEN.lastIndex = 0; // `g` regex is stateful across .test() calls
  return {
    name,
    appId,
    displayName,
    kind,
    mode: 'rootful',
    pod,
    components,
    primary,
    smokeTest: toSmokeTest('smokeTest' in spec ? spec.smokeTest : undefined),
    domain: toDomain(spec.domain),
    needsAppDomain,
  };
}

/** Whether an install input must be collected on its own. Decoupled from `sensitive` (Secret vs
 * plaintext storage) and defaults to it so existing manifests are unchanged; a group member is never individually required. */
export function inputRequired(p: CatalogUserInputPrompt): boolean {
  if (p.group) return false;
  return p.required ?? !!p.sensitive;
}

function pickPrimary(components: AppComponentPlan[], sources: CompSource[]): string {
  if (components.length === 1) return components[0].name;
  const withHttp = components.find((c) => c.ports.some((p) => p.expose && p.protocol === 'http'));
  if (withHttp) return withHttp.name;
  const exposed = components.find((c) => c.ports.some((p) => p.expose));
  return (exposed ?? components.at(-1)).name;
}

/** Normalize a route path to a leading-slash, no-trailing-slash form (`/` = root). */
export function normalizeRoutePath(path?: string): string {
  const p = (path ?? '/').trim();
  if (!p || p === '/') return '/';
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  let end = withSlash.length;
  while (end > 1 && withSlash.charAt(end - 1) === '/') end -= 1;
  return withSlash.slice(0, end);
}

export function cpuToPodman(cpu?: string): string | undefined {
  if (!cpu) return undefined;
  if (cpu.endsWith('m')) return trimNum(Number.parseInt(cpu, 10) / 1000);
  return trimNum(Number.parseFloat(cpu));
}

export function memToPodman(mem?: string): string | undefined {
  if (!mem) return undefined;
  const m = /^(\d+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(mem.trim());
  if (!m) return undefined;
  const unit = (m[2] ?? '').charAt(0).toLowerCase();
  return `${m[1]}${unit || 'b'}`;
}

function trimNum(n: number): string {
  return Number.parseFloat(n.toFixed(3)).toString();
}

export function sanitize(id: string): string {
  let s = id.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replace(/^-+/, '');
  while (s.endsWith('-')) s = s.slice(0, -1);
  if (!s) throw new NormalizeError(`Cannot derive a valid name from '${id}'.`);
  return s;
}
