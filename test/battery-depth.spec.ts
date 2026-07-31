import { buildBatteryScript, parseBattery, splitSections } from '../src/host-ops/status-battery';
import { inChunks } from '../src/lib/chunked';

/** Sections the cheap probe must still produce — everything the charts read. */
const METRICS_SECTIONS = ['rate1', 'rate2', 'disk', 'mem', 'nproc', 'load', 'uptime_s'];

/** The expensive half. Every one of these is either a package-manager dry run, a
 * 24-hour journal scan or a full socket/unit sweep. */
const DEEP_SECTIONS = ['failed', 'oom', 'listen', 'sshcfg', 'logins', 'logins_ok', 'updates', 'reboot', 'fp_etc'];

function sectionsOf(script: string): string[] {
  return [...script.matchAll(/^echo "@@(.+)"$/gm)].map((m) => m[1]).filter((id) => id !== 'end');
}

describe('battery depth', () => {
  it('full runs everything, as before', () => {
    const ids = sectionsOf(buildBatteryScript('debian', 'full'));
    for (const id of [...METRICS_SECTIONS, ...DEEP_SECTIONS]) expect(ids).toContain(id);
  });

  it('defaults to full, so every existing caller is unchanged', () => {
    expect(buildBatteryScript('debian')).toBe(buildBatteryScript('debian', 'full'));
  });

  it('metrics keeps the charted probes and drops the expensive ones', () => {
    const ids = sectionsOf(buildBatteryScript('debian', 'metrics'));
    for (const id of METRICS_SECTIONS) expect(ids).toContain(id);
    for (const id of DEEP_SECTIONS) expect(ids).not.toContain(id);
  });

  it('leaves no journal scan or package dry run in the metrics script', () => {
    const script = buildBatteryScript('debian', 'metrics');
    // These are the lines that cost real money on a server probed every 2 minutes,
    // and the sshd logins of the probe itself would feed the very check it drops.
    expect(script).not.toContain('journalctl');
    expect(script).not.toContain('apt-get');
    expect(script).not.toContain('ss -tlnpH');
    expect(script).not.toContain('systemctl');
  });

  it('drops the deep probes for every OS family, rhel and unknown included', () => {
    for (const family of ['debian', 'rhel', 'unknown'] as const) {
      const script = buildBatteryScript(family, 'metrics');
      expect(script).not.toContain('dnf');
      expect(script).not.toContain('journalctl');
      expect(sectionsOf(script)).toEqual(METRICS_SECTIONS);
    }
  });
});

describe('parsing a partial battery', () => {
  const metricsOutput = [
    '@@rate1',
    '1000.5',
    'cpu  100 0 100 800 0 0 0 0',
    '@@rate2',
    '1001.6',
    'cpu  110 0 110 880 0 0 0 0',
    '@@disk',
    'Filesystem 1024-blocks Used Available Capacity Mounted',
    '/dev/sda1 100 40 60 41% /',
    '@@mem',
    '              total        used        free      shared  buff/cache   available',
    'Mem:    1000000000   400000000   300000000           0   300000000   720000000',
    '@@nproc',
    '6',
    '@@load',
    '0.54 0.40 0.35 1/300 1234',
    '@@uptime_s',
    '2026-07-01 10:00:00',
    '@@end',
  ].join('\n');

  it('reports the charted signals', () => {
    const ids = parseBattery(metricsOutput).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['sys.disk', 'sys.memory', 'sys.load', 'sys.uptime', 'sys.cpu']));
  });

  it('stays silent about checks it never ran, instead of calling them unknown', () => {
    const ids = parseBattery(metricsOutput).map((f) => f.id);
    // The bug this guards: emitting `pkg.updates: Update status unknown` and
    // `sec.sshcfg: hardened` from a probe that asked neither question.
    for (const id of ['pkg.updates', 'pkg.reboot', 'sec.sshcfg', 'sec.logins', 'net.listen', 'svc.failed']) {
      expect(ids).not.toContain(id);
    }
  });

  it('still says "unknown" when a probe ran and answered nothing', () => {
    const findings = parseBattery('@@updates\nunknown\n@@end');
    expect(findings.find((f) => f.id === 'pkg.updates')?.summary).toBe('Update status unknown');
  });

  it('marks every section it ran, even an empty one', () => {
    expect(Object.keys(splitSections('@@listen\n@@end'))).toContain('listen');
  });
});

describe('inChunks', () => {
  it('preserves order and bounds concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await inChunks([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('loses only the item that threw, not its chunk', async () => {
    const out = await inChunks([1, 2, 3, 4], 4, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(out).toEqual([1, null, 3, 4]);
  });
});
