import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ProviderFactory } from '@flui-cloud/infra';
import { buildReport, Finding, Report } from '../lib/report';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { resolveProvider } from '../lib/providers';
import { OPS_KEY_NAME, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { buildBatteryScript, parseBattery } from './status-battery';
import { cloudPowerFinding, hungGuestFinding, metricFindings } from './cloud-plane';
import { AGENT_REMOTE_PATH, agentFindings } from '../agent/vops-agent.service';

export interface HostStatusResult {
  host: string;
  report: Report;
  latencyMs: number;
  reachable: boolean;
}

const FLEET_CONCURRENCY = 5;

/**
 * `host status` — one SSH session, a fixed battery of read-only probes, a findings
 * report in a few seconds. Authenticates with the ops key when installed, else the
 * host's user key. Fleet mode runs hosts concurrently (bounded).
 */
@Injectable()
export class VopsHostStatusService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly providers: ProviderFactory,
    @Inject('SshExec') private readonly ssh: SshExec,
  ) {}

  async status(name: string): Promise<HostStatusResult> {
    return this.run(this.hosts.show(name));
  }

  async fleet(names?: string[]): Promise<HostStatusResult[]> {
    const hosts = names?.length
      ? names.map((n) => this.hosts.show(n))
      : this.hosts.list();
    const results: HostStatusResult[] = [];
    for (let i = 0; i < hosts.length; i += FLEET_CONCURRENCY) {
      const chunk = hosts.slice(i, i + FLEET_CONCURRENCY);
      results.push(...(await Promise.all(chunk.map((h) => this.run(h)))));
    }
    return results;
  }

  /** Read-only: `systemctl status` + recent journal for one unit, over SSH. */
  async unitLogs(name: string, unit: string, lines = 100): Promise<{ host: string; unit: string; output: string }> {
    const clean = (unit ?? '').trim();
    if (!/^[A-Za-z0-9@._:-]+$/.test(clean)) {
      throw new BadRequestException('Invalid unit name.');
    }
    const n = Math.min(Math.max(Math.trunc(Number(lines)) || 100, 1), 1000);
    const host = this.hosts.show(name);
    const cmd =
      `systemctl status --no-pager -n 0 '${clean}' 2>&1; echo; ` +
      `journalctl -u '${clean}' -n ${n} --no-pager 2>&1`;
    const res = await this.ssh.run(this.target(host), cmd, { timeoutMs: 30_000 });
    return { host: name, unit: clean, output: (res.stdout || res.stderr || '(no output)').trim() };
  }

  private async run(host: VopsHost): Promise<HostStatusResult> {
    const started = Date.now();
    const res = await this.probeSsh(host);
    const cloud = await this.cloudFindings(host);
    const latencyMs = Date.now() - started;
    const reachable = res.stdout.includes('@@disk');
    if (!reachable) {
      const power = cloud.find((f) => f.id === 'cloud.power');
      const hung = power ? hungGuestFinding(String(power.value ?? '')) : null;
      return {
        host: host.name,
        latencyMs,
        reachable: false,
        report: buildReport(host.name, [
          { id: 'ssh.reach', severity: 'fail', summary: `SSH unreachable: ${res.stderr.trim() || 'no response'}` },
          ...(hung ? [hung] : []),
          ...cloud,
        ]),
      };
    }
    return {
      host: host.name,
      latencyMs,
      reachable: true,
      report: buildReport(host.name, [...parseBattery(res.stdout), ...(await this.agentMetrics(host)), ...cloud]),
    };
  }

  /** In-guest metrics from the optional agent, when installed (best-effort). */
  private async agentMetrics(host: VopsHost): Promise<Finding[]> {
    if (!host.agentInstalled) return [];
    try {
      const res = await this.ssh.run(this.target(host), AGENT_REMOTE_PATH, { timeoutMs: 15_000 });
      return res.code === 0 ? agentFindings(JSON.parse(res.stdout)) : [];
    } catch {
      return [];
    }
  }

  private async probeSsh(host: VopsHost): Promise<{ stdout: string; stderr: string }> {
    try {
      const script = buildBatteryScript(host.os?.family ?? 'unknown');
      return await this.ssh.runScript(this.target(host), script, { timeoutMs: 20_000 });
    } catch (err) {
      // No usable key etc. — the SSH plane is simply unavailable; the cloud plane may still speak.
      return { stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Provider/hypervisor-plane findings — agentless, best-effort (needs a token). */
  private async cloudFindings(host: VopsHost): Promise<Finding[]> {
    if (!host.provider || !host.providerServerId) return [];
    try {
      const impl = this.providers.getProvider(resolveProvider(host.provider));
      const status = await impl.getServerStatus(host.providerServerId);
      const findings: Finding[] = [cloudPowerFinding(status)];
      if (typeof impl.getServerMetrics === 'function') {
        const metrics = await impl.getServerMetrics(host.providerServerId);
        if (metrics) findings.push(...metricFindings(metrics));
      }
      return findings;
    } catch {
      return [{ id: 'cloud.power', severity: 'info', summary: 'Provider status unavailable (no token or API error)' }];
    }
  }

  private target(host: VopsHost): SshTarget {
    if (host.opsKeyInstalled) {
      const ops = this.keys.list().find((k) => k.name === OPS_KEY_NAME && k.hasPrivateKey);
      if (ops) return { host, keyPath: ops.privateKeyPath };
    }
    const userKeyPath = this.keys.keyPathFor(host.userKeyName);
    if (userKeyPath) return { host, keyPath: userKeyPath };
    throw new BadRequestException(
      `No usable key for host '${host.name}'. Install the ops key (vops host key install-ops ${host.name}) or set a user key.`,
    );
  }
}
