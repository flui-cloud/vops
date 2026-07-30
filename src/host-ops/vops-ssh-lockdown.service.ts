import { Inject, Injectable } from '@nestjs/common';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { assertHostWritable } from '../safety/host-write-gate';
import { LocalStore } from '../lib/store/local-store';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { resolveSshTarget } from './ssh-target';
import { hardenBlocked, hardenNotApplied, hardenRolledBack } from './ssh-lockdown-refusal';
import { VopsHostConnService } from './vops-host-conn.service';
import {
  alreadyApplied,
  cancelDeadmanScript,
  DEFAULT_DEADMAN_MINUTES,
  LockdownDirective,
  lockdownProbeScript,
  lockdownScript,
  parseDeadmanPid,
  parseLockdownProbe,
  PASSWORD_LOCKDOWN,
  revertNowScript,
} from './ssh-lockdown';

export interface LockdownRefusal {
  code: string;
  message: string;
}

export interface LockdownPreflight {
  host: string;
  /** Safe to apply with no override. */
  ok: boolean;
  /** Already in effect — applying is a no-op. */
  alreadyHardened: boolean;
  /** The operator's own key authenticates independently of vops's ops key. */
  userKeyVerified: boolean;
  userKeyName?: string;
  passwordLogins: Array<{ user: string; count: number }>;
  refusals: LockdownRefusal[];
  /** The only blockers are override-able (recent password logins) — an explicit confirm can proceed. */
  overridable: boolean;
  deadManMinutes: number;
}

export interface LockdownResult {
  host: string;
  applied: boolean;
  reverted: boolean;
  message: string;
}

/**
 * Guarded "disable SSH password login" — built so it cannot lock the operator out.
 *
 *  preflight → REFUSE (not warn) unless every lockout precondition holds:
 *    the operator's OWN key is proven to log in (not just vops's ops key), no other
 *    account still relies on a password, root keeps a way in, sudo works, and the
 *    effective sshd config is readable.
 *  apply → one atomic root shell that ARMS a dead-man auto-revert first, writes to
 *    the first-sorting drop-in, validates + verified-reloads.
 *  verify → fresh key-only login + effective `sshd -T` equals target; on any failure
 *    it rolls back immediately, and the dead-man reverts anyway if vops can't reconnect.
 */
@Injectable()
export class VopsSshLockdownService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly conn: VopsHostConnService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
  ) {}

  async preflight(name: string): Promise<LockdownPreflight> {
    const host = this.hosts.show(name);
    const directives = PASSWORD_LOCKDOWN;
    const refusals: LockdownRefusal[] = [];

    try {
      await this.conn.assertReady(name);
    } catch {
      refusals.push({ code: 'not-ready', message: `vops can't reach '${name}' over SSH right now — fix the connection first.` });
      return this.result(name, { refusals, alreadyHardened: false, userKeyVerified: false, passwordLogins: [] });
    }

    const probe = await this.ssh
      .runScript(resolveSshTarget(host, this.keys), lockdownProbeScript(), { timeoutMs: 30_000 })
      .catch(() => null);
    const signals = parseLockdownProbe(probe?.stdout ?? '');
    const alreadyHardened = !!signals.sshdT && alreadyApplied(signals.sshdT, directives);
    const userKeyVerified = await this.verifyUserKey(host);

    if (signals.sudo === 'no') {
      refusals.push({ code: 'no-sudo', message: `vops can't become root on '${name}' (sudo -n failed) — it couldn't apply or roll back safely.` });
    }
    if (!signals.sshdT) {
      refusals.push({ code: 'sshd-unreadable', message: `Couldn't read the effective sshd config on '${name}' (needs root) — refusing to change what it can't verify.` });
    }
    if (!userKeyVerified) {
      refusals.push({
        code: host.userKeyName ? 'user-key-unverified' : 'no-user-key',
        message: host.userKeyName
          ? `Your own SSH key didn't authenticate on '${name}'. Fix your key first — otherwise disabling passwords locks you out.`
          : `No personal SSH key is set for '${name}'. Add and verify your key before disabling password login.`,
      });
    }
    if (signals.passwordLogins.length) {
      const who = signals.passwordLogins.map((p) => `${p.user} ×${p.count}`).join(', ');
      refusals.push({ code: 'password-logins', message: `Recent password logins detected (${who}) — disabling password auth locks these accounts out. Confirm to override.` });
    }

    return this.result(name, { refusals, alreadyHardened, userKeyVerified, passwordLogins: signals.passwordLogins, userKeyName: host.userKeyName });
  }

  async disable(name: string, opts: { override?: boolean } = {}): Promise<LockdownResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    const pre = await this.preflight(name);
    if (pre.alreadyHardened) {
      return { host: name, applied: false, reverted: false, message: 'Already hardened — no change.' };
    }
    const blocking = pre.refusals.filter((r) => !(opts.override && r.code === 'password-logins'));
    if (blocking.length) throw hardenBlocked(name, blocking, pre.overridable);

    const directives = PASSWORD_LOCKDOWN;
    const target = resolveSshTarget(host, this.keys);
    const applied = await this.ssh.runScript(target, lockdownScript(directives, pre.deadManMinutes), { timeoutMs: 120_000, sudo: true });
    const pid = parseDeadmanPid(applied.stdout);

    if (applied.code !== 0 || !applied.stdout.includes('VOPS_APPLIED')) {
      await this.cancel(target, pid);
      const reason = applied.stderr.trim() || `apply exited ${applied.code}`;
      throw hardenNotApplied(name, reason);
    }

    const verify = await this.verifyApplied(host, directives);
    if (!verify.ok) {
      await this.ssh.runScript(target, revertNowScript(pid), { timeoutMs: 60_000, sudo: true }).catch(() => undefined);
      throw hardenRolledBack(name, verify.reason ?? 'reason unknown');
    }

    await this.cancel(target, pid);
    await this.store.appendAudit('host.ssh.lockdown', { host: name });
    return { host: name, applied: true, reverted: false, message: LOCKDOWN_MESSAGE };
  }

  private cancel(target: SshTarget, pid?: string): Promise<unknown> {
    return this.ssh.runScript(target, cancelDeadmanScript(pid), { timeoutMs: 30_000, sudo: true }).catch(() => undefined);
  }

  private async verifyUserKey(host: VopsHost): Promise<boolean> {
    const userKeyPath = this.keys.keyPathFor(host.userKeyName);
    if (!userKeyPath) return false;
    const r = await this.ssh.run({ host, keyPath: userKeyPath }, 'true', { timeoutMs: 20_000 }).catch(() => null);
    return !!r && r.code === 0;
  }

  // Post-apply: the operator's key must STILL log in, and the effective config must match.
  private async verifyApplied(host: VopsHost, directives: LockdownDirective[]): Promise<{ ok: boolean; reason?: string }> {
    if (this.keys.keyPathFor(host.userKeyName) && !(await this.verifyUserKey(host))) {
      return { ok: false, reason: 'your key no longer logs in' };
    }
    const probe = await this.ssh
      .runScript(resolveSshTarget(host, this.keys), lockdownProbeScript(), { timeoutMs: 30_000 })
      .catch(() => null);
    const sshdT = probe ? parseLockdownProbe(probe.stdout).sshdT : '';
    if (!sshdT || !alreadyApplied(sshdT, directives)) return { ok: false, reason: "the change didn't take effect" };
    return { ok: true };
  }

  private result(
    name: string,
    parts: {
      refusals: LockdownRefusal[];
      alreadyHardened: boolean;
      userKeyVerified: boolean;
      passwordLogins: Array<{ user: string; count: number }>;
      userKeyName?: string;
    },
  ): LockdownPreflight {
    const overridable = parts.refusals.length > 0 && parts.refusals.every((r) => r.code === 'password-logins');
    return {
      host: name,
      ok: parts.refusals.length === 0,
      alreadyHardened: parts.alreadyHardened,
      userKeyVerified: parts.userKeyVerified,
      userKeyName: parts.userKeyName,
      passwordLogins: parts.passwordLogins,
      refusals: parts.refusals,
      overridable,
      deadManMinutes: DEFAULT_DEADMAN_MINUTES,
    };
  }
}

const LOCKDOWN_MESSAGE = 'Password login disabled — key-only SSH from now on.';
