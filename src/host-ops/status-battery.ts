import { OsFamily } from '../hosts/host.model';
import { QUIET_PAUSE, SNAPSHOT_PROBE } from './rate-metrics';

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

/**
 * How much of the battery to run.
 *
 * `metrics` is the cheap half — two rate snapshots, df, free, nproc, loadavg,
 * uptime. About a second, and nothing on the remote box that anyone would notice.
 * `full` adds the expensive half: a package-manager dry run, two 24-hour journal
 * scans, a socket sweep and the unit/security checks.
 *
 * The split exists because the collector runs on a timer. `full` at that cadence
 * would be a permanent load on every managed server — and, neatly, its own SSH
 * logins would inflate the `sec.logins.ok` reading it is there to report.
 */
export type BatteryDepth = 'metrics' | 'full';

/** Render the read-only probe script for a given OS family. */
export function buildBatteryScript(family: OsFamily, depth: BatteryDepth = 'full'): string {
  const { updates, reboot } = familyProbes(family);
  const s = (id: string, cmd: string): string[] => [`echo "${MARK}${id}"`, cmd];
  // The rate metrics (CPU, disk I/O) come first, from two snapshots around a quiet
  // pause: measuring them across the battery instead would be free but would report
  // the battery's own heavy probes as if they were the host's load.
  const metrics = [
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
  ];
  const deep = [
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
  ];
  return [...metrics, ...(depth === 'full' ? deep : []), `echo "${MARK}end"`].join('\n');
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

// Re-exported so the battery keeps one public surface: callers ask this module
// for the script and for the meaning of its output.
export { parseBattery, listenPorts } from './battery-parsers';
