import { ResticBinary } from './restic-manifest';

/**
 * Pure renderers for `vops backup` — the exact files/commands vops writes over SSH,
 * all shown by `--dry-run` and all removed by `remove`. The only binary (restic)
 * is downloaded and self-verified on the host against the manifest SHA before it
 * ever runs. No daemon — a cron line runs backup.sh.
 */
export const RESTIC_REMOTE_PATH = '/usr/local/bin/vops-restic';
export const BACKUP_ENV_PATH = '/etc/vops/backup.env';
export const BACKUP_SH_PATH = '/etc/vops/backup.sh';
export const BACKUP_CRON_TAG = 'backup';

export interface BackupEnvConfig {
  repository: string;
  password: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  monitorPingUrl?: string;
}

const KEEP_UNIT: Record<string, string> = {
  h: '--keep-hourly',
  d: '--keep-daily',
  w: '--keep-weekly',
  m: '--keep-monthly',
  y: '--keep-yearly',
};

/** "7d4w6m" → ['--keep-daily','7','--keep-weekly','4','--keep-monthly','6']. */
export function parseKeepPolicy(policy?: string): string[] {
  const flags: string[] = [];
  for (const m of (policy ?? '').matchAll(/(\d+)([hdwmy])/g)) {
    flags.push(KEEP_UNIT[m[2]], m[1]);
  }
  return flags.length ? flags : ['--keep-daily', '7'];
}

export function renderBackupEnv(cfg: BackupEnvConfig): string {
  return [
    '# vops backup — written by `vops backup setup` (0600, root).',
    `export RESTIC_REPOSITORY='${cfg.repository}'`,
    `export RESTIC_PASSWORD='${cfg.password}'`,
    ...(cfg.s3AccessKey ? [`export AWS_ACCESS_KEY_ID='${cfg.s3AccessKey}'`] : []),
    ...(cfg.s3SecretKey ? [`export AWS_SECRET_ACCESS_KEY='${cfg.s3SecretKey}'`] : []),
    ...(cfg.monitorPingUrl ? [`export VOPS_BACKUP_PING='${cfg.monitorPingUrl}'`] : []),
    '',
  ].join('\n');
}

export function renderBackupScript(paths: string[], keepFlags: string[]): string {
  const quotedPaths = paths.map((p) => `'${p}'`).join(' ');
  return [
    '#!/bin/sh',
    '# vops backup wrapper — readable, no daemon. Cron runs this.',
    `. ${BACKUP_ENV_PATH}`,
    'FAIL=0',
    `${RESTIC_REMOTE_PATH} backup --tag vops ${quotedPaths} || FAIL=1`,
    `${RESTIC_REMOTE_PATH} forget --prune ${keepFlags.join(' ')} || true`,
    'if [ "$FAIL" != "0" ] && [ -n "$VOPS_BACKUP_PING" ]; then curl -fsS -m 10 "$VOPS_BACKUP_PING" >/dev/null 2>&1 || true; fi',
    'exit $FAIL',
    '',
  ].join('\n');
}

/**
 * Printed on stderr when the archive cannot be decompressed at all, so the caller
 * can answer with the package to install instead of `bunzip2: command not found`.
 */
export const RESTIC_NO_BZIP2_MARKER = 'VOPS_RESTIC_NO_BZIP2';

const PY_BZ2 = 'import bz2,shutil,sys; shutil.copyfileobj(bz2.open(sys.argv[1],"rb"), open(sys.argv[2],"wb"))';

// Which decompressor to use, decided on the host at runtime: OS family is often
// 'unknown' here, so nothing branches on it — only on what is actually present.
const BZ2_TOOL_FN = [
  'vops_bz2_tool() {',
  '  if command -v bunzip2 >/dev/null 2>&1; then echo bunzip2; return 0; fi',
  '  if command -v bzip2 >/dev/null 2>&1; then echo bzip2; return 0; fi',
  '  if command -v python3 >/dev/null 2>&1; then echo python3; return 0; fi',
  '  if command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx bunzip2; then echo busybox; return 0; fi',
  '  return 1',
  '}',
];

// Last resort only (it mutates the host): every branch is non-interactive and
// idempotent, and apt-get update runs only after an install actually failed.
const BZ2_INSTALL_FN = [
  'vops_install_bz2() {',
  '  if command -v apt-get >/dev/null 2>&1; then',
  '    export DEBIAN_FRONTEND=noninteractive',
  '    if apt-get install -y -qq bzip2 >/dev/null 2>&1; then return 0; fi',
  '    apt-get update -qq >/dev/null 2>&1 || true',
  '    apt-get install -y -qq bzip2 >/dev/null 2>&1',
  '    return',
  '  fi',
  '  if command -v dnf >/dev/null 2>&1; then dnf install -y -q bzip2 >/dev/null 2>&1; return; fi',
  '  if command -v yum >/dev/null 2>&1; then yum install -y -q bzip2 >/dev/null 2>&1; return; fi',
  '  if command -v apk >/dev/null 2>&1; then apk add --no-cache bzip2 >/dev/null 2>&1; return; fi',
  '  return 1',
  '}',
];

const BZ2_DECOMPRESS_FN = [
  'vops_decompress() {',
  '  _t=$(vops_bz2_tool) || _t=""',
  '  if [ -z "$_t" ]; then',
  '    vops_install_bz2 || return 1',
  '    _t=$(vops_bz2_tool) || return 1',
  '  fi',
  '  case "$_t" in',
  '    bunzip2) bunzip2 -f "$1" ;;',
  '    bzip2) bzip2 -d -f "$1" ;;',
  `    python3) python3 -c '${PY_BZ2}' "$1" "$2" && rm -f "$1" ;;`,
  '    busybox) busybox bunzip2 -c "$1" > "$2" && rm -f "$1" ;;',
  '  esac',
  '}',
];

/** Download + SELF-VERIFY (sha256 from the manifest) + install restic on the host. */
export function renderResticInstall(binary: ResticBinary): string {
  return [
    'set -e',
    'tmp=$(mktemp)',
    `curl -fsSL '${binary.url}' -o "$tmp.bz2"`,
    `echo '${binary.sha256}  '"$tmp.bz2" | sha256sum -c - >/dev/null`,
    ...BZ2_TOOL_FN,
    ...BZ2_INSTALL_FN,
    ...BZ2_DECOMPRESS_FN,
    'if ! vops_decompress "$tmp.bz2" "$tmp" || [ ! -s "$tmp" ]; then',
    `  echo '${RESTIC_NO_BZIP2_MARKER}: no bzip2 decompressor on this host and none could be installed' >&2`,
    '  rm -f "$tmp" "$tmp.bz2"',
    '  exit 4',
    'fi',
    'chmod 0755 "$tmp"',
    `mkdir -p "$(dirname '${RESTIC_REMOTE_PATH}')"`,
    `mv "$tmp" '${RESTIC_REMOTE_PATH}'`,
    `${RESTIC_REMOTE_PATH} version`,
  ].join('\n');
}

export function renderBackupCron(schedule: string): string[] {
  return [`${schedule} ${BACKUP_SH_PATH}`];
}

/** What is already sitting at a restore `--target` on the host. `unknown` when the probe
 * could not answer — the plan says so rather than implying an empty directory. */
export type RestoreTargetState = 'missing' | 'empty' | 'not-empty' | 'unknown';

/** restic writes a snapshot into `--target` whatever is already there, so the restore plan has
 * to report the collision before a human approves it. */
export function renderRestoreTargetProbe(target: string): string {
  return [
    `if [ ! -e '${target}' ]; then echo missing;`,
    `elif [ -n "$(ls -A '${target}' 2>/dev/null)" ]; then echo not-empty;`,
    'else echo empty; fi',
  ].join(' ');
}

export function parseRestoreTargetState(stdout: string): RestoreTargetState {
  const last = stdout.trim().split('\n').pop()?.trim();
  return last === 'missing' || last === 'empty' || last === 'not-empty' ? last : 'unknown';
}
