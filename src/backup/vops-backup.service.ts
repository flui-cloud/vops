import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { ensureVaultUnlocked } from '../lib/keyring/unlock';
import { assertHostWritable } from '../safety/host-write-gate';
import { OPS_KEY_NAME, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { readCrontab, writeCrontab } from '../host-ops/remote-cron';
import { removeCronBlock, upsertCronBlock } from '../host-ops/crontab';
import { resticForArch } from './restic-manifest';
import {
  BACKUP_CRON_TAG,
  BACKUP_ENV_PATH,
  BACKUP_SH_PATH,
  RESTIC_REMOTE_PATH,
  parseKeepPolicy,
  renderBackupCron,
  renderBackupEnv,
  renderBackupScript,
  renderResticInstall,
} from './backup-render';

export interface BackupSetupOpts {
  paths: string[];
  to: string;
  schedule?: string;
  keep?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  dryRun?: boolean;
}

export interface BackupSetupDryRun {
  dryRun: true;
  host: string;
  files: Record<string, string>;
  cron: string[];
  keepFlags: string[];
}
export interface BackupSetupResult {
  dryRun: false;
  host: string;
  installed: true;
  repository: string;
  passwordStoredLocally: true;
  password: string;
  sanityOk: boolean;
}
export interface BackupStatusResult {
  host: string;
  snapshots: number;
  stats: unknown;
}
export interface BackupRunResult {
  host: string;
  ok: boolean;
  stderr?: string;
}
export interface BackupRestoreDryRun {
  dryRun: true;
  host: string;
  command: string;
}
export interface BackupRestoreResult {
  dryRun: false;
  host: string;
  restored: boolean;
  target: string;
  stderr?: string;
}
export interface BackupRemoveResult {
  host: string;
  removed: true;
  repoPurged: boolean;
}

/**
 * `vops backup` — restic over SSH (the rung-3 binary exception). The binary is
 * downloaded + self-verified against the pinned manifest SHA on the host before it
 * runs. The repo password is generated locally AND kept in the profile store, so
 * losing the server never means losing the ability to restore.
 */
@Injectable()
export class VopsBackupService {
  private readonly config = new LocalConfigStore();

  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    @Inject('SshExec') private readonly ssh: SshExec,
  ) {}

  async setup(name: string, opts: BackupSetupOpts): Promise<BackupSetupDryRun | BackupSetupResult> {
    // The repo password is read from (and written to) the profile store, so this
    // is the one backup operation that needs the vault open.
    await ensureVaultUnlocked();
    const host = this.hosts.show(name);
    assertHostWritable(host);
    if (!opts.paths?.length || !opts.to) throw new BadRequestException('--paths and --to are required.');
    const keepFlags = parseKeepPolicy(opts.keep);
    const schedule = opts.schedule ?? '0 3 * * *';
    const password = this.storedPassword(name) ?? randomBytes(24).toString('hex');
    const env = renderBackupEnv({
      repository: opts.to,
      password,
      s3AccessKey: opts.s3AccessKey,
      s3SecretKey: opts.s3SecretKey,
    });
    const script = renderBackupScript(opts.paths, keepFlags);
    const cron = renderBackupCron(schedule);

    if (opts.dryRun) {
      return { dryRun: true, host: name, files: { [BACKUP_ENV_PATH]: env, [BACKUP_SH_PATH]: script }, cron, keepFlags };
    }

    const target = this.target(host);
    const binary = resticForArch((await this.ssh.run(target, 'uname -m')).stdout);
    if (!binary) throw new BadRequestException('Unsupported CPU arch for restic (need amd64/arm64).');
    const install = await this.ssh.runScript(target, renderResticInstall(binary), { timeoutMs: 120_000 });
    if (install.code !== 0) {
      throw new BadRequestException(`restic install/verify failed: ${install.stderr.trim() || 'checksum mismatch'}`);
    }
    await this.ssh.run(target, 'mkdir -p /etc/vops && chmod 700 /etc/vops');
    await this.ssh.putFile(target, BACKUP_ENV_PATH, env, '0600');
    await this.ssh.putFile(target, BACKUP_SH_PATH, script, '0755');
    await writeCrontab(this.ssh, target, upsertCronBlock(await readCrontab(this.ssh, target), BACKUP_CRON_TAG, cron));

    // Persist the recovery material locally, then init the repo + a dry-run sanity pass.
    this.config.setCredentials(`backup-${name}`, {
      repository: opts.to,
      password,
      ...(opts.s3AccessKey ? { s3AccessKey: opts.s3AccessKey } : {}),
      ...(opts.s3SecretKey ? { s3SecretKey: opts.s3SecretKey } : {}),
    });
    await this.restic(target, 'init'); // ignore "already initialized"
    const sanity = await this.restic(target, 'backup --dry-run --tag vops ' + opts.paths.map((p) => `'${p}'`).join(' '));

    return {
      dryRun: false,
      host: name,
      installed: true,
      repository: opts.to,
      passwordStoredLocally: true,
      password,
      sanityOk: sanity.code === 0,
    };
  }

  async status(name: string): Promise<BackupStatusResult> {
    const target = this.target(this.hosts.show(name));
    const snaps = await this.restic(target, 'snapshots --json');
    const count = safeJsonLen(snaps.stdout);
    const stats = await this.restic(target, 'stats --mode raw-data --json');
    return { host: name, snapshots: count, stats: safeJson(stats.stdout) };
  }

  async run(name: string): Promise<BackupRunResult> {
    const res = await this.ssh.run(this.target(this.hosts.show(name)), BACKUP_SH_PATH, { timeoutMs: 3_600_000 });
    return { host: name, ok: res.code === 0, stderr: res.stderr.trim() || undefined };
  }

  async snapshots(name: string): Promise<unknown> {
    const res = await this.restic(this.target(this.hosts.show(name)), 'snapshots --json');
    return safeJson(res.stdout) ?? [];
  }

  async restore(
    name: string,
    opts: { snapshot: string; target: string; dryRun?: boolean },
  ): Promise<BackupRestoreDryRun | BackupRestoreResult> {
    if (!opts.target) throw new BadRequestException('--target directory is required (restore never overwrites in place).');
    const target = this.target(this.hosts.show(name));
    const cmd = `restore '${opts.snapshot}' --target '${opts.target}'${opts.dryRun ? ' --dry-run' : ''}`;
    if (opts.dryRun) return { dryRun: true, host: name, command: `vops-restic ${cmd}` };
    const res = await this.restic(target, cmd);
    return { dryRun: false, host: name, restored: res.code === 0, target: opts.target, stderr: res.stderr.trim() || undefined };
  }

  async remove(name: string, opts: { purgeRepo?: boolean } = {}): Promise<BackupRemoveResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    const target = this.target(host);
    if (opts.purgeRepo) await this.restic(target, 'forget --keep-last 0 --prune').catch(() => undefined);
    await this.ssh.run(target, `rm -f '${RESTIC_REMOTE_PATH}' '${BACKUP_ENV_PATH}' '${BACKUP_SH_PATH}'`);
    await writeCrontab(this.ssh, target, removeCronBlock(await readCrontab(this.ssh, target), BACKUP_CRON_TAG).content);
    return { host: name, removed: true, repoPurged: !!opts.purgeRepo };
  }

  private restic(target: SshTarget, args: string) {
    return this.ssh.run(target, `. ${BACKUP_ENV_PATH} && ${RESTIC_REMOTE_PATH} ${args}`, { timeoutMs: 600_000 });
  }

  private storedPassword(name: string): string | null {
    return this.config.getCredentials(`backup-${name}`)?.password ?? null;
  }

  private target(host: VopsHost): SshTarget {
    if (host.opsKeyInstalled) {
      const ops = this.keys.list().find((k) => k.name === OPS_KEY_NAME && k.hasPrivateKey);
      if (ops) return { host, keyPath: ops.privateKeyPath };
    }
    const userKeyPath = this.keys.keyPathFor(host.userKeyName);
    if (userKeyPath) return { host, keyPath: userKeyPath };
    throw new BadRequestException(`No usable key for host '${host.name}'.`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonLen(text: string): number {
  const parsed = safeJson(text);
  return Array.isArray(parsed) ? parsed.length : 0;
}
