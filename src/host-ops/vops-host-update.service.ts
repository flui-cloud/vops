import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { assertHostWritable } from '../safety/host-write-gate';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { resolveSshTarget } from './ssh-target';
import { LocalStore } from '../lib/store/local-store';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHostConnService } from './vops-host-conn.service';
import { VopsHost, OsFamily } from '../hosts/host.model';

export interface HostUpdateResult {
  host: string;
  applied: boolean;
  rebootRequired: boolean;
  rebooted: boolean;
  summary: string;
  detail?: string;
}

export interface HostRebootResult {
  host: string;
  rebooted: boolean;
  summary: string;
}

/**
 * `host update` — apply OS package updates over SSH. Fleet mode is sequential by
 * default (updates are the one op where blast-radius ordering matters). Always ends
 * with the reboot-required probe; `--reboot` reboots when required, then waits for
 * SSH to return.
 */
@Injectable()
export class VopsHostUpdateService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly conn: VopsHostConnService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
  ) {}

  async update(
    names: string[],
    opts: { securityOnly?: boolean; reboot?: boolean; dryRun?: boolean } = {},
  ): Promise<HostUpdateResult[]> {
    if (!names.length) throw new BadRequestException('No hosts selected.');
    const results: HostUpdateResult[] = [];
    for (const name of names) {
      results.push(await this.updateOne(this.hosts.show(name), opts));
    }
    return results;
  }

  /** `host reboot` — restart the host now and wait for SSH to return. */
  async reboot(names: string[]): Promise<HostRebootResult[]> {
    if (!names.length) throw new BadRequestException('No hosts selected.');
    const results: HostRebootResult[] = [];
    for (const name of names) {
      results.push(await this.rebootOne(this.hosts.show(name)));
    }
    return results;
  }

  private async rebootOne(host: VopsHost): Promise<HostRebootResult> {
    assertHostWritable(host);
    await this.conn.assertReady(host.name);
    const back = await this.rebootAndWait(this.target(host));
    await this.store.appendAudit('host.reboot', { host: host.name });
    return {
      host: host.name,
      rebooted: back,
      summary: back ? 'rebooted' : 'reboot issued — host did not return within 3 min',
    };
  }

  private async updateOne(
    host: VopsHost,
    opts: { securityOnly?: boolean; reboot?: boolean; dryRun?: boolean },
  ): Promise<HostUpdateResult> {
    assertHostWritable(host);
    const target = this.target(host);
    const family = host.os?.family ?? 'debian';
    const script = updateScript(family, !!opts.securityOnly);

    if (opts.dryRun) {
      return { host: host.name, applied: false, rebootRequired: false, rebooted: false, summary: 'dry-run', detail: script };
    }
    await this.conn.assertReady(host.name);
    const res = await this.ssh.runScript(target, script, { timeoutMs: 600_000 });
    const rebootRequired = (await this.ssh.run(target, `${rebootCheck(family)} && echo VOPS_YES || true`)).stdout.includes('VOPS_YES');
    let rebooted = false;
    if (rebootRequired && opts.reboot) {
      rebooted = await this.rebootAndWait(target);
    }
    await this.store.appendAudit('host.update', { host: host.name, securityOnly: !!opts.securityOnly });
    return {
      host: host.name,
      applied: res.code === 0,
      rebootRequired,
      rebooted,
      summary: res.code === 0 ? 'updated' : 'update failed',
      detail: res.code === 0 ? undefined : res.stderr.trim(),
    };
  }

  private async rebootAndWait(target: SshTarget): Promise<boolean> {
    await this.ssh.run(target, 'nohup sh -c "sleep 1; systemctl reboot || reboot" >/dev/null 2>&1 &');
    const deadline = Date.now() + 180_000;
    // Give the host a moment to actually go down before we start polling.
    await delay(15_000);
    while (Date.now() < deadline) {
      const ping = await this.ssh.run(target, 'true', { timeoutMs: 10_000 });
      if (ping.code === 0) return true;
      await delay(5_000);
    }
    return false;
  }

  private target(host: VopsHost): SshTarget {
    return resolveSshTarget(host, this.keys);
  }
}

function updateScript(family: OsFamily, securityOnly: boolean): string {
  if (family === 'debian') {
    const base = 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq';
    return securityOnly
      ? `${base}; unattended-upgrade -v 2>&1 || apt-get -y upgrade`
      : `${base}; apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade`;
  }
  return securityOnly ? 'dnf -y --security upgrade' : 'dnf -y upgrade';
}

const rebootCheck = (family: OsFamily): string =>
  family === 'debian'
    ? 'test -f /run/reboot-required'
    : 'command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
