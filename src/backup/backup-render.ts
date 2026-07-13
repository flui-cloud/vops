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

/** Download + SELF-VERIFY (sha256 from the manifest) + install restic on the host. */
export function renderResticInstall(binary: ResticBinary): string {
  return [
    'set -e',
    'tmp=$(mktemp)',
    `curl -fsSL '${binary.url}' -o "$tmp.bz2"`,
    `echo '${binary.sha256}  '"$tmp.bz2" | sha256sum -c - >/dev/null`,
    'bunzip2 -f "$tmp.bz2"',
    'chmod 0755 "$tmp"',
    `mkdir -p "$(dirname '${RESTIC_REMOTE_PATH}')"`,
    `mv "$tmp" '${RESTIC_REMOTE_PATH}'`,
    `${RESTIC_REMOTE_PATH} version`,
  ].join('\n');
}

export function renderBackupCron(schedule: string): string[] {
  return [`${schedule} ${BACKUP_SH_PATH}`];
}
