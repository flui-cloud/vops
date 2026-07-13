import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { ChannelInput, CloudClient, MonitorHostStatus, MonitorRegistration } from '../lib/cloud-client';
import { assertHostWritable } from '../safety/host-write-gate';
import { OPS_KEY_NAME, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostConnService } from '../host-ops/vops-host-conn.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { removeCronBlock, upsertCronBlock } from '../host-ops/crontab';
import {
  DEFAULT_MONITOR_THRESHOLDS,
  MONITOR_CRON_TAG,
  MONITOR_ENV_PATH,
  MONITOR_SH_PATH,
  MonitorThresholds,
  renderMonitorCron,
  renderMonitorEnv,
  renderMonitorScript,
} from '../host-ops/monitor-steps';

export interface MonitorSetupOpts {
  intervalMin?: number;
  thresholds?: Partial<MonitorThresholds>;
  channels?: ChannelInput[];
  dryRun?: boolean;
}

export interface MonitorSetupDryRun {
  dryRun: true;
  host: string;
  files: Record<string, string>;
  cron: string[];
}
export interface MonitorSetupResult {
  dryRun: false;
  host: string;
  hostId: string;
  interval: number;
  installed: true;
}
export interface MonitorTestResult {
  host: string;
  ran: boolean;
  stderr?: string;
}
export interface MonitorRemoveResult {
  host: string;
  removed: true;
}

/**
 * `host monitor` (CLI side): register the host with the relay, then install a
 * readable POSIX-sh collector + env + crontab block over SSH. The *absence* of
 * heartbeats is what alerts (dead-man switch, relay-side). Everything is text,
 * lives under /etc/vops/, and is fully removed by `remove`.
 */
@Injectable()
export class VopsMonitorService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly conn: VopsHostConnService,
    @Inject('SshExec') private readonly ssh: SshExec,
  ) {}

  async setup(name: string, opts: MonitorSetupOpts = {}): Promise<MonitorSetupDryRun | MonitorSetupResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    const interval = opts.intervalMin ?? 5;
    const thresholds = { ...DEFAULT_MONITOR_THRESHOLDS, ...opts.thresholds };
    const script = renderMonitorScript(thresholds);
    const cron = renderMonitorCron(interval);

    if (opts.dryRun) {
      const env = renderMonitorEnv('<relay-url>', '<host-id>', '<ingest-token>');
      return { dryRun: true, host: name, files: { [MONITOR_SH_PATH]: script, [MONITOR_ENV_PATH]: env }, cron };
    }

    // SSH must work before we touch the relay — fail fast with a clear reason.
    await this.conn.assertReady(name);
    const cloud = new CloudClient();
    const cfg = cloud.config();
    if (!cfg) {
      throw new BadRequestException(
        'Monitoring is the external dead-man switch — it needs the vops relay. Connect one first: vops watch login.',
      );
    }
    // Register with the relay before touching the host, so a relay problem
    // never leaves a half-installed cron behind.
    let reg: MonitorRegistration;
    try {
      reg = await cloud.registerMonitorHost(name, interval * 60, opts.channels);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(
        `The connected relay (${cfg.apiUrl}) can't register a monitored host: ${detail}. ` +
          'It may not support host monitoring yet — check `vops watch login`.',
      );
    }
    const env = renderMonitorEnv(cfg.apiUrl, reg.hostId, reg.ingestToken);

    // If the SSH install fails (host unreachable, no key, …), roll the relay
    // registration back — otherwise the relay has a host that never heartbeats
    // and would false-alert "silent".
    try {
      const target = this.target(host);
      await this.ssh.run(target, 'mkdir -p /etc/vops && chmod 700 /etc/vops');
      await this.ssh.putFile(target, MONITOR_ENV_PATH, env, '0600');
      await this.ssh.putFile(target, MONITOR_SH_PATH, script, '0755');
      const current = await this.ssh.run(target, 'crontab -l 2>/dev/null || true');
      await this.installCron(target, upsertCronBlock(current.stdout, MONITOR_CRON_TAG, cron));
      // Seed one heartbeat so the relay sees the host immediately.
      await this.ssh.run(target, MONITOR_SH_PATH);
    } catch (e) {
      await cloud.removeMonitorHost(reg.hostId).catch(() => undefined);
      const detail = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(
        `Registered with the relay but couldn't install the monitor over SSH: ${detail}. ` +
          'Rolled back — monitoring not enabled. The host must be reachable over SSH from this machine.',
      );
    }

    host.monitorHostId = reg.hostId;
    this.hosts.update(host);
    return { dryRun: false, host: name, hostId: reg.hostId, interval, installed: true };
  }

  async status(name: string): Promise<MonitorHostStatus> {
    const host = this.hosts.show(name);
    if (!host.monitorHostId) throw new BadRequestException(`Monitor not set up on '${name}'.`);
    return new CloudClient().monitorHostStatus(host.monitorHostId);
  }

  async test(name: string): Promise<MonitorTestResult> {
    const host = this.hosts.show(name);
    const res = await this.ssh.run(this.target(host), MONITOR_SH_PATH, { timeoutMs: 30_000 });
    return { host: name, ran: res.code === 0, stderr: res.stderr.trim() || undefined };
  }

  async remove(name: string): Promise<MonitorRemoveResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    const target = this.target(host);
    await this.ssh.run(target, `rm -f '${MONITOR_SH_PATH}' '${MONITOR_ENV_PATH}'`);
    const current = await this.ssh.run(target, 'crontab -l 2>/dev/null || true');
    const { content } = removeCronBlock(current.stdout, MONITOR_CRON_TAG);
    await this.installCron(target, content);
    if (host.monitorHostId) {
      await new CloudClient().removeMonitorHost(host.monitorHostId).catch(() => undefined);
      delete host.monitorHostId;
      this.hosts.update(host);
    }
    return { host: name, removed: true };
  }

  private async installCron(target: SshTarget, content: string): Promise<void> {
    if (!content.trim()) {
      await this.ssh.run(target, 'crontab -r 2>/dev/null || true');
      return;
    }
    // Stage under the login user's HOME (per-user, not world-writable), load, remove.
    const home = (await this.ssh.run(target, 'printf %s "$HOME"')).stdout.trim() || '/root';
    const tmp = `${home}/.vops-crontab`;
    await this.ssh.putFile(target, tmp, content, '0600');
    await this.ssh.run(target, `crontab '${tmp}'; rm -f '${tmp}'`);
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
