import { SSHD_DROPIN_PATH, SSHD_LEGACY_DROPIN_PATH } from './harden-steps';

/**
 * Pure renderers + parsers for the guarded "disable SSH password login" flow.
 * Side-effect-free so --dry-run and unit tests see exactly what runs on the host.
 *
 * Safety model (why each piece exists):
 *  - A dead-man's switch is ARMED before touching sshd: a timer that strips our
 *    directives and reloads sshd after N minutes UNLESS vops cancels it once a
 *    fresh key-only login is verified. If we lock ourselves out, the box self-heals.
 *  - The whole script runs as ONE root shell (ssh-exec `sudo` option) so a
 *    write→validate→revert sequence can never half-apply.
 *  - Directives go in `00-vops.conf` (sorts first → wins under sshd first-value-wins).
 *  - `sshd -t` validates before reload; reload is verified; either failure strips
 *    our keys and aborts. The caller additionally re-checks `sshd -T` after.
 */

export const DROPIN = SSHD_DROPIN_PATH;
export const LEGACY_DROPIN = SSHD_LEGACY_DROPIN_PATH;
export const DEADMAN_UNIT = 'vops-sshd-deadman';
export const REVERT_SCRIPT = '/etc/vops/sshd-revert.sh';
export const DEFAULT_DEADMAN_MINUTES = 10;

export interface LockdownDirective {
  key: string;
  value: string;
  /** Regex (as a string) the effective `sshd -T` value must match to count as applied. */
  effective: string;
}

/** The one lockdown vops applies: disable password auth for every account (key-only). */
export const PASSWORD_LOCKDOWN: LockdownDirective[] = [
  { key: 'PasswordAuthentication', value: 'no', effective: 'no' },
];

/** Successful password logins grouped by account, busiest first (from journalctl 'Accepted' lines). */
export function parsePasswordLogins(journal: string): Array<{ user: string; count: number }> {
  const byUser = new Map<string, number>();
  for (const line of journal.split('\n')) {
    // "Accepted password for <user> from <ip> port ..." — ignore publickey/invalid-user.
    const m = /Accepted password for (?!invalid )(\S+) from /.exec(line);
    if (m) byUser.set(m[1], (byUser.get(m[1]) ?? 0) + 1);
  }
  return [...byUser.entries()]
    .map(([user, count]) => ({ user, count }))
    .sort((a, b) => b.count - a.count);
}

/** The effective value of a directive from `sshd -T` output (lowercased), or null. */
export function sshdEffectiveValue(sshdT: string, key: string): string | null {
  const k = key.toLowerCase();
  for (const line of sshdT.split('\n')) {
    const [lk, ...rest] = line.trim().split(/\s+/);
    if (lk?.toLowerCase() === k) return rest.join(' ').toLowerCase();
  }
  return null;
}

/** True if every directive's effective value already matches (nothing to do). */
export function alreadyApplied(sshdT: string, directives: LockdownDirective[]): boolean {
  return directives.every((d) => {
    const v = sshdEffectiveValue(sshdT, d.key);
    return v != null && new RegExp(`^${d.effective}$`).test(v);
  });
}

const RELOAD =
  'systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || ' +
  'service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || ' +
  '{ [ -f /run/sshd.pid ] && kill -HUP "$(cat /run/sshd.pid)" 2>/dev/null; } || ' +
  'pkill -HUP -x sshd 2>/dev/null';

function stripKeys(directives: LockdownDirective[]): string {
  return `/^(${directives.map((d) => d.key).join('|')}) /Id`;
}

/** Atomic root script: arm dead-man, write directives, validate, verified reload. */
export function lockdownScript(
  directives: LockdownDirective[],
  minutes: number = DEFAULT_DEADMAN_MINUTES,
): string {
  const del = stripKeys(directives);
  const setLines = directives.map(
    (d) =>
      `if grep -qiE '^${d.key} ' "$F"; then sed -i -E 's|^${d.key} .*|${d.key} ${d.value}|I' "$F"; ` +
      `else echo '${d.key} ${d.value}' >> "$F"; fi`,
  );
  return [
    'set -e',
    `F='${DROPIN}'`,
    `L='${LEGACY_DROPIN}'`,
    'mkdir -p /etc/vops "$(dirname "$F")"',
    // The revert script — shared by the dead-man timer and any immediate rollback.
    `cat > '${REVERT_SCRIPT}' <<'VOPS_REVERT'`,
    '#!/bin/sh',
    `sed -i -E '${del}' '${DROPIN}' '${LEGACY_DROPIN}' 2>/dev/null || true`,
    `${RELOAD} || true`,
    'VOPS_REVERT',
    `chmod +x '${REVERT_SCRIPT}'`,
    // 1) ARM the dead-man BEFORE changing anything.
    'if command -v systemd-run >/dev/null 2>&1; then',
    `  systemctl stop ${DEADMAN_UNIT}.timer 2>/dev/null || true`,
    `  systemd-run --collect --on-active=${minutes}min --unit=${DEADMAN_UNIT} '${REVERT_SCRIPT}' >/dev/null 2>&1 && echo VOPS_DEADMAN=systemd`,
    'else',
    // nohup so it survives the SSH session closing; $! is the sh pid → killing it
    // before the sleep elapses cancels the revert.
    `  nohup sh -c 'sleep ${minutes * 60}; ${REVERT_SCRIPT}' >/dev/null 2>&1 </dev/null & echo "VOPS_DEADMAN=pid:$!"`,
    'fi',
    // 2) write our directives (00- wins); consolidate off any legacy 50- file.
    'touch "$F"',
    `grep -q '^# Managed by vops' "$F" || sed -i '1i # Managed by vops — remove this file to revert.' "$F"`,
    `[ -f "$L" ] && sed -i -E '${del}' "$L" 2>/dev/null || true`,
    ...setLines,
    // 3) validate; on failure strip our keys and abort (dead-man stays armed as backstop).
    `if ! sshd -t 2>/tmp/vops_sshd_err; then sed -i -E '${del}' "$F" 2>/dev/null || true; echo VOPS_SSHDT_FAIL >&2; cat /tmp/vops_sshd_err >&2; exit 3; fi`,
    // 4) verified reload; on failure strip + abort.
    `if ${RELOAD}; then echo VOPS_RELOAD_OK; else sed -i -E '${del}' "$F" 2>/dev/null || true; echo VOPS_RELOAD_FAIL >&2; exit 4; fi`,
    'echo VOPS_APPLIED',
    '',
  ].join('\n');
}

/** Cancel the dead-man after a successful post-apply verify. `pid` set only for the non-systemd fallback. */
export function cancelDeadmanScript(pid?: string): string {
  return [
    `systemctl stop ${DEADMAN_UNIT}.timer 2>/dev/null || true`,
    `systemctl stop ${DEADMAN_UNIT}.service 2>/dev/null || true`,
    `systemctl reset-failed ${DEADMAN_UNIT}.timer ${DEADMAN_UNIT}.service 2>/dev/null || true`,
    ...(pid ? [`kill ${pid} 2>/dev/null || true`] : []),
    `rm -f '${REVERT_SCRIPT}' 2>/dev/null || true`,
    'echo VOPS_DEADMAN_CANCELLED',
    '',
  ].join('\n');
}

/** Immediate rollback (post-apply verify failed): run the revert, then cancel the timer. */
export function revertNowScript(pid?: string): string {
  return [
    `[ -x '${REVERT_SCRIPT}' ] && '${REVERT_SCRIPT}' || true`,
    cancelDeadmanScript(pid).trimEnd(),
    'echo VOPS_REVERTED',
    '',
  ].join('\n');
}

/** Parse the dead-man pid from a lockdown run's stdout (non-systemd fallback). */
export function parseDeadmanPid(stdout: string): string | undefined {
  return /VOPS_DEADMAN=pid:(\d+)/.exec(stdout)?.[1];
}

export interface LockdownSignals {
  /** How vops can gain root to read privileged files / apply. */
  sudo: 'root' | 'ok' | 'no';
  /** `sshd -T` effective config ('' when it couldn't be computed as root). */
  sshdT: string;
  /** Accounts with a successful PASSWORD login in the window, busiest first. */
  passwordLogins: Array<{ user: string; count: number }>;
  /** root has a non-empty authorized_keys (root key login is possible). */
  rootAkPresent: boolean;
  /** systemd-run available (dead-man via a transient timer vs a background sleep). */
  systemdRun: boolean;
}

/** Read-only signal probe (runs as the login user; escalates inline where it must). */
export function lockdownProbeScript(days = 14): string {
  return [
    'if [ "$(id -u)" = 0 ]; then S=""; SUDO=root;',
    'elif sudo -n true 2>/dev/null; then S="sudo -n "; SUDO=ok;',
    'else S=""; SUDO=no; fi',
    'echo ===SUDO===; echo "$SUDO"',
    'echo ===SSHDT===; $S sshd -T 2>/dev/null || true',
    `echo ===PWLOGINS===; { $S journalctl --since '-${days} days' -g 'Accepted password' --no-pager 2>/dev/null; $S grep -h 'Accepted password' /var/log/auth.log /var/log/secure 2>/dev/null; } || true`,
    'echo ===ROOTAK===; $S test -s /root/.ssh/authorized_keys && echo ROOT_AK_PRESENT || echo ROOT_AK_ABSENT',
    'echo ===SYSTEMD===; command -v systemd-run >/dev/null 2>&1 && echo SYSTEMD_RUN || echo NO_SYSTEMD_RUN',
    'echo ===END===',
    '',
  ].join('\n');
}

export function parseLockdownProbe(out: string): LockdownSignals {
  const markers = ['===SUDO===', '===SSHDT===', '===PWLOGINS===', '===ROOTAK===', '===SYSTEMD===', '===END==='];
  const idx = markers.map((m) => out.indexOf(m));
  const section = (i: number): string =>
    idx[i] < 0 || idx[i + 1] < 0 ? '' : out.slice(idx[i] + markers[i].length, idx[i + 1]).trim();
  const sudoRaw = section(0);
  const sudo: LockdownSignals['sudo'] = sudoRaw === 'root' || sudoRaw === 'ok' ? sudoRaw : 'no';
  return {
    sudo,
    sshdT: section(1),
    passwordLogins: parsePasswordLogins(section(2)),
    rootAkPresent: section(3).includes('ROOT_AK_PRESENT'),
    systemdRun: section(4) === 'SYSTEMD_RUN',
  };
}
