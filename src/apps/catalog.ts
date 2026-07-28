import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '@flui-cloud/spec';
import { inputRequired } from './spec-normalize';
import type {
  CatalogAccess,
  CatalogAccessValue,
  CatalogAppManifest,
  CatalogAppType,
  CatalogEnvVar,
  CatalogLinks,
  CatalogRatings,
} from '@flui-cloud/spec';

/** The bundled flui catalog — `*.flui.yaml` files vendored under `src/apps/catalog/`, so
 * `vops app catalog|install <id>` works offline with zero setup (a proper package extraction is a follow-up). */

/** A user-supplied value the app asks for at install (from env `valueFrom.userInput`). */
export interface CatalogInput {
  name: string;
  label: string;
  description?: string;
  sensitive: boolean;
  /** Must the installer collect a value. Decoupled from `sensitive` (secret storage). */
  required: boolean;
  /** Group id → member of an "at least one of" set (each member individually optional). */
  group?: string;
  default?: string;
  format?: string;
  placeholder?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  confirm?: boolean;
}

/** One credential the user will see after install — `value` is a known non-secret
 * literal safe to preview; `userSet`/`generated` carry only the kind (value is
 * revealed post-deploy, never held pre-install). */
export interface CatalogAccessPart {
  kind: 'value' | 'userSet' | 'generated';
  value?: string;
}

/** A pre-install preview of how you'll sign in, derived from the manifest `access`. */
export interface CatalogAccessSummary {
  mode: 'credentials' | 'firstVisit' | 'none';
  path?: string;
  note?: string;
  username?: CatalogAccessPart;
  password?: CatalogAccessPart;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  category: string;
  appKind?: string;
  type: CatalogAppType;
  version: string;
  license?: string;
  /** Remote icon URL from the manifest (hosted). Dead offline — the UI prefers `iconFile`. */
  icon?: string;
  /** Same-origin path to the vendored icon (`app-icons/<id>.svg`), served offline. */
  iconFile?: string;
  tags: string[];
  ratings?: CatalogRatings;
  alternativeTo: string[];
  links?: CatalogLinks;
  inputs: CatalogInput[];
  /** How you'll sign in after install (for the pre-install preview). */
  access?: CatalogAccessSummary;
  /** Rough expected install time, seconds — paces the optimistic progress bar. */
  estSeconds: number;
  manifest: CatalogAppManifest;
}

function catalogDir(): string {
  // Compiles to lib/apps/catalog.js (__dirname=lib/apps) with the yaml copied
  // alongside; under ts-jest __dirname=src/apps where the yaml lives directly.
  return path.join(__dirname, 'catalog');
}

let cache: CatalogEntry[] | null = null;

export function loadCatalog(): CatalogEntry[] {
  if (cache) return cache;
  const dir = catalogDir();
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.flui.yaml'))
    : [];
  const entries = files
    .map((f) => toEntry(parseYaml(fs.readFileSync(path.join(dir, f), 'utf8'))))
    .filter((e): e is CatalogEntry => e !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  cache = entries;
  return entries;
}

export function getCatalogEntry(id: string): CatalogEntry | null {
  return loadCatalog().find((e) => e.id === id) ?? null;
}

function toEntry(doc: unknown): CatalogEntry | null {
  const m = doc as CatalogAppManifest;
  if (m?.kind !== 'CatalogApp' || !m.metadata?.id) return null;
  const md = m.metadata;
  return {
    id: md.id,
    name: md.name,
    description: md.description,
    category: md.category,
    appKind: md.appKind,
    type: m.spec.type,
    version: md.version,
    license: md.license,
    icon: md.icon,
    iconFile: `app-icons/${md.id}.svg`,
    tags: md.tags ?? [],
    ratings: md.ratings,
    alternativeTo: md.alternativeTo ?? [],
    links: md.links,
    inputs: extractInputs(m),
    access: accessSummary(m),
    estSeconds: estimateInstallSeconds(m),
    manifest: m,
  };
}

/** Classify one access part for the pre-install preview: a known literal, a value
 * the user sets, or a host-generated secret (revealed only after deploy). */
function accessPart(v: CatalogAccessValue | undefined, m: CatalogAppManifest): CatalogAccessPart | undefined {
  if (!v) return undefined;
  if (v.value != null) return { kind: 'value', value: String(v.value) };
  if (!v.fromEnv) return undefined;
  const env = allEnv(m.spec).find((e) => e.name === v.fromEnv);
  const vf = env?.valueFrom;
  if (vf && 'userInput' in vf) return { kind: 'userSet' };
  if (env?.value != null) return { kind: 'value', value: String(env.value) };
  return { kind: 'generated' };
}

/** Manifest `access` block → a pre-install sign-in preview (no plan needed). */
function accessSummary(m: CatalogAppManifest): CatalogAccessSummary | undefined {
  const a = (m.spec as { access?: CatalogAccess }).access;
  if (!a) return undefined;
  const mode = a.mode ?? 'credentials';
  if (mode !== 'credentials') return { mode, path: a.path, note: a.note };
  return { mode, path: a.path, note: a.note, username: accessPart(a.username, m), password: accessPart(a.password, m) };
}

/** A plausible install duration (seconds) to pace the progress bar — image pulls
 * dominate, so it scales with component count and the smoke-test budget. It only
 * tunes pacing: the bar holds at 90% until the real deploy resolves. */
export function estimateInstallSeconds(m: CatalogAppManifest): number {
  const spec = m.spec;
  const comps = 'components' in spec && Array.isArray(spec.components) ? spec.components.length : 1;
  const smoke = (spec as { smokeTest?: { timeoutSeconds?: number } }).smokeTest?.timeoutSeconds ?? 60;
  return Math.min(300, Math.max(30, 20 + comps * 22 + Math.round(smoke * 0.4)));
}

/** Every env var declared by the app, regardless of standalone/composed/building-block shape. */
function allEnv(spec: CatalogAppManifest['spec']): CatalogEnvVar[] {
  const own = 'env' in spec && Array.isArray(spec.env) ? spec.env : [];
  const parts = 'components' in spec && Array.isArray(spec.components)
    ? spec.components.flatMap((c) => c.env ?? [])
    : [];
  return [...own, ...parts];
}

/** The values the installer will prompt for — env with `valueFrom.userInput`. */
function extractInputs(m: CatalogAppManifest): CatalogInput[] {
  return allEnv(m.spec)
    .flatMap((e) => {
      const vf = e.valueFrom;
      if (!vf || !('userInput' in vf)) return [];
      const p = vf.userInput;
      return [{
        name: e.name,
        label: p.label ?? e.name,
        description: e.description ?? p.patternDescription,
        sensitive: !!p.sensitive,
        required: inputRequired(p),
        ...(p.group ? { group: p.group } : {}),
        default: p.default,
        format: p.format,
        placeholder: p.placeholder,
        pattern: p.pattern,
        minLength: p.minLength,
        maxLength: p.maxLength,
        confirm: !!p.confirm,
      }];
    });
}
