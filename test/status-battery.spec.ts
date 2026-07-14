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
Failed password for root from 218.92.0.1 port 111 ssh2
Failed password for root from 218.92.0.1 port 112 ssh2
Failed password for invalid user admin from 45.9.20.5 port 22 ssh2
@@logins_ok
Accepted publickey for root from 203.0.113.7 port 51886 ssh2: ED25519 SHA256:abc
Accepted password for deploy from 198.51.100.9 port 40001 ssh2
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

  it('names the program behind each public port, IPv6 wildcard included', () => {
    const listen = `@@listen
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))
LISTEN 0 128 [::]:443 [::]:* users:(("nginx",pid=2,fd=6))
LISTEN 0 128 127.0.0.1:6379 0.0.0.0:* users:(("redis",pid=3))
@@end
`;
    const net = parseBattery(listen).find((x) => x.id === 'net.listen');
    expect(net?.summary).toBe('Listening on 2 port(s)');
    expect(net?.detail).toBe('22 (sshd), 443 (nginx)');
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
    expect(by['net.listen'].detail).toBe('22 (sshd), 5432 (postgres)');
    expect(by['sec.sshcfg'].severity).toBe('warn');
    expect(by['sec.logins'].severity).toBe('ok'); // 3 attempts < 50
    expect(by['sec.logins'].summary).toBe('3 failed logins from 2 IP(s) · 24h');
    expect(by['sec.logins'].detail).toBe('218.92.0.1 ×2, 45.9.20.5 ×1');
    expect(by['sec.logins.ok'].severity).toBe('info');
    expect(by['sec.logins.ok'].summary).toBe('2 logins from 2 IP(s) · 24h');
    expect(by['sec.logins.ok'].detail).toBe('203.0.113.7 ×1, 198.51.100.9 ×1');
    expect(by['vops.footprint'].severity).toBe('info');
  });

  it('sec.sshcfg: password auth off is hardened even if root login stays permitted', () => {
    const passwordOffRootKey = `@@sshcfg
permitrootlogin yes
passwordauthentication no
@@end
`;
    const ok = parseBattery(passwordOffRootKey).find((x) => x.id === 'sec.sshcfg');
    expect(ok?.severity).toBe('ok');

    const passwordOn = `@@sshcfg
permitrootlogin yes
passwordauthentication yes
@@end
`;
    const warn = parseBattery(passwordOn).find((x) => x.id === 'sec.sshcfg');
    expect(warn?.severity).toBe('warn');
    expect(warn?.summary).toContain('root included');
  });

  it('rolls up successful logins by source IP, busiest first (IPs only)', () => {
    const s = `@@logins_ok
Accepted publickey for root from 95.246.69.217 port 1 ssh2
Accepted publickey for root from 95.246.69.217 port 2 ssh2
Accepted password for deploy from 203.0.113.7 port 3 ssh2
@@end
`;
    const ok = parseBattery(s).find((x) => x.id === 'sec.logins.ok');
    expect(ok?.severity).toBe('info');
    expect(ok?.summary).toBe('3 logins from 2 IP(s) · 24h');
    expect(ok?.detail).toBe('95.246.69.217 ×2, 203.0.113.7 ×1');
  });

  it('warns on a burst of failed logins and lists the busiest IPs', () => {
    const many = Array.from({ length: 60 }, (_, i) => `Failed password for root from 10.0.0.${i % 3} port ${i} ssh2`).join('\n');
    const found = parseBattery(`@@logins\n${many}\n@@end\n`).find((x) => x.id === 'sec.logins');
    expect(found?.severity).toBe('warn'); // 60 > 50
    expect(found?.summary).toBe('60 failed logins from 3 IP(s) · 24h');
    expect(found?.detail).toBe('10.0.0.0 ×20, 10.0.0.1 ×20, 10.0.0.2 ×20');
  });

  it('reports no successful logins as ok', () => {
    const findings = parseBattery(`@@logins_ok\n@@end\n`);
    const ok = findings.find((x) => x.id === 'sec.logins.ok');
    expect(ok?.severity).toBe('ok');
  });

  it('parses failed units with reason + description, glyph-tolerant', () => {
    const failedSection = `@@failed
* nginx.service\texit-code\tA high performance web server
redis.service\t\tRedis store
@@end
`;
    const failed = parseBattery(failedSection).find((x) => x.id === 'svc.failed');
    expect(failed?.severity).toBe('warn');
    expect(failed?.summary).toBe('2 failed unit(s)');
    expect(failed?.detail).toBe('nginx.service — exit-code · A high performance web server\nredis.service · Redis store');
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
