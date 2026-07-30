/** Installability as the catalog listings report it. An entry vops would refuse at plan time (an
 * unresolved `dependencies` / `linkedBuildingBlocks` declaration) has to be visible as such where
 * it is listed, instead of being offered and discovered only by trying to install it. Plain text on
 * purpose — the commands colour it. */

export interface CatalogInstallability {
  id: string;
  installable: boolean;
  unavailableReason?: string;
}

/** Note naming every listed entry vops cannot install yet, with its reason — `null` when they are
 * all installable, so the usual listing gains nothing. */
export function unavailableNote(rows: CatalogInstallability[]): string | null {
  const blocked = rows.filter((r) => !r.installable);
  if (!blocked.length) return null;
  return [
    `${blocked.length} listed but not installable yet:`,
    ...blocked.map((r) => `  ${r.id} — ${r.unavailableReason ?? 'unavailable on a single vops host'}`),
  ].join('\n');
}
