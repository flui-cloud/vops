import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Finding } from '../lib/report';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { assertHostWritable } from '../safety/host-write-gate';
import { OPS_KEY_NAME, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { renderSshRateLimit } from '../host-firewall/nftables';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost, OsFamily } from '../hosts/host.model';
import { VopsHostKeysService } from './vops-host-keys.service';
import { VopsHostConnService } from './vops-host-conn.service';
import {
  DEFAULT_STEPS,
  RATELIMIT_PATH,
  adminUserScript,
  sshdCheck,
  sshdDirectiveScript,
  timeSyncScript,
  unattendedUpgradesScript,
} from './harden-steps';

export interface HardenResult {
  host: string;
  dryRun: boolean;
  findings: Finding[];
}

/**
 * `host harden` — the first 15 minutes, as idempotent check-then-apply steps.
 * Each is reported as a Finding (ok = already compliant, info = applied, fail =
 * could not apply). The password-lockdown step runs only after a key-based session
 * has been verified in this run (§3.5), and all changes are reversible text under
 * /etc/ssh/sshd_config.d/ and /etc/vops/.
 */
@Injectable()
export class VopsHostHardenService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly hostKeys: VopsHostKeysService,
    private readonly conn: VopsHostConnService,
    @Inject('SshExec') private readonly ssh: SshExec,
  ) {}

  async harden(
    name: string,
    opts: { user?: string; steps?: string[]; dryRun?: boolean } = {},
  ): Promise<HardenResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    const dryRun = !!opts.dryRun;

    // Key-based session up front (the §3.5 precondition that gates the
    // PasswordAuthentication lockdown) — classified, fast-failing.
    await this.conn.assertReady(name);
    const target = this.target(host);

    const family = host.os?.family ?? 'debian';
    const selected = new Set(opts.steps?.length ? opts.steps : DEFAULT_STEPS.map((s) => s.id));
    const findings: Finding[] = [];
    for (const id of DEFAULT_STEPS.map((s) => s.id)) {
      if (!selected.has(id)) continue;
      findings.push(await this.runStep(id, host, target, family, opts.user, dryRun));
    }
    return { host: name, dryRun, findings };
  }

  private async runStep(
    id: string,
    host: VopsHost,
    target: SshTarget,
    family: OsFamily,
    user: string | undefined,
    dryRun: boolean,
  ): Promise<Finding> {
    switch (id) {
      case 'admin-user':
        return this.adminUser(host, target, family, user, dryRun);
      case 'ssh-keys':
        return this.opsKeyStep(host, dryRun);
      case 'ssh-no-root-pw':
        // sshd -T canonicalises `prohibit-password` → `without-password`; accept both.
        return this.sshd(target, id, 'PermitRootLogin', 'prohibit-password', dryRun, '(without-password|prohibit-password)');
      case 'ssh-no-password':
        return this.sshd(target, id, 'PasswordAuthentication', 'no', dryRun);
      case 'unattended-upgrades':
        return this.generic(target, id, null, unattendedUpgradesScript(family), dryRun);
      case 'time-sync':
        return this.generic(
          target,
          id,
          'timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qx yes',
          timeSyncScript(family),
          dryRun,
        );
      case 'ssh-ratelimit':
        return this.rateLimit(target, dryRun);
      default:
        return { id, severity: 'fail', summary: `Unknown step '${id}'` };
    }
  }

  private async adminUser(
    host: VopsHost,
    target: SshTarget,
    family: OsFamily,
    user: string | undefined,
    dryRun: boolean,
  ): Promise<Finding> {
    if (!user) return { id: 'admin-user', severity: 'info', summary: 'Skipped (no --user given)' };
    const uk =
      this.keys.list().find((k) => k.name === host.userKeyName) ??
      this.keys.list().find((k) => k.role === 'user' && k.hasPrivateKey);
    if (!uk) return { id: 'admin-user', severity: 'fail', summary: 'No user key to install for the admin user' };
    const check = `id -u '${user}' >/dev/null 2>&1 && grep -qxF '${uk.publicKey}' "/home/${user}/.ssh/authorized_keys" 2>/dev/null`;
    return this.generic(target, 'admin-user', check, adminUserScript(user, uk.publicKey, family), dryRun);
  }

  private async opsKeyStep(host: VopsHost, dryRun: boolean): Promise<Finding> {
    if (host.opsKeyInstalled) return { id: 'ssh-keys', severity: 'ok', summary: 'Ops key already installed' };
    if (dryRun) return { id: 'ssh-keys', severity: 'info', summary: 'Would install the ops key line' };
    try {
      await this.hostKeys.installOps(host.name);
      return { id: 'ssh-keys', severity: 'info', summary: 'Ops key installed and verified' };
    } catch (err) {
      return { id: 'ssh-keys', severity: 'fail', summary: 'Ops key install failed', detail: msg(err) };
    }
  }

  private sshd(
    target: SshTarget,
    id: string,
    key: string,
    value: string,
    dryRun: boolean,
    checkValue: string = value,
  ): Promise<Finding> {
    return this.generic(target, id, sshdCheck(key.toLowerCase(), checkValue), sshdDirectiveScript(key, value), dryRun);
  }

  private async rateLimit(target: SshTarget, dryRun: boolean): Promise<Finding> {
    const ruleset = renderSshRateLimit();
    const compliant = (await this.ssh.run(target, 'nft list table inet vops_ssh_ratelimit >/dev/null 2>&1 && echo VOPS_OK || true')).stdout.includes('VOPS_OK');
    if (compliant) return { id: 'ssh-ratelimit', severity: 'ok', summary: 'SSH rate-limit already present' };
    if (dryRun) return { id: 'ssh-ratelimit', severity: 'info', summary: 'Would install nftables SSH rate-limit', detail: RATELIMIT_PATH };
    const nft = await this.ssh.run(target, 'command -v nft >/dev/null 2>&1 && echo VOPS_OK || true');
    if (!nft.stdout.includes('VOPS_OK')) {
      return { id: 'ssh-ratelimit', severity: 'fail', summary: 'nft not installed (install nftables first)' };
    }
    await this.ssh.putFile(target, RATELIMIT_PATH, ruleset, '0644');
    const applied = await this.ssh.run(target, `nft -f '${RATELIMIT_PATH}'`);
    return applied.code === 0
      ? { id: 'ssh-ratelimit', severity: 'info', summary: 'SSH rate-limit applied' }
      : { id: 'ssh-ratelimit', severity: 'fail', summary: 'Rate-limit apply failed', detail: applied.stderr.trim() };
  }

  private async generic(
    target: SshTarget,
    id: string,
    checkCmd: string | null,
    applyScript: string,
    dryRun: boolean,
  ): Promise<Finding> {
    if (checkCmd) {
      const chk = await this.ssh.run(target, `${checkCmd} && echo VOPS_OK || true`);
      if (chk.stdout.includes('VOPS_OK')) return { id, severity: 'ok', summary: 'Already compliant' };
    }
    if (dryRun) return { id, severity: 'info', summary: 'Would apply', detail: applyScript };
    const res = await this.ssh.runScript(target, applyScript, { timeoutMs: 120_000 });
    return res.code === 0
      ? { id, severity: 'info', summary: 'Applied' }
      : { id, severity: 'fail', summary: 'Failed to apply', detail: res.stderr.trim() };
  }

  private target(host: VopsHost): SshTarget {
    if (host.opsKeyInstalled) {
      const ops = this.keys.list().find((k) => k.name === OPS_KEY_NAME && k.hasPrivateKey);
      if (ops) return { host, keyPath: ops.privateKeyPath };
    }
    const userKeyPath = this.keys.keyPathFor(host.userKeyName);
    if (userKeyPath) return { host, keyPath: userKeyPath };
    throw new BadRequestException(
      `No usable key for host '${host.name}'. Set a user key (vops host add --key) or install the ops key first.`,
    );
  }
}

function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
