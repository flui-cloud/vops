import {
  buildBatteryScript,
  listenPorts,
  parseBattery,
  splitSections,
} from '../src/host-ops/status-battery';

const SAMPLE = `@@disk
Filesystem 1024-blocks Used Available Capacity Mounted
/dev/sda1 10000000 9600000 400000 96% /
tmpfs 100 0 100 0% /run
@@mem
              total   used   free shared buff/cache available
Mem:        1000000 900000  20000   1000      80000     50000
Swap:        500000      0 500000
@@nproc
2
@@load
5.00 3.00 2.00 1/123 4567
@@uptime_s
2026-07-12 10:00:00
@@failed
nginx.service loaded failed failed A web server
@@oom
@@listen
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1))
LISTEN 0 128 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=2))
LISTEN 0 128 127.0.0.1:6379 0.0.0.0:*
@@sshcfg
permitrootlogin yes
passwordauthentication yes
@@logins
73
@@updates
12 3
@@reboot
yes
@@fp_etc
monitor.sh
@@fp_cron
vops:monitor
@@fp_ak
vops-ops:ab12cd34
@@end
`;

const at = (s: string): number => Date.parse(s.replace(' ', 'T'));

describe('status battery', () => {
  it('renders a per-family probe script with all section markers', () => {
    const script = buildBatteryScript('debian');
    for (const id of ['@@disk', '@@mem', '@@load', '@@sshcfg', '@@updates', '@@reboot', '@@end']) {
      expect(script).toContain(id);
    }
    expect(script).toContain('apt-get -s upgrade');
    expect(buildBatteryScript('rhel')).toContain('dnf');
  });

  it('splits sections by marker', () => {
    const s = splitSections(SAMPLE);
    expect(s.nproc).toBe('2');
    expect(s.reboot).toBe('yes');
    expect(s.updates).toBe('12 3');
  });

  it('extracts wildcard listening ports only', () => {
    const s = splitSections(SAMPLE);
    expect(listenPorts(s.listen)).toEqual([22, 5432]);
  });

  it('parses the battery into findings with the right severities', () => {
    const findings = parseBattery(SAMPLE, { now: at('2026-07-12 10:20:00') });
    const by = Object.fromEntries(findings.map((f) => [f.id, f]));
    expect(by['sys.disk'].severity).toBe('fail'); // 96% > 95
    expect(by['sys.memory'].severity).toBe('warn'); // 5% available
    expect(by['sys.load'].severity).toBe('warn'); // 5.0 > 2*2 cores
    expect(by['sys.uptime'].severity).toBe('info'); // 20 min ago
    expect(by['svc.failed'].severity).toBe('warn');
    expect(by['svc.oom'].severity).toBe('ok');
    expect(by['pkg.updates'].severity).toBe('warn'); // 3 security
    expect(by['pkg.reboot'].severity).toBe('warn');
    expect(by['net.listen'].severity).toBe('info');
    expect(by['net.listen'].detail).toBe('22, 5432');
    expect(by['sec.sshcfg'].severity).toBe('warn');
    expect(by['sec.logins'].severity).toBe('warn'); // 73 > 50
    expect(by['vops.footprint'].severity).toBe('info');
  });

  it('reports healthy findings as ok', () => {
    const healthy = `@@disk
Filesystem 1024-blocks Used Available Capacity Mounted
/dev/sda1 10000000 3000000 7000000 30% /
@@mem
              total   used   free shared buff/cache available
Mem:        1000000 300000 400000    100      300000    600000
@@nproc
4
@@load
0.50 0.40 0.30 1/100 999
@@uptime_s
2026-07-01 00:00:00
@@failed
@@oom
@@listen
LISTEN 0 128 127.0.0.1:22 0.0.0.0:*
@@sshcfg
permitrootlogin prohibit-password
passwordauthentication no
@@logins
0
@@updates
0 0
@@reboot
no
@@fp_etc
@@fp_cron
@@fp_ak
@@end
`;
    const findings = parseBattery(healthy, { now: at('2026-07-12 10:20:00') });
    expect(findings.every((f) => f.severity === 'ok')).toBe(true);
  });
});
