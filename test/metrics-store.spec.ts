import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStore } from '../src/lib/store/local-store';
import { MetricsStore } from '../src/lib/store/metrics-store';
import { hostKey, newHostUid } from '../src/lib/store/host-key';
import { RANGES, toGrid, uptimePct } from '../src/lib/store/metrics-buckets';
import { buildReport } from '../src/lib/report';

const HOUR = 3_600;
const DAY = 86_400;

describe('host identity', () => {
  it('prefers the minted uid over anything derivable', () => {
    expect(hostKey({ uid: 'abc', provider: 'hetzner', providerServerId: '1', address: '1.2.3.4', port: 22, name: 'x' }))
      .toBe('u:abc');
  });

  it('survives provider adoption, which would otherwise split the history', () => {
    // ensureFromServer() fills provider + providerServerId on a host added by
    // address. Without a uid the key flips mid-life and the series starts over.
    const before = { uid: 'abc', address: '1.2.3.4', port: 22, name: 'box' };
    const after = { ...before, provider: 'hetzner', providerServerId: '99' };
    expect(hostKey(after)).toBe(hostKey(before));
  });

  it('falls back the way host-forget already ranks identity', () => {
    expect(hostKey({ provider: 'ovh', providerServerId: '7', address: '1.2.3.4', port: 22, name: 'x' })).toBe('p:ovh:7');
    expect(hostKey({ address: '1.2.3.4', port: 2222, name: 'x' })).toBe('a:1.2.3.4:2222');
    expect(hostKey({ address: '', port: 22, name: 'x' })).toBe('n:x');
  });

  it('mints a distinct uid every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newHostUid()));
    expect(ids.size).toBe(200);
  });
});

describe('bucketing', () => {
  it('leaves a hole where nothing was collected', () => {
    const grid = toGrid(
      [
        { bucket: 0, up: 1, cpu: 10, mem: 20, disk: 30, load: 0.5, io: 1 },
        { bucket: 3, up: 1, cpu: 40, mem: 20, disk: 30, load: 0.5, io: 1 },
      ],
      0,
      400,
      100,
    );
    // The gap is the point: a stopped collector must read as no data, not as a
    // straight line joining the two ends.
    expect(grid.series.cpu).toEqual([10, null, null, 40, null]);
    expect(grid.stepSeconds).toBe(100);
  });

  it('reports uptime over the buckets that hold checks, and null when there are none', () => {
    expect(uptimePct([{ bucket: 0, up: 1, cpu: null, mem: null, disk: null, load: null, io: null },
                      { bucket: 1, up: 0, cpu: null, mem: null, disk: null, load: null, io: null }])).toBe(50);
    // Not 0: a host nobody has checked yet is unknown, not down.
    expect(uptimePct([])).toBeNull();
  });

  it('keeps every range between 30 and 100 points', () => {
    for (const [, r] of Object.entries(RANGES)) {
      const points = r.seconds / r.stepSeconds;
      expect(points).toBeGreaterThanOrEqual(30);
      expect(points).toBeLessThanOrEqual(100);
    }
  });
});

describe('MetricsStore', () => {
  let dir: string;
  let local: LocalStore;
  let store: MetricsStore;
  const prevConfig = process.env.VOPS_CONFIG_DIR;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-metrics-'));
    process.env.VOPS_CONFIG_DIR = dir;
    local = new LocalStore();
    store = new MetricsStore(local);
  });

  afterEach(async () => {
    await local.onModuleDestroy();
    if (prevConfig === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function seed(key: string, count: number, stepSeconds: number, from = now - count * stepSeconds): Promise<void> {
    await store.touchHost(key, { name: key }, from);
    for (let i = 0; i < count; i++) {
      await store.record(key, { ts: from + i * stepSeconds, up: 1, cpu: i, mem: 50, disk: 40, load: 0.5, io: 0.1 });
    }
  }

  it('stores and reads back a series', async () => {
    await seed('u:a', 10, 120);
    const h = await store.history('u:a', now - 2 * HOUR, now, 120);
    expect(h.samples).toBe(10);
    expect(h.uptimePct).toBe(100);
    expect(h.series.cpu.filter((v) => v !== null)).toHaveLength(10);
  });

  it('keeps the latest report for one host only, overwriting it', async () => {
    await store.touchHost('u:a', { name: 'box' }, now);
    for (const summary of ['first', 'second']) {
      await store.saveLatest('u:a', {
        ts: now, reachable: true, latencyMs: 42, worst: 'ok', depth: 'full',
        report: buildReport('box', [{ id: 'sys.disk', severity: 'ok', summary }]),
      });
    }
    const [snap] = await store.latest();
    expect(snap.name).toBe('box');
    expect(snap.report.findings[0].summary).toBe('second');
    expect(await store.latest()).toHaveLength(1);
  });

  it('drops samples past the retention window and keeps the rest', async () => {
    await store.touchHost('u:a', { name: 'a' }, now);
    await store.record('u:a', { ts: now - 8 * DAY, up: 1, cpu: 1 });
    await store.record('u:a', { ts: now - 1 * DAY, up: 1, cpu: 2 });

    const res = await store.prune(7, ['u:a']);
    expect(res.samples).toBe(1);
    const h = await store.history('u:a', now - 7 * DAY, now, 7_200);
    expect(h.samples).toBe(1);
  });

  it('removes the history of a host that no longer exists', async () => {
    await seed('u:gone', 3, 120);
    await seed('u:here', 3, 120);
    const res = await store.prune(7, ['u:here']);
    expect(res.hosts).toBe(1);
    expect((await store.history('u:gone', now - DAY, now, 900)).samples).toBe(0);
    expect((await store.history('u:here', now - DAY, now, 900)).samples).toBe(3);
  });

  it('refuses to sweep when the caller could not read the inventory', async () => {
    await seed('u:a', 3, 120);
    // hosts.list() returns [] for an unreadable file. A sweep that trusted that
    // would delete every host's history on one bad read.
    expect((await store.prune(7, null)).hosts).toBe(0);
    expect((await store.prune(7, [])).hosts).toBe(0);
    expect((await store.history('u:a', now - DAY, now, 900)).samples).toBe(3);
  });

  it('sweeps normally once the inventory really is empty of known hosts', async () => {
    // Nothing recorded yet, so an empty live set is not suspicious.
    expect((await store.prune(7, [])).hosts).toBe(0);
  });

  it('moves a history to a new key instead of starting over', async () => {
    await seed('a:1.2.3.4:22', 5, 120);
    await store.rekey('a:1.2.3.4:22', 'u:abc');
    expect((await store.history('u:abc', now - DAY, now, 900)).samples).toBe(5);
    expect((await store.history('a:1.2.3.4:22', now - DAY, now, 900)).samples).toBe(0);
  });

  it('averages a bucket that holds several samples', async () => {
    await store.touchHost('u:a', { name: 'a' }, now);
    const base = now - 600;
    for (const [i, cpu] of [10, 20, 30].entries()) {
      await store.record('u:a', { ts: base + i, up: 1, cpu });
    }
    const h = await store.history('u:a', base - 900, now, 900);
    expect(h.series.cpu.filter((v) => v !== null)).toEqual([20]);
  });

  it('keeps the database readable only by its owner', async () => {
    await seed('u:a', 1, 60);
    const mode = fs.statSync(path.join(dir, 'profiles', 'default', 'vops.db')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
