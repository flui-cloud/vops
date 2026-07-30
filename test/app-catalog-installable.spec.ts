import { getCatalogEntry, loadCatalog } from '../src/apps/catalog';
import { describeCatalog, listCatalog } from '../src/apps/catalog-view';
import { unavailableNote } from '../src/apps/catalog-installable';
import { checkInstallable } from '../src/apps/spec-normalize';

// An entry vops refuses at plan time (unresolved `dependencies` /
// `linkedBuildingBlocks`) must be MARKED in the listing, not offered as installable
// and discovered to be otherwise only by trying it.
describe('catalog listings carry installability', () => {
  const entries = loadCatalog();

  it('marks every entry with the same verdict app install would reach', () => {
    for (const e of entries) {
      const check = checkInstallable(e.manifest);
      expect(e.installable).toBe(check.ok);
      expect(e.unavailableReason).toBe(check.reason);
    }
  });

  it('flags ferretdb as not installable, naming its missing dependency', () => {
    const ferret = getCatalogEntry('ferretdb')!;
    expect(ferret.installable).toBe(false);
    expect(ferret.unavailableReason).toMatch(/postgresql/);
  });

  it('flags every building-block client the same way', () => {
    for (const id of ['mongo-express', 'redis-commander', 'phpmyadmin', 'pgweb']) {
      const e = getCatalogEntry(id)!;
      expect(e.installable).toBe(false);
      expect(e.unavailableReason).toMatch(/not yet supported on vops/);
    }
  });

  it('leaves installable entries unqualified', () => {
    const tools = getCatalogEntry('it-tools')!;
    expect(tools.installable).toBe(true);
    expect(tools.unavailableReason).toBeUndefined();
  });

  it('carries the flag through the agent listing and describe', () => {
    const listed = [...listCatalog('product'), ...listCatalog('block')].find((e) => e.id === 'ferretdb')!;
    expect(listed.installable).toBe(false);
    expect(listed.unavailableReason).toMatch(/postgresql/);
    expect(listCatalog().every((e) => typeof e.installable === 'boolean')).toBe(true);

    const described = describeCatalog('mongo-express')!;
    expect(described.installable).toBe(false);
    expect(described.unavailableReason).toMatch(/ferretdb/);
  });

  it('renders a footer naming every blocked entry and its reason', () => {
    const note = unavailableNote(entries)!;
    expect(note).toBeTruthy();
    for (const id of ['ferretdb', 'mongo-express', 'pgweb', 'phpmyadmin', 'redis-commander']) {
      expect(note).toContain(id);
    }
    expect(note).toMatch(/postgresql/);
    expect(unavailableNote(entries.filter((e) => e.installable))).toBeNull();
  });
});
