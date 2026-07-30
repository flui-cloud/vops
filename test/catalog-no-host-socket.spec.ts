import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCatalog, getCatalogEntry } from '../src/apps/catalog';

// An app that needs the container-engine socket cannot be shipped in this catalog.
// The manifest format has no host-path bind, and adding one for a single entry would hand
// the whole host to that app (a :ro mount does not make the podman API read-only). vops
// already reads container logs itself — `vops app logs --host` and /api/apps/:name/logs —
// so dozzle was removed rather than the format growing a root-equivalent capability.
const SNAPSHOT = path.resolve(__dirname, '..', 'src', 'apps', 'catalog');
const ICONS = path.resolve(__dirname, '..', 'src', 'ui', 'assets', 'app-icons');
const SOURCE = path.resolve(__dirname, '..', '..', 'flui-catalog', 'manifests');

const SOCKET_CLAIM = /docker\.sock|podman\.sock|docker socket|container socket|container-engine socket/i;

describe('bundled catalog needs no container-engine socket', () => {
  it('does not ship dozzle — manifest, icon or entry', () => {
    expect(getCatalogEntry('dozzle')).toBeNull();
    expect(loadCatalog().map((e) => e.id)).not.toContain('dozzle');
    expect(fs.existsSync(path.join(SNAPSHOT, 'dozzle.flui.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(ICONS, 'dozzle.svg'))).toBe(false);
  });

  it('no manifest advertises access to the host container engine', () => {
    const offenders = fs
      .readdirSync(SNAPSHOT)
      .filter((f) => f.endsWith('.flui.yaml'))
      .filter((f) => SOCKET_CLAIM.test(fs.readFileSync(path.join(SNAPSHOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

const describeSource = fs.existsSync(SOURCE) ? describe : describe.skip;

describeSource('flui-catalog, the source of truth, dropped it too', () => {
  it('has no dozzle manifest to sync back in', () => {
    expect(fs.existsSync(path.join(SOURCE, 'dozzle.flui.yaml'))).toBe(false);
  });
});
