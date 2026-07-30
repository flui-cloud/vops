import * as fs from 'node:fs';
import * as path from 'node:path';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Finding, Severity } from '../lib/report';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { assertHostWritable } from '../safety/host-write-gate';
import { OPS_KEY_NAME, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { agentArchFor, agentDistDir, loadAgentManifest } from './agent-manifest';
import { agentRunFailure } from './agent-run-error';

export const AGENT_REMOTE_PATH = '/usr/local/bin/vops-agent';

export interface AgentSnapshot {
  cpu?: { cores?: number; usagePercent?: number; load1?: number };
  mem?: { usedPercent?: number; availableBytes?: number };
  disks?: Array<{ mount: string; usedPercent: number }>;
}

export interface AgentInstallResult {
  host: string;
  installed: true;
  agentVersion: string;
  reportedVersion: string;
}
export interface AgentRemoveResult {
  host: string;
  removed: true;
}

/**
 * The optional in-guest metrics agent (a single static Go binary). Installed opt-in
 * over SSH — scp + SHA-256 verify against the build manifest before it runs — for
 * providers whose control-plane exposes no metrics (unlike Hetzner) and minimal
 * images where the shell battery's tools vary. One-shot, no daemon.
 */
@Injectable()
export class VopsAgentService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    @Inject('SshExec') private readonly ssh: SshExec,
  ) {}

  async install(name: string): Promise<AgentInstallResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    const manifest = loadAgentManifest();
    if (!manifest) throw new BadRequestException('Agent not built. Run: sh agent/build.sh');
    const target = this.target(host);
    const arch = agentArchFor((await this.ssh.run(target, 'uname -m')).stdout);
    if (!arch) throw new BadRequestException('Unsupported CPU arch for the agent (need amd64/arm64).');
    const bin = manifest.binaries[arch];
    const localPath = path.join(agentDistDir(), bin.path);
    if (!fs.existsSync(localPath)) throw new BadRequestException(`Agent binary missing (${bin.path}). Run: sh agent/build.sh`);

    // Stage under the login user's HOME (per-user, not world-writable) rather than
    // /tmp — avoids a checksum-verify/move race with other local users on shared hosts.
    const home = (await this.ssh.run(target, 'printf %s "$HOME"')).stdout.trim() || '/root';
    const staged = `${home}/.vops-agent.staged`;
    await this.ssh.putBinary(target, localPath, staged);
    const verify = await this.ssh.run(target, `echo '${bin.sha256}  ${staged}' | sha256sum -c -`);
    if (verify.code !== 0) {
      await this.ssh.run(target, `rm -f '${staged}'`);
      throw new BadRequestException('Agent checksum mismatch — refused to install.');
    }
    await this.ssh.run(target, `mkdir -p "$(dirname '${AGENT_REMOTE_PATH}')"; mv '${staged}' '${AGENT_REMOTE_PATH}'`);
    const version = (await this.ssh.run(target, `${AGENT_REMOTE_PATH} --version`)).stdout.trim();
    host.agentInstalled = true;
    this.hosts.update(host);
    return { host: name, installed: true, agentVersion: manifest.version, reportedVersion: version };
  }

  async remove(name: string): Promise<AgentRemoveResult> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    await this.ssh.run(this.target(host), `rm -f '${AGENT_REMOTE_PATH}'`);
    host.agentInstalled = false;
    this.hosts.update(host);
    return { host: name, removed: true };
  }

  async snapshot(name: string): Promise<AgentSnapshot> {
    const res = await this.ssh.run(this.target(this.hosts.show(name)), AGENT_REMOTE_PATH, { timeoutMs: 15_000 });
    if (res.code !== 0) throw agentRunFailure(name, res);
    return JSON.parse(res.stdout) as AgentSnapshot;
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

/** Pure: map an agent snapshot to host-status findings (agent.* namespace). */
export function agentFindings(s: AgentSnapshot): Finding[] {
  const out: Finding[] = [];
  const cpu = s.cpu?.usagePercent;
  if (cpu !== undefined) {
    out.push({ id: 'agent.cpu', severity: cpu > 90 ? 'warn' : 'ok', summary: `Agent CPU ${cpu}%`, value: cpu });
  }
  const memUsed = s.mem?.usedPercent;
  if (memUsed !== undefined) {
    out.push({ id: 'agent.mem', severity: memUsed > 90 ? 'warn' : 'ok', summary: `Agent memory ${memUsed}% used`, value: memUsed });
  }
  const worst = (s.disks ?? []).reduce<{ mount: string; usedPercent: number } | null>(
    (w, d) => (!w || d.usedPercent > w.usedPercent ? d : w),
    null,
  );
  if (worst) {
    const sev = diskSeverity(worst.usedPercent);
    out.push({ id: 'agent.disk', severity: sev, summary: `Agent ${worst.mount} at ${worst.usedPercent}%`, value: worst.usedPercent });
  }
  return out;
}

function diskSeverity(usedPercent: number): Severity {
  if (usedPercent > 95) return 'fail';
  if (usedPercent > 85) return 'warn';
  return 'ok';
}
