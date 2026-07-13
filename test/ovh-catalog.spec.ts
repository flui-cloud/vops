import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  normalizeOvhCatalog,
  OvhCatalog,
  OvhCatalogResponse,
} from '@flui-cloud/infra';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ovh-catalog.sample.json'), 'utf8'),
) as OvhCatalogResponse;

describe('normalizeOvhCatalog', () => {
  const flavors = normalizeOvhCatalog(fixture);
  const byCode = (c: string) => flavors.find((f) => f.code === c)!;

  it('extracts one flavor per hourly (.consumption) addon (minus denylisted)', () => {
    // fixture has s1-2, b2-7, c3-4, d2-2 as .consumption addons; s1-2 is denylisted
    expect(flavors.map((f) => f.code).sort()).toEqual(['b2-7', 'c3-4', 'd2-2']);
  });

  it('excludes denylisted flavors (legacy s1-* sandbox line)', () => {
    expect(flavors.find((f) => f.code === 's1-2')).toBeUndefined();
  });

  it('converts micro-cent prices to currency units (÷1e8)', () => {
    const b2 = byCode('b2-7');
    expect(b2.hourly).toBeCloseTo(0.0709, 4);
    expect(b2.monthly).toBeCloseTo(25.17, 2);
    expect(b2.currency).toBe('EUR');
  });

  it('pairs hourly with its sibling monthly.postpaid addon', () => {
    expect(byCode('b2-7').monthly).toBeCloseTo(25.17, 2);
  });

  it('marks Gen3 (hourly-only) flavors with null monthly', () => {
    expect(byCode('c3-4').monthly).toBeNull();
    expect(byCode('c3-4').hourly).not.toBeNull();
  });

  it('maps technical specs (cores/ram/disk/storage)', () => {
    const b2 = byCode('b2-7');
    expect(b2.cores).toBe(2);
    expect(b2.ramGb).toBe(7);
    expect(b2.diskGb).toBe(50);
    expect(b2.storageType).toBe('SSD');
    expect(b2.category).toBe('general-purpose');
  });

  it('reads per-flavor region availability when present', () => {
    expect(byCode('b2-7').regions).toContain('GRA1');
    expect(byCode('b2-7').regions.length).toBeGreaterThan(0);
  });

  it('sorts cheapest-hourly first', () => {
    const hourly = flavors.map((f) => f.hourly!).filter((h) => h != null);
    expect([...hourly]).toEqual([...hourly].sort((a, b) => a - b));
  });
});

describe('OvhCatalog with injected fetcher', () => {
  it('normalizes whatever the fetcher returns (no network)', async () => {
    const catalog = new OvhCatalog(async () => fixture);
    const flavors = await catalog.flavors();
    expect(flavors).toHaveLength(3);
    expect(flavors[0].hourly).toBeLessThanOrEqual(flavors[flavors.length - 1].hourly!);
  });
});
