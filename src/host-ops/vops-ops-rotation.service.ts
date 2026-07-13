import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LocalStore } from '../lib/store/local-store';
import { profileDir, profileId } from '../lib/profile';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import {
  buildOpsLine,
  classifyRotation,
  extractOptions,
  findOpsLine,
  opsTag,
  removeOpsLine,
  upsertOpsLine,
} from './authorized-keys';
import { pickWorkingTarget, readAuthorizedKeys } from './remote-ak';

export type RotateOutcome = 'rotated' | 'already' | 'planned' | 'failed';

export interface RotateHostResult {
  host: string;
  outcome: RotateOutcome;
  message?: string;
}

export interface RotationReport {
  dryRun: boolean;
  promoted: boolean;
  failed: string[];
  results: RotateHostResult[];
}

/**
 * `ssh-key rotate-ops`: replace the ops key across the fleet without ever removing
 * the last working access path. Per host: APPEND a temp-tagged new line (old key
 * authenticates) → VERIFY the new key → SWAP to a single canonical line in one
 * atomic write → RE-VERIFY before trusting it; any failure rolls back and leaves
 * the host on the old key. The new local key is promoted only after every host
 * succeeds (or with --force), and a stateless ops-key ladder keeps a partially
 * rotated fleet recoverable.
 */
@Injectable()
export class VopsOpsRotationService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
  ) {}

  async rotate(opts: { dryRun?: boolean; force?: boolean } = {}): Promise<RotationReport> {
    const fleet = this.hosts.list().filter((h) => h.opsKeyInstalled);
    if (!fleet.length) {
      throw new BadRequestException('No hosts have the ops key installed. Nothing to rotate.');
    }
    const next = this.keys.ensureNextOpsKey();
    const canonicalTag = opsTag(profileId());
    const tempTag = `${canonicalTag}:next`;
    const lock = this.acquireLock();
    try {
      const results: RotateHostResult[] = [];
      for (const host of fleet) {
        results.push(await this.rotateHost(host, next.privateKeyPath, next.publicKey, canonicalTag, tempTag, opts));
      }
      const failed = results.filter((r) => r.outcome === 'failed').map((r) => r.host);
      let promoted = false;
      if (!opts.dryRun && (failed.length === 0 || opts.force)) {
        this.keys.promoteNextOpsKey();
        promoted = true;
      }
      return { dryRun: !!opts.dryRun, promoted, failed, results };
    } finally {
      this.releaseLock(lock);
    }
  }

  private async rotateHost(
    host: VopsHost,
    nextKeyPath: string,
    nextPub: string,
    canonicalTag: string,
    tempTag: string,
    opts: { dryRun?: boolean },
  ): Promise<RotateHostResult> {
    const userKeyPath = this.keys.keyPathFor(host.userKeyName);
    const ladder = [...this.keys.opsLadder(), ...(userKeyPath ? [userKeyPath] : [])];
    const session = await pickWorkingTarget(this.ssh, host, ladder);
    if (!session) return { host: host.name, outcome: 'failed', message: 'no working ops/user key' };

    const original = await readAuthorizedKeys(this.ssh, session);
    const state = classifyRotation(original.content, canonicalTag, tempTag, nextPub);
    if (state === 'done') return { host: host.name, outcome: 'already', message: 'already on the new key' };
    if (opts.dryRun) return { host: host.name, outcome: 'planned', message: `would rotate (state=${state})` };

    const options = extractOptions(findOpsLine(original.content, canonicalTag) ?? '') || this.keys.opsKeyOptions();
    const nextTarget: SshTarget = { host, keyPath: nextKeyPath };

    if (state !== 'mid') {
      const appended = upsertOpsLine(original.content, buildOpsLine(nextPub, tempTag, options), tempTag).content;
      await this.ssh.putFile(session, original.akPath, appended, '0600');
    }
    const verify = await this.ssh.run(nextTarget, 'true');
    if (verify.code !== 0) {
      const cleaned = removeOpsLine((await readAuthorizedKeys(this.ssh, session)).content, tempTag).content;
      await this.ssh.putFile(session, original.akPath, cleaned, '0600');
      return { host: host.name, outcome: 'failed', message: 'new key did not authenticate; temp line removed' };
    }

    const beforeSwap = await readAuthorizedKeys(this.ssh, session);
    const swapped = swapToCanonical(beforeSwap.content, canonicalTag, tempTag, buildOpsLine(nextPub, canonicalTag, options));
    await this.ssh.putFile(session, beforeSwap.akPath, swapped, '0600');

    const reverify = await this.ssh.run(nextTarget, 'true');
    if (reverify.code !== 0) {
      await this.ssh.putFile(session, original.akPath, original.content, '0600');
      return { host: host.name, outcome: 'failed', message: 'post-swap verify failed; restored old key' };
    }
    await this.store.appendAudit('host.key.rotate-ops', { host: host.name });
    return { host: host.name, outcome: 'rotated' };
  }

  private acquireLock(): string {
    const p = path.join(profileDir(), 'rotate-ops.lock');
    fs.mkdirSync(profileDir(), { recursive: true, mode: 0o700 });
    try {
      fs.closeSync(fs.openSync(p, 'wx'));
      return p;
    } catch {
      throw new BadRequestException(
        'Another rotate-ops is in progress (rotate-ops.lock present). Remove it if stale.',
      );
    }
  }

  private releaseLock(p: string): void {
    try {
      fs.rmSync(p);
    } catch {
      /* already gone */
    }
  }
}

/** One atomic transform: strip temp + old canonical lines, then add the new canonical line. */
function swapToCanonical(
  content: string,
  canonicalTag: string,
  tempTag: string,
  newCanonicalLine: string,
): string {
  const withoutTemp = removeOpsLine(content, tempTag).content;
  const withoutOld = removeOpsLine(withoutTemp, canonicalTag).content;
  return upsertOpsLine(withoutOld, newCanonicalLine, canonicalTag).content;
}
