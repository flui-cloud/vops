import { Finding, Severity } from '../lib/report';
import { OsFamily } from '../hosts/host.model';

/**
 * The `host status` battery: one generated shell script (single round-trip, all
 * probes read-only) and pure parsers turning its output into Findings. Kept
 * dependency-free so it is testable against captured debian/rhel fixtures.
 */
export interface BatteryThresholds {
  diskWarn: number;
  diskFail: number;
  memAvailWarnPct: number;
  loadWarnFactor: number;
  loginsWarn: number;
  recentBootSec: number;
}

export const DEFAULT_THRESHOLDS: BatteryThresholds = {
  diskWarn: 85,
  diskFail: 95,
  memAvailWarnPct: 10,
  loadWarnFactor: 2,
  loginsWarn: 50,
  recentBootSec: 3600,
};

const MARK = '@@';

/** Render the read-only probe script for a given OS family. */
export function buildBatteryScript(family: OsFamily): string {
  const { updates, reboot } = familyProbes(family);
  const s = (id: string, cmd: string): string[] => [`echo "${MARK}${id}"`, cmd];
  return [
    'set +e',
    'export LC_ALL=C',
    ...s('disk', 'df -P -x tmpfs -x devtmpfs 2>/dev/null'),
    ...s('mem', 'free -b 2>/dev/null'),
    ...s('nproc', 'nproc 2>/dev/null'),
    ...s('load', 'cat /proc/loadavg 2>/dev/null'),
    ...s('uptime_s', 'uptime -s 2>/dev/null'),
    ...s('failed', 'systemctl --failed --no-legend 2>/dev/null'),
    ...s('oom', "journalctl -k --no-pager -g 'Out of memory' -q 2>/dev/null | tail -n 5"),
    ...s('listen', 'ss -tlnpH 2>/dev/null'),
    ...s('sshcfg', String.raw`sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication)' || grep -Ei '^\s*(PermitRootLogin|PasswordAuthentication)' /etc/ssh/sshd_config 2>/dev/null`),
    ...s('logins', "journalctl -u ssh -u sshd --since -24h -g 'Failed password' -q 2>/dev/null | wc -l"),
    ...s('updates', updates),
    ...s('reboot', reboot),
    ...s('fp_etc', 'ls -1 /etc/vops 2>/dev/null'),
    ...s('fp_cron', "(crontab -l 2>/dev/null; cat /etc/cron.d/vops-* 2>/dev/null) | grep -oE 'vops:(monitor|backup)' 2>/dev/null | sort -u"),
    ...s('fp_ak', "grep -oE 'vops-ops:[a-f0-9]+' ~/.ssh/authorized_keys 2>/dev/null | head -n 1"),
    `echo "${MARK}end"`,
  ].join('\n');
}

function familyProbes(family: OsFamily): { updates: string; reboot: string } {
  const debian = {
    updates: "apt-get -s upgrade 2>/dev/null | awk '/^Inst/{t++} /^Inst/&&/[Ss]ecurity/{s++} END{print (t+0)\" \"(s+0)}'",
    reboot: 'test -f /run/reboot-required && echo yes || echo no',
  };
  const rhel = {
    updates: "echo \"$(dnf -q check-update 2>/dev/null | grep -cE '^[[:alnum:]][^[:space:]]*[[:space:]]') $(dnf -q updateinfo list security 2>/dev/null | grep -cE '^[[:alnum:]]')\"",
    reboot: 'if command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1 && echo no || echo yes; else echo unknown; fi',
  };
  if (family === 'debian') return debian;
  if (family === 'rhel') return rhel;
  // Unknown: try debian tooling (most common), fall back cleanly to "unknown".
  return {
    updates: `if command -v apt-get >/dev/null 2>&1; then ${debian.updates}; elif command -v dnf >/dev/null 2>&1; then ${rhel.updates}; else echo 'unknown'; fi`,
    reboot: `if test -e /run/reboot-required; then echo yes; elif command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1 && echo no || echo yes; else echo unknown; fi`,
  };
}

export function splitSections(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith(MARK)) {
      current = line.slice(MARK.length).trim();
      out[current] = '';
    } else if (current) {
      out[current] += (out[current] ? '\n' : '') + line;
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

const f = (id: string, severity: Severity, summary: string, extra: Partial<Finding> = {}): Finding => ({
  id, severity, summary, ...extra,
});

export function parseBattery(
  stdout: string,
  opts: { thresholds?: BatteryThresholds; now?: number } = {},
): Finding[] {
  const s = splitSections(stdout);
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const now = opts.now ?? Date.now();
  return [
    disk(s.disk ?? '', t),
    memory(s.mem ?? '', t),
    load(s.load ?? '', s.nproc ?? '', t),
    uptime(s.uptime_s ?? '', now, t),
    failedUnits(s.failed ?? ''),
    oom(s.oom ?? ''),
    updates(s.updates ?? ''),
    reboot(s.reboot ?? ''),
    listen(s.listen ?? ''),
    sshcfg(s.sshcfg ?? ''),
    logins(s.logins ?? '', t),
    footprint(s.fp_etc ?? '', s.fp_cron ?? '', s.fp_ak ?? ''),
  ];
}

function diskSeverity(pct: number, t: BatteryThresholds): Severity {
  if (pct > t.diskFail) return 'fail';
  if (pct > t.diskWarn) return 'warn';
  return 'ok';
}

function disk(text: string, t: BatteryThresholds): Finding {
  let worst = { pct: 0, mount: '' };
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const pct = Number(cols[4].replace('%', ''));
    if (Number.isFinite(pct) && pct > worst.pct) worst = { pct, mount: cols[5] };
  }
  const sev = diskSeverity(worst.pct, t);
  return f('sys.disk', sev, sev === 'ok' ? 'Disk usage healthy' : `${worst.mount} at ${worst.pct}%`, {
    value: worst.pct,
  });
}

function memory(text: string, t: BatteryThresholds): Finding {
  const line = text.split('\n').find((l) => l.trim().startsWith('Mem:'));
  if (!line) return f('sys.memory', 'ok', 'Memory unknown');
  const cols = line.trim().split(/\s+/);
  const total = Number(cols[1]);
  const available = Number(cols[cols.length - 1]);
  if (!total || !Number.isFinite(available)) return f('sys.memory', 'ok', 'Memory unknown');
  const pct = Math.round((available / total) * 100);
  const sev: Severity = pct < t.memAvailWarnPct ? 'warn' : 'ok';
  return f('sys.memory', sev, `${pct}% memory available`, { value: pct });
}

function load(loadText: string, nprocText: string, t: BatteryThresholds): Finding {
  const load1 = Number(loadText.trim().split(/\s+/)[0]);
  const cores = Number(nprocText.trim()) || 1;
  if (!Number.isFinite(load1)) return f('sys.load', 'ok', 'Load unknown');
  const sev: Severity = load1 > t.loadWarnFactor * cores ? 'warn' : 'ok';
  return f('sys.load', sev, `load1 ${load1.toFixed(2)} on ${cores} core(s)`, { value: load1 });
}

function uptime(text: string, now: number, t: BatteryThresholds): Finding {
  const since = Date.parse(text.trim().replace(' ', 'T'));
  if (!Number.isFinite(since)) return f('sys.uptime', 'ok', 'Uptime unknown');
  const secs = Math.max(0, Math.round((now - since) / 1000));
  const sev: Severity = secs < t.recentBootSec ? 'info' : 'ok';
  return f('sys.uptime', sev, sev === 'info' ? `Rebooted ${Math.round(secs / 60)} min ago` : 'Uptime nominal');
}

function failedUnits(text: string): Finding {
  const units = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return units.length
    ? f('svc.failed', 'warn', `${units.length} failed unit(s)`, { detail: units.map((u) => u.split(/\s+/)[0]).join(', ') })
    : f('svc.failed', 'ok', 'No failed units');
}

function oom(text: string): Finding {
  const hits = text.split('\n').filter(Boolean);
  return hits.length
    ? f('svc.oom', 'warn', 'OOM kills since boot', { detail: hits[hits.length - 1] })
    : f('svc.oom', 'ok', 'No OOM kills');
}

function updates(text: string): Finding {
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'unknown') return f('pkg.updates', 'info', 'Update status unknown');
  const [total, security] = trimmed.split(/\s+/).map((n) => Number(n) || 0);
  if (security > 0) return f('pkg.updates', 'warn', `${security} security update(s) pending`, { value: security });
  if (total > 0) return f('pkg.updates', 'info', `${total} update(s) pending`, { value: total });
  return f('pkg.updates', 'ok', 'Up to date');
}

function reboot(text: string): Finding {
  const v = text.trim();
  if (v === 'yes') return f('pkg.reboot', 'warn', 'Reboot required');
  if (v === 'unknown' || !v) return f('pkg.reboot', 'info', 'Reboot status unknown');
  return f('pkg.reboot', 'ok', 'No reboot required');
}

/** Ports listening on all interfaces (0.0.0.0/::) — exported for the cross-plane check. */
export function listenPorts(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const isWildcard = local.startsWith('0.0.0.0:') || local.startsWith('*:') || local.startsWith('[::]:') || local.startsWith(':::');
    if (!isWildcard) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (Number.isFinite(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function listen(text: string): Finding {
  const ports = listenPorts(text);
  return ports.length
    ? f('net.listen', 'info', `Listening on ${ports.length} public port(s)`, { detail: ports.join(', ') })
    : f('net.listen', 'ok', 'No public listeners');
}

function sshcfg(text: string): Finding {
  const map: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k) map[k.toLowerCase()] = (v ?? '').toLowerCase();
  }
  const pwAuth = map.passwordauthentication === 'yes';
  const rootPw = map.permitrootlogin === 'yes';
  if (pwAuth || rootPw) {
    const which = [pwAuth ? 'password auth' : '', rootPw ? 'root password login' : ''].filter(Boolean).join(' + ');
    return f('sec.sshcfg', 'warn', `SSH allows ${which}`);
  }
  return f('sec.sshcfg', 'ok', 'SSH login hardened');
}

function logins(text: string, t: BatteryThresholds): Finding {
  const n = Number(text.trim()) || 0;
  const sev: Severity = n > t.loginsWarn ? 'warn' : 'ok';
  return f('sec.logins', sev, sev === 'warn' ? `${n} failed logins in 24h` : 'No login burst', { value: n });
}

function footprint(etc: string, cron: string, ak: string): Finding {
  const pieces = [
    ...(etc ? etc.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => `etc:${x}`) : []),
    ...cron.split('\n').map((x) => x.trim()).filter(Boolean),
    ...(ak ? ['ops-key'] : []),
  ];
  return pieces.length
    ? f('vops.footprint', 'info', 'vops footprint present', { detail: [...new Set(pieces)].join(', ') })
    : f('vops.footprint', 'ok', 'No vops footprint');
}
