import { Finding, Severity } from '../lib/report';
import { OsFamily } from '../hosts/host.model';
import { QUIET_PAUSE, SNAPSHOT_PROBE, rateFindings } from './rate-metrics';

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
  // The rate metrics (CPU, disk I/O) come first, from two snapshots around a quiet
  // pause: measuring them across the battery instead would be free but would report
  // the battery's own heavy probes as if they were the host's load.
  return [
    'set +e',
    'export LC_ALL=C',
    ...s('rate1', SNAPSHOT_PROBE),
    QUIET_PAUSE,
    ...s('rate2', SNAPSHOT_PROBE),
    ...s('disk', 'df -P -x tmpfs -x devtmpfs 2>/dev/null'),
    ...s('mem', 'free -b 2>/dev/null'),
    ...s('nproc', 'nproc 2>/dev/null'),
    ...s('load', 'cat /proc/loadavg 2>/dev/null'),
    ...s('uptime_s', 'uptime -s 2>/dev/null'),
    // Per failed unit: "<unit>\t<Result>\t<Description>" — Result + description
    // give the "why" inline. The per-unit `systemctl show` runs only when something
    // is actually failed (free when healthy).
    ...s(
      'failed',
      String.raw`systemctl --failed --no-legend 2>/dev/null | while read -r a b c; do case "$a" in *.*) u=$a;; *) u=$b;; esac; case "$u" in *.*) printf '%s\t%s\t%s\n' "$u" "$(systemctl show -p Result --value "$u" 2>/dev/null)" "$(systemctl show -p Description --value "$u" 2>/dev/null)";; esac; done`,
    ),
    ...s('oom', "journalctl -k --no-pager -g 'Out of memory' -q 2>/dev/null | tail -n 5"),
    ...s('listen', 'ss -tlnpH 2>/dev/null'),
    ...s('sshcfg', String.raw`sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication)' || grep -Ei '^\s*(PermitRootLogin|PasswordAuthentication)' /etc/ssh/sshd_config 2>/dev/null`),
    ...s('logins', "journalctl -u ssh -u sshd --since -24h -g 'Failed password' -q -o cat 2>/dev/null | tail -n 2000"),
    ...s('logins_ok', "journalctl -u ssh -u sshd --since -24h -g 'Accepted' -q -o cat 2>/dev/null | tail -n 2000"),
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
    loginsOk(s.logins_ok ?? ''),
    footprint(s.fp_etc ?? '', s.fp_cron ?? '', s.fp_ak ?? ''),
    ...rateFindings(s.rate1 ?? '', s.rate2 ?? ''),
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

// systemctl --failed prefixes a status glyph (● in UTF-8, * under LC_ALL=C) before
// the unit name — take the first token that actually looks like a unit name.
function unitName(line: string): string {
  return line.trim().split(/\s+/).find((tok) => /^[A-Za-z0-9]/.test(tok)) ?? '';
}

function failedUnits(text: string): Finding {
  const units = text
    .split('\n')
    .map((l) => l.split('\t'))
    .map(([name, result, ...rest]) => ({
      unit: unitName(name ?? ''),
      result: (result ?? '').trim(),
      description: rest.join('\t').trim(),
    }))
    .filter((u) => u.unit);
  if (!units.length) return f('svc.failed', 'ok', 'No failed units');
  const detail = units
    .map((u) => {
      const reason = u.result && u.result !== 'success' ? ` — ${u.result}` : '';
      const desc = u.description ? ` · ${u.description}` : '';
      return `${u.unit}${reason}${desc}`;
    })
    .join('\n');
  return f('svc.failed', 'warn', `${units.length} failed unit(s)`, { detail });
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

interface Listener {
  port: number;
  proc: string;
}

// `ss -tlnpH` rows: State Recv-Q Send-Q Local:Port Peer:Port users:(("proc",…)).
// Keep only wildcard binds (0.0.0.0/::) — those the host offers to any network —
// and pull the program name (needs -p/root; blank otherwise, we degrade to a bare port).
function publicListeners(text: string): Listener[] {
  const byPort = new Map<number, string>();
  for (const line of text.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const isWildcard = local.startsWith('0.0.0.0:') || local.startsWith('*:') || local.startsWith('[::]:') || local.startsWith(':::');
    if (!isWildcard) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!Number.isFinite(port)) continue;
    const proc = /"([^"]+)"/.exec(line)?.[1] ?? '';
    if (!byPort.get(port)) byPort.set(port, proc);
  }
  return [...byPort.entries()].map(([port, proc]) => ({ port, proc })).sort((a, b) => a.port - b.port);
}

/** Public listening ports (0.0.0.0/::) — exported for the cross-plane check. */
export function listenPorts(text: string): number[] {
  return publicListeners(text).map((l) => l.port);
}

function listen(text: string): Finding {
  const ls = publicListeners(text);
  if (!ls.length) return f('net.listen', 'ok', 'Nothing listening beyond localhost');
  const detail = ls.map((l) => (l.proc ? `${l.port} (${l.proc})` : String(l.port))).join(', ');
  // "listening on all interfaces" ≠ "reachable" — a firewall may still block these.
  // The Firewall card reconciles this into actually-reachable vs blocked.
  return f('net.listen', 'info', `Listening on ${ls.length} port(s)`, { detail });
}

function sshcfg(text: string): Finding {
  const map: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k) map[k.toLowerCase()] = (v ?? '').toLowerCase();
  }
  // This check is about *password* login exposure — what "Disable password
  // login" remediates. PasswordAuthentication no closes it for every account,
  // root included, regardless of PermitRootLogin (which then only governs root
  // *key* login). So root-with-password is a risk only while password auth is on.
  if (map.passwordauthentication === 'yes') {
    const rootToo = map.permitrootlogin === 'yes';
    return f('sec.sshcfg', 'warn', `SSH allows password login${rootToo ? ' (root included)' : ''}`);
  }
  return f('sec.sshcfg', 'ok', 'SSH login hardened (key-only)');
}

// Source-IP rollup shared by the failed / successful login checks. Journal lines
// read "… from <ip> port …"; we surface only the IPs (busiest first, ×count), how
// many are distinct, and the event total. `tail -n 2000` upstream bounds transfer.
function loginSummary(lines: string[]): { total: number; capped: boolean; distinct: number; top: string[] } {
  const byIp = new Map<string, number>();
  for (const line of lines) {
    const m = /from (\S+)/.exec(line);
    if (!m) continue;
    byIp.set(m[1], (byIp.get(m[1]) ?? 0) + 1);
  }
  const top = [...byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, c]) => `${ip} ×${c}`);
  return { total: lines.length, capped: lines.length >= 2000, distinct: byIp.size, top };
}

function logins(text: string, t: BatteryThresholds): Finding {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return f('sec.logins', 'ok', 'No failed logins in 24h');
  const { total, capped, distinct, top } = loginSummary(lines);
  const sev: Severity = total > t.loginsWarn ? 'warn' : 'ok';
  return f('sec.logins', sev, `${capped ? '2000+' : total} failed logins from ${distinct} IP(s) · 24h`, { detail: top.join(', ') });
}

function loginsOk(text: string): Finding {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return f('sec.logins.ok', 'ok', 'No successful logins in 24h');
  const { total, capped, distinct, top } = loginSummary(lines);
  return f('sec.logins.ok', 'info', `${capped ? '2000+' : total} logins from ${distinct} IP(s) · 24h`, { detail: top.join(', ') });
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
