/**
 * Pure renderers for `host monitor` (rung 2): a readable POSIX-sh collector and
 * its env file. No daemon, no binary — a cron line runs the script, which POSTs a
 * heartbeat (with alerts[] when thresholds trip) to the relay and always exits 0
 * so cron stays noise-free. Thresholds are baked in at render time.
 */
export interface MonitorThresholds {
  diskWarn: number;
  diskCrit: number;
  loadCrit: number;
}

export const DEFAULT_MONITOR_THRESHOLDS: MonitorThresholds = {
  diskWarn: 85,
  diskCrit: 95,
  loadCrit: 2,
};

export const MONITOR_SH_PATH = '/etc/vops/monitor.sh';
export const MONITOR_ENV_PATH = '/etc/vops/monitor.env';
export const MONITOR_CRON_TAG = 'monitor';

/** The env file (0600): relay URL + per-host ingest token + host id. */
export function renderMonitorEnv(url: string, hostId: string, token: string): string {
  return [
    '# vops monitor — written by `vops host monitor setup` (0600).',
    `VOPS_MON_URL='${url.replace(/\/$/, '')}'`,
    `VOPS_MON_HOST='${hostId}'`,
    `VOPS_MON_TOKEN='${token}'`,
    '',
  ].join('\n');
}

/** The crontab line body for the monitor block (every `intervalMin` minutes). */
export function renderMonitorCron(intervalMin: number): string[] {
  const n = Math.max(1, Math.floor(intervalMin));
  return [`*/${n} * * * * ${MONITOR_SH_PATH}`];
}

export function renderMonitorScript(t: MonitorThresholds = DEFAULT_MONITOR_THRESHOLDS): string {
  return [
    '#!/bin/sh',
    '# vops monitor collector — readable, no daemon. Exits 0 always (cron noise-free).',
    '. ' + MONITOR_ENV_PATH,
    'ALERTS=""',
    'add_alert() { ALERTS="${ALERTS}${ALERTS:+,}{\\"id\\":\\"$1\\",\\"severity\\":\\"$2\\",\\"summary\\":\\"$3\\",\\"value\\":\\"$4\\"}"; }',
    '',
    '# disk (root filesystem)',
    "USE=$(df -P / 2>/dev/null | awk 'NR==2{gsub(\"%\",\"\",$5); print $5+0}')",
    `if [ "\${USE:-0}" -ge ${t.diskCrit} ]; then add_alert disk crit "disk \${USE}% full" "$USE";`,
    `elif [ "\${USE:-0}" -ge ${t.diskWarn} ]; then add_alert disk warn "disk \${USE}% full" "$USE"; fi`,
    '',
    '# memory available %',
    "MA=$(awk '/MemAvailable/{a=$2} /MemTotal/{t=$2} END{if(t>0) printf \"%d\", a*100/t}' /proc/meminfo 2>/dev/null)",
    'if [ "${MA:-100}" -lt 10 ]; then add_alert mem warn "memory ${MA}% available" "$MA"; fi',
    '',
    '# load1 vs threshold',
    "L1=$(awk '{print $1}' /proc/loadavg 2>/dev/null)",
    `if awk "BEGIN{exit !(\${L1:-0} > ${t.loadCrit})}"; then add_alert load crit "load1 \${L1}" "$L1"; fi`,
    '',
    '# failed systemd units',
    'FU=$(systemctl --failed --no-legend 2>/dev/null | wc -l)',
    'if [ "${FU:-0}" -gt 0 ]; then add_alert units warn "${FU} failed unit(s)" "$FU"; fi',
    '',
    '# reboot required',
    'if [ -f /run/reboot-required ]; then add_alert reboot warn "reboot required" "1"; fi',
    '',
    'STATUS=ok; [ -n "$ALERTS" ] && STATUS=alert',
    'AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'BODY="{\\"hostId\\":\\"$VOPS_MON_HOST\\",\\"at\\":\\"$AT\\",\\"status\\":\\"$STATUS\\",\\"alerts\\":[${ALERTS}]}"',
    'curl -fsS -m 10 -X POST \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer $VOPS_MON_TOKEN" \\',
    '  -d "$BODY" "$VOPS_MON_URL/api/monitor/ingest" >/dev/null 2>&1 || true',
    'exit 0',
    '',
  ].join('\n');
}
