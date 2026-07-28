import * as fs from 'node:fs';
import { parseYaml, validate } from '@flui-cloud/spec';
import type { CatalogAppManifest, FluiManifest } from '@flui-cloud/spec';
import { AppPlan } from './app.model';
import { checkInstallable, normalizeManifest } from './spec-normalize';
import { normalizeApplication } from './application-normalize';

/** What a deploy is made of: a bundled catalog id, or a `flui.yaml` on disk. `CatalogApp` ships a
 * published image; `Application` carries none — its `image` is a deploy-time input, since vops never builds. */
export interface AppSource {
  catalog?: string;
  file?: string;
  /** Image reference for a `kind: Application` manifest. Ignored by catalog apps. */
  image?: string;
}

export interface LoadedPlan {
  plan: AppPlan;
  warnings: string[];
}

export class AppSourceError extends Error {}

export type CatalogLookup = (id: string) => { manifest: CatalogAppManifest } | null;

export function loadAppPlan(source: AppSource, lookup: CatalogLookup, name?: string): LoadedPlan {
  if (source.catalog) {
    const entry = lookup(source.catalog);
    if (!entry) throw new AppSourceError(`Unknown catalog app '${source.catalog}'. List them: vops app catalog`);
    return { plan: fromCatalog(entry.manifest, name), warnings: [] };
  }
  if (!source.file) throw new AppSourceError('Provide a catalog id or a -f flui.yaml file.');
  const doc = readManifest(source.file);
  if (doc.kind === 'Application') {
    return normalizeApplication(doc, { name, image: source.image ?? '' });
  }
  if (doc.kind === 'CatalogApp') return { plan: fromCatalog(doc, name), warnings: [] };
  throw new AppSourceError(`vops deploys kind: Application or CatalogApp (got '${doc.kind}').`);
}

function fromCatalog(manifest: CatalogAppManifest, name?: string): AppPlan {
  const check = checkInstallable(manifest);
  if (!check.ok) throw new AppSourceError(`${manifest.metadata.id}: ${check.reason}`);
  return normalizeManifest(manifest, name);
}

/** Parse + schema-validate a manifest file, or fail with every reason at once. */
/** The registry host an image reference points at, or null for Docker Hub — a first segment
 * counts as a host only when it looks like one (`ghcr.io/me/app` vs `me/app`). */
export function registryHostOf(image: string): string | null {
  const first = image.split('/')[0];
  if (!first || first === image) return null;
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : null;
}

export function readManifest(file: string): FluiManifest {
  if (!fs.existsSync(file)) throw new AppSourceError(`File not found: ${file}`);
  const doc = parseYaml(fs.readFileSync(file, 'utf8'));
  const result = validate(doc);
  if (!result.valid) {
    const detail = result.errors.map((x) => `${x.path} ${x.message}`).join('; ');
    throw new AppSourceError(`Invalid flui.yaml: ${detail}`);
  }
  return result.manifest;
}
