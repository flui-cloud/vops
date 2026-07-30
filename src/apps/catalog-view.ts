import { CatalogAppType } from '@flui-cloud/spec';
import { CatalogEntry, loadCatalog } from './catalog';

/** The catalog split the way a coding agent needs it: **products** to install as-is, and
 * **building blocks** to put underneath something else. Both classified from the same bundled manifests. */

export type CatalogKind = 'product' | 'block';

export interface CatalogListing {
  id: string;
  name: string;
  description?: string;
  category: string;
  kind: CatalogKind;
  type: string;
  version: string;
  license?: string;
  tags: string[];
  alternativeTo: string[];
  /** Values the installer will ask for (names and labels only — never values). */
  inputs: Array<{ name: string; label: string; required: boolean; sensitive: boolean }>;
  /** False when `app install` would refuse it at plan time — listed, not offered. */
  installable: boolean;
  /** Why it cannot be installed as-is (present when `installable` is false). */
  unavailableReason?: string;
}

export function kindOf(entry: CatalogEntry): CatalogKind {
  return entry.type === CatalogAppType.BUILDING_BLOCK ? 'block' : 'product';
}

export function listCatalog(kind?: CatalogKind): CatalogListing[] {
  return loadCatalog()
    .filter((e) => !kind || kindOf(e) === kind)
    .map(toListing);
}

export function describeCatalog(id: string): (CatalogListing & { access?: CatalogEntry['access']; links?: CatalogEntry['links'] }) | null {
  const entry = loadCatalog().find((e) => e.id === id);
  if (!entry) return null;
  return { ...toListing(entry), access: entry.access, links: entry.links };
}

function toListing(e: CatalogEntry): CatalogListing {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    category: e.category,
    kind: kindOf(e),
    type: String(e.type),
    version: e.version,
    license: e.license,
    tags: e.tags,
    alternativeTo: e.alternativeTo,
    inputs: e.inputs.map((i) => ({ name: i.name, label: i.label, required: i.required, sensitive: i.sensitive })),
    installable: e.installable,
    ...(e.unavailableReason ? { unavailableReason: e.unavailableReason } : {}),
  };
}
