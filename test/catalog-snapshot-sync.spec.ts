import * as fs from 'node:fs';
import * as path from 'node:path';

// src/apps/catalog is a VENDORED SNAPSHOT: scripts/sync-catalog.js deletes it and
// re-copies ../flui-catalog/manifests wholesale. Any manifest repaired only in the
// snapshot passes every other test and is erased by the next sync, silently. This
// gate makes that drift fail here instead of in production weeks later.
const SOURCE = path.resolve(__dirname, '..', '..', 'flui-catalog', 'manifests');
const SNAPSHOT = path.resolve(__dirname, '..', 'src', 'apps', 'catalog');

const hasSource = fs.existsSync(SOURCE);
const describeSource = hasSource ? describe : describe.skip;

describeSource('vendored catalog snapshot tracks flui-catalog', () => {
  const names = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.flui.yaml')).sort();

  it('has exactly the manifests the source of truth has', () => {
    expect(names(SNAPSHOT)).toEqual(names(SOURCE));
  });

  it('is byte-identical to the source, so a sync is a no-op', () => {
    const drifted = names(SNAPSHOT).filter((f) => {
      const from = path.join(SOURCE, f);
      if (!fs.existsSync(from)) return true;
      return fs.readFileSync(path.join(SNAPSHOT, f), 'utf8') !== fs.readFileSync(from, 'utf8');
    });
    expect(drifted).toEqual([]);
  });
});
