import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { LocalStore } from '../lib/store/local-store';
import { profileId } from '../lib/profile';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { assertHostWritable } from '../safety/host-write-gate';
import { OPS_KEY_NAME, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHostConnService } from './vops-host-conn.service';
import { VopsHost } from '../hosts/host.model';
import {
  assessRevokeSafety,
  authorizesKeyData,
  opsTag,
  removeOpsLine,
  RevokeSafetyReason,
  upsertOpsLine,
} from './authorized-keys';
import { readAuthorizedKeys } from './remote-ak';

export interface InstallOpsDryRun {
  dryRun: true;
  host: string;
  path: string;
  line: string;
  wouldChange: boolean;
}
export interface InstallOpsResult {
  dryRun: false;
  host: string;
  installed: true;
  alreadyPresent: boolean;
  verified: true;
}
export interface RevokeOpsDryRun {
  dryRun: true;
  host: string;
  path: string;
  wouldRemove: number;
  safe: boolean;
}
export interface RevokeOpsResult {
  dryRun: false;
  host: string;
  revoked: true;
  removed: number;
}
export interface KeyStatusResult {
  host: string;
  path: string;
  opsTagPresent: boolean;
  keys: Array<{ name: string; role: string; authorized: boolean }>;
}

/**
 * The ops-key plane on a host: install/revoke/status of the single tagged
 * authorized_keys line. Every write goes through the host write-gate and the
 * lockout invariants of `authorized-keys.ts` — no command may ever remove the
 * last working access path.
 */
@Injectable()
export class VopsHostKeysService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly conn: VopsHostConnService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
  ) {}

  async installOps(
    name: string,
    opts: { fromCidr?: string; dryRun?: boolean } = {},
  ): Promise<InstallOpsDryRun | InstallOpsResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    const userKeyPath = this.keys.keyPathFor(host.userKeyName);
    if (!userKeyPath) {
      throw new BadRequestException(
        'install-ops needs a usable local user key to bootstrap. Create/import one and set it: vops host add --key <name>.',
      );
    }
    if (!opts.dryRun) await this.conn.assertReady(name);
    const userTarget: SshTarget = { host, keyPath: userKeyPath };
    const opsKey = this.keys.ensureOpsKey();
    const line = this.keys.opsAuthorizedKeysLine(opts.fromCidr);
    const tag = opsTag(profileId());
    const state = await this.readState(userTarget);
    const { content, changed } = upsertOpsLine(state.content, line, tag);

    if (opts.dryRun) {
      return { dryRun: true, host: name, path: state.akPath, line, wouldChange: changed };
    }
    if (changed) await this.ssh.putFile(userTarget, state.akPath, content, '0600');

    const verify = await this.ssh.run({ host, keyPath: opsKey.privateKeyPath }, 'true');
    if (verify.code !== 0) {
      if (changed) await this.ssh.putFile(userTarget, state.akPath, state.content, '0600');
      throw new BadRequestException(
        `Ops key written but the verification session failed (rolled back): ${verify.stderr.trim() || 'auth failed'}`,
      );
    }
    host.opsKeyInstalled = true;
    this.hosts.update(host);
    await this.store.appendAudit('host.key.install-ops', { host: name });
    return { dryRun: false, host: name, installed: true, alreadyPresent: !changed, verified: true };
  }

  async revokeOps(
    name: string,
    opts: { dryRun?: boolean; force?: boolean } = {},
  ): Promise<RevokeOpsDryRun | RevokeOpsResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    const tag = opsTag(profileId());
    const { writeTarget, verifiedUserKey } = await this.revokeTarget(host);
    const state = await this.readState(writeTarget);
    const { content, removed } = removeOpsLine(state.content, tag);
    const { safe, reason } = assessRevokeSafety(state.content, content, tag, verifiedUserKey);
    // A dry run reports; it never refuses — `safe: false` is the answer it was asked for.
    if (opts.dryRun) {
      return { dryRun: true, host: name, path: state.akPath, wouldRemove: removed, safe };
    }
    if (!safe && !opts.force) {
      throw new BadRequestException(revokeRefusal(reason));
    }
    if (removed > 0) await this.ssh.putFile(writeTarget, state.akPath, content, '0600');
    host.opsKeyInstalled = false;
    this.hosts.update(host);
    await this.store.appendAudit('host.key.revoke-ops', { host: name });
    return { dryRun: false, host: name, revoked: true, removed };
  }

  async keyStatus(name: string): Promise<KeyStatusResult> {
    const host = this.hosts.show(name);
    const tag = opsTag(profileId());
    const state = await this.readState(this.readTarget(host));
    const keys = this.keys.list().map((k) => ({
      name: k.name,
      role: k.role,
      authorized: authorizesKeyData(state.content, k.publicKey),
    }));
    return {
      host: name,
      path: state.akPath,
      opsTagPresent: state.content.includes(tag),
      keys,
    };
  }

  /** `verifiedUserKey` is the PUBLIC half of the key that opened the session — which key
   * verified is what decides safety, since it may be the ops key we are about to remove. */
  private async revokeTarget(
    host: VopsHost,
  ): Promise<{ writeTarget: SshTarget; verifiedUserKey: string | null }> {
    const userKey = this.keys.resolveUserKey(host.userKeyName);
    if (userKey?.hasPrivateKey) {
      const target: SshTarget = { host, keyPath: userKey.privateKeyPath };
      const chk = await this.ssh.run(target, 'true');
      if (chk.code === 0) return { writeTarget: target, verifiedUserKey: userKey.publicKey };
    }
    // Fall back to the ops session itself: removing our own line does not drop the live session.
    return { writeTarget: this.opsTarget(host), verifiedUserKey: null };
  }

  private readTarget(host: VopsHost): SshTarget {
    const userKeyPath = this.keys.keyPathFor(host.userKeyName);
    if (userKeyPath) return { host, keyPath: userKeyPath };
    return this.opsTarget(host);
  }

  private opsTarget(host: VopsHost): SshTarget {
    const ops = this.keys.list().find((k) => k.name === OPS_KEY_NAME && k.hasPrivateKey);
    if (!ops) {
      throw new BadRequestException(
        'No local key available for this host (no user key set and no ops key present).',
      );
    }
    return { host, keyPath: ops.privateKeyPath };
  }

  private readState(target: SshTarget) {
    return readAuthorizedKeys(this.ssh, target);
  }
}

function revokeRefusal(reason: RevokeSafetyReason): string {
  const why =
    reason === 'user-key-is-being-removed'
      ? 'the only key that verified is the ops key itself, so removing its line would leave no way in. Give this host its own user key first (vops host key set <host> <key>)'
      : 'the ops key is the only working access and no user key verifies';
  return `Refusing to revoke: ${why}. Re-run with --force to override.`;
}
