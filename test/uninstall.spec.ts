import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appRemovalGuide } from '../src/service/uninstall-guide';
import { purgePlan, purgeProfile } from '../src/service/purge';

describe('app removal guide', () => {
  it('always points at the browser app list, on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux', 'freebsd'] as NodeJS.Platform[]) {
      const guide = appRemovalGuide(platform);
      expect(guide.steps.length).toBeGreaterThan(0);
      expect(guide.steps.some((s) => s.command === 'chrome://apps')).toBe(true);
    }
  });

  it('adds the native route per platform', () => {
    expect(appRemovalGuide('darwin').steps.map((s) => s.label).join(' ')).toContain('Finder');
    expect(appRemovalGuide('win32').steps.map((s) => s.label).join(' ')).toContain('Settings');
    expect(appRemovalGuide('linux').steps.map((s) => s.label).join(' ')).toContain('applications');
  });
});

describe('purge plan', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-purge-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('only lists what is actually there', () => {
    fs.writeFileSync(path.join(dir, 'hosts.json'), '{}');
    const present = purgePlan(dir, 'default').items.filter((i) => i.exists);
    expect(present).toHaveLength(1);
    expect(present[0].label).toBe('Host inventory');
  });

  it('marks the things that exist nowhere else', () => {
    const plan = purgePlan(dir, 'default');
    const irreplaceable = plan.items.filter((i) => i.irreplaceable).map((i) => path.basename(i.path));
    // These are the ones with no copy anywhere by design — the user must be told
    // in those words, not with a generic "this cannot be undone".
    expect(irreplaceable).toEqual(expect.arrayContaining(['secrets.vault.json', 'keys']));
    expect(plan.items.find((i) => i.path.endsWith('hosts.json'))?.irreplaceable).toBe(false);
  });

  it('deletes the profile data, sidecars included', () => {
    for (const name of ['hosts.json', 'vops.db', 'vops.db-wal', 'vops.db-shm', 'secrets.vault.json']) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }
    fs.mkdirSync(path.join(dir, 'keys'));
    fs.writeFileSync(path.join(dir, 'keys', 'vops-ops'), 'private');

    const res = purgeProfile(dir);
    expect(res.failed).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(res.removed.some((p) => p.endsWith('vops.db-wal'))).toBe(true);
  });

  it('never touches anything outside the profile directory', () => {
    const sibling = path.join(path.dirname(dir), `${path.basename(dir)}-neighbour`);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'hosts.json'), '{}');

    purgeProfile(dir);
    // The delete is driven by an enumerated list, not by rm -rf on a path computed
    // at runtime — a wrong base there would take the user's home with it.
    expect(fs.existsSync(path.join(sibling, 'keep.txt'))).toBe(true);
    fs.rmSync(sibling, { recursive: true, force: true });
  });

  it('is a no-op on an empty profile rather than an error', () => {
    expect(purgeProfile(dir)).toEqual({ removed: [], failed: [] });
  });
});
