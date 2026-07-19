import {
  PROBE_SPECS,
  ProbeId,
  buildInstallScript,
  buildPreflightScript,
  buildProbeScript,
  expectedSeconds,
} from '../src/bench/bench-scripts';

const BARE_TMP = /(?<![\w/])\/tmp\//;

describe('bench scripts — preflight', () => {
  it('emits the four sections and probes tool presence + space', () => {
    const s = buildPreflightScript();
    for (const id of ['@@tools', '@@space', '@@meta', '@@base', '@@end']) {
      expect(s).toContain(id);
    }
    expect(s).toContain('command -v');
    expect(s).toContain('df -Pk /var/tmp');
    expect(s).toContain('systemd-detect-virt');
    expect(s).not.toMatch(BARE_TMP);
  });
});

describe('bench scripts — probes', () => {
  it('every probe has its section markers, a sampler and trap cleanup, never bare /tmp', () => {
    for (const spec of PROBE_SPECS) {
      const s = buildProbeScript(spec.id, 'quick');
      expect(s).toContain(`@@${spec.id}`);
      expect(s).toContain('@@samples');
      expect(s).toContain('@@end');
      expect(s).toContain('trap ');
      expect(s).toContain('/var/tmp/vops-bench');
      expect(s).not.toMatch(BARE_TMP);
    }
  });

  it('fio probes use direct IO, libaio and a file under /var/tmp/vops-bench', () => {
    const s = buildProbeScript('disk.rr4k', 'quick');
    expect(s).toContain('--direct=1');
    expect(s).toContain('--ioengine=libaio');
    expect(s).toContain('--filename=/var/tmp/vops-bench/fio.dat');
    expect(s).toContain('--output-format=json');
    expect(s).toContain('--rw=randread');
    expect(s).toContain('--bs=4k');
    expect(s).toContain('--iodepth=64');
  });

  it('the last disk probe removes the fio file in its trap', () => {
    const last = buildProbeScript('disk.sw1m', 'quick');
    expect(last).toMatch(/trap '[^']*\/var\/tmp\/vops-bench\/fio\.dat[^']*' EXIT/);
    const notLast = buildProbeScript('disk.sr1m', 'quick');
    expect(notLast).not.toMatch(/trap '[^']*fio\.dat[^']*' EXIT/);
  });

  it('keepFio leaves the fio file for the next round but still cleans the sampler', () => {
    const kept = buildProbeScript('disk.sw1m', 'quick', true);
    expect(kept).not.toMatch(/trap '[^']*fio\.dat[^']*' EXIT/);
    expect(kept).toMatch(/trap '[^']*samples-\$\$\.txt[^']*' EXIT/);
    expect(buildProbeScript('disk.sw1m', 'quick', false)).toBe(buildProbeScript('disk.sw1m', 'quick'));
  });

  it('quick vs full change fio runtime + size, 7z passes and openssl seconds', () => {
    const q = buildProbeScript('disk.rr4k', 'quick');
    const f = buildProbeScript('disk.rr4k', 'full');
    expect(q).toContain('--runtime=20');
    expect(q).toContain('--size=512M');
    expect(f).toContain('--runtime=45');
    expect(f).toContain('--size=1G');

    expect(buildProbeScript('disk.sr1m', 'quick')).toContain('--runtime=15');
    expect(buildProbeScript('disk.sr1m', 'full')).toContain('--runtime=30');

    expect(buildProbeScript('cpu.multi', 'quick')).toContain('b 1 ');
    expect(buildProbeScript('cpu.multi', 'full')).not.toContain('b 1 ');
    expect(buildProbeScript('cpu.crypto', 'quick')).toContain('-seconds 1');
    expect(buildProbeScript('cpu.crypto', 'full')).toContain('-seconds 3');
  });

  it('single-thread CPU probe forces -mmt1', () => {
    expect(buildProbeScript('cpu.single', 'quick')).toContain('-mmt1');
    expect(buildProbeScript('cpu.multi', 'quick')).not.toContain('-mmt1');
  });

  it('full runtimes exceed quick for every probe', () => {
    for (const id of PROBE_SPECS.map((p) => p.id) as ProbeId[]) {
      expect(expectedSeconds(id, 'full')).toBeGreaterThanOrEqual(expectedSeconds(id, 'quick'));
    }
  });
});

describe('bench scripts — install per OS family', () => {
  it('picks the right package manager, null on unknown', () => {
    expect(buildInstallScript('debian')).toContain('apt-get');
    expect(buildInstallScript('debian')).toContain('sysbench');
    expect(buildInstallScript('rhel')).toContain('dnf');
    expect(buildInstallScript('alpine')).toContain('apk add');
    expect(buildInstallScript('unknown')).toBeNull();
  });
});
