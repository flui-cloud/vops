import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { assertHostWritable } from '../safety/host-write-gate';
import { LocalStore } from '../lib/store/local-store';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost, VopsHostFirewall, OsFamily } from '../hosts/host.model';
import { VopsFirewallRule } from '../dto/firewall.dto';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { HostFirewallOptions, renderNftables } from '../host-firewall/nftables';
import { parseClientIp } from '../firewall/firewall-services';
import {
  buildForeignFirewall,
  ForeignFirewall,
  foreignProbeScript,
  parseForeignProbe,
} from '../firewall/foreign-firewall';
import { VopsHostConnService } from './vops-host-conn.service';
import { resolveSshTarget } from './ssh-target';
import { resolveNftBin, sudoPrefix } from './nft-exec';

const CONF = '/etc/vops/firewall.nft';
const UNIT = 'vops-firewall.service';
const UNIT_PATH = '/etc/systemd/system/vops-firewall.service';
const TABLE = 'vops_fw';

export interface HostFirewallStatus {
  host: string;
  /** What vops last applied (persisted intent), or null if vops never set it. */
  intended: VopsHostFirewall | null;
  /** The vops nftables table is live on the host right now. */
  active: boolean;
  /** Survives reboot (boot-time unit installed). */
  persistent: boolean;
  /** SSH port kept permanently open by the managed engine. */
  sshPort: number;
}

/**
 * Managed host firewall (nftables engine) for providers WITHOUT a usable native
 * firewall (Contabo, OVH) and BYOS hosts. Applies portable `VopsFirewallRule`s
 * over SSH and persists the intent per host.
 *
 * Safety design:
 *  - Lock-out-proof by construction: the SSH port is always kept open to the world
 *    (`sshAlwaysOpen`), so a bad rule can never cut the operator off.
 *  - Owns ONLY the `vops_fw` table (no `flush ruleset`) and lives under /etc/vops +
 *    a dedicated boot unit — it never touches /etc/nftables.conf or other tables.
 *  - `nft -f` failure is surfaced (not swallowed); `clear` refuses on a host vops
 *    never applied to, so it can't wipe someone's own firewall.
 */
@Injectable()
export class VopsHostFirewallService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly conn: VopsHostConnService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
  ) {}

  async status(name: string): Promise<HostFirewallStatus> {
    const host = this.hosts.show(name);
    const probeable = host.conn?.state === 'ready' || host.opsKeyInstalled || !!host.userKeyName;
    const probe = probeable
      ? await this.probe(host).catch(() => ({ active: false, persistent: false }))
      : { active: false, persistent: false };
    return { host: name, intended: host.firewall ?? null, active: probe.active, persistent: probe.persistent, sshPort: host.port ?? 22 };
  }

  async apply(
    name: string,
    rules: VopsFirewallRule[],
    opts: { policy?: 'drop' | 'accept' } = {},
  ): Promise<HostFirewallStatus> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    await this.conn.assertReady(name);
    const target = resolveSshTarget(host, this.keys);
    const sudo = sudoPrefix(host);
    const nftBin = await this.ensureNft(target, host.os?.family ?? 'debian', sudo);

    const policy = opts.policy ?? 'drop';
    // SSH is always kept open on this engine → drop any explicit SSH rule so the
    // persisted/displayed intent can't falsely claim SSH is source-restricted.
    const clean = rules.filter((r) => !isManagedSshRule(r, host.port ?? 22));
    const ruleset = renderNftables(clean, this.renderOpts(host, policy)); // throws on a malformed port → fail closed
    const res = await this.ssh.runScript(target, applyScript(sudo, ruleset, nftBin), { timeoutMs: 300_000 });
    if (res.code !== 0) {
      const reason = res.stderr.trim() || `nft -f exited ${res.code}`;
      throw new BadRequestException(`Firewall apply failed: ${reason}`);
    }
    host.firewall = { rules: clean, policy, appliedAt: new Date().toISOString() };
    this.hosts.update(host);
    await this.store.appendAudit('host.firewall.apply', {
      host: name, ruleCount: rules.length, policy, persistent: res.stdout.includes('VOPS_PERSIST_SYSTEMD'),
    });
    return this.status(name);
  }

  async clear(name: string): Promise<void> {
    const host = this.hosts.show(name);
    assertHostWritable(host);
    if (!host.firewall) {
      throw new BadRequestException(
        `vops never applied a firewall to '${name}' — nothing to clear (its existing firewall, if any, is left untouched).`,
      );
    }
    await this.conn.assertReady(name);
    const target = resolveSshTarget(host, this.keys);
    const res = await this.ssh.runScript(target, clearScript(sudoPrefix(host)), { timeoutMs: 60_000 });
    if (res.code !== 0) {
      const reason = res.stderr.trim() || `clear script exited ${res.code}`;
      throw new BadRequestException(`Firewall clear failed (nothing forgotten): ${reason}`);
    }
    // Only drop the intent once the table is verifiably gone — never desync into an
    // enforcing-but-forgotten firewall the user can no longer clear.
    if ((await this.probe(host).catch(() => ({ active: false }))).active) {
      throw new BadRequestException(`Firewall clear did not remove the vops table on '${name}' — intent kept so you can retry.`);
    }
    host.firewall = undefined;
    this.hosts.update(host);
    await this.store.appendAudit('host.firewall.clear', { host: name });
  }

  /** The operator's own IP as this host sees it (for "restrict to my IP"). Null if not derivable. */
  async clientIp(name: string): Promise<string | null> {
    const host = this.hosts.show(name);
    const reachable = host.conn?.state === 'ready' || host.opsKeyInstalled || !!host.userKeyName;
    if (!reachable) return null;
    try {
      const res = await this.ssh.run(resolveSshTarget(host, this.keys), 'echo "$SSH_CONNECTION"');
      return parseClientIp(res.stdout);
    } catch {
      return null;
    }
  }

  /**
   * Best-effort read-only detection of a host firewall vops does NOT manage
   * (flui's `inet flui`, or any other input default-deny) so a protected host is
   * never shown as unprotected. Null when nothing foreign is enforcing or the
   * host isn't SSH-reachable.
   */
  async detectForeign(name: string): Promise<ForeignFirewall | null> {
    const host = this.hosts.show(name);
    const reachable = host.conn?.state === 'ready' || host.opsKeyInstalled || !!host.userKeyName;
    if (!reachable) return null;
    try {
      const res = await this.ssh.runScript(
        resolveSshTarget(host, this.keys),
        foreignProbeScript(sudoPrefix(host)),
        { timeoutMs: 30_000 },
      );
      return buildForeignFirewall(parseForeignProbe(res.stdout));
    } catch {
      return null;
    }
  }

  private renderOpts(host: VopsHost, policy: 'drop' | 'accept'): HostFirewallOptions {
    return { defaultInboundPolicy: policy, sshAlwaysOpen: true, sshPort: host.port ?? 22 };
  }

  private async ensureNft(target: SshTarget, family: OsFamily, sudo: string): Promise<string> {
    const found = await resolveNftBin(this.ssh, target);
    if (found) return found;
    const install = family === 'rhel'
      ? `${sudo}dnf install -y nftables`
      : `${sudo}apt-get update -qq && ${sudo}DEBIAN_FRONTEND=noninteractive apt-get install -y nftables`;
    const res = await this.ssh.run(target, install, { timeoutMs: 300_000 });
    const after = await resolveNftBin(this.ssh, target);
    if (!after) {
      throw new BadRequestException(
        `nftables is not installed and could not be installed automatically: ${res.stderr.trim() || 'install failed'}`,
      );
    }
    return after;
  }

  private async probe(host: VopsHost): Promise<{ active: boolean; persistent: boolean }> {
    const target = resolveSshTarget(host, this.keys);
    const sudo = sudoPrefix(host);
    const res = await this.ssh.run(
      target,
      `${sudo}nft list table inet ${TABLE} >/dev/null 2>&1 && echo VOPS_ACTIVE; systemctl is-enabled ${UNIT} 2>/dev/null | grep -qx enabled && echo VOPS_PERSIST || true`,
    );
    return { active: res.stdout.includes('VOPS_ACTIVE'), persistent: res.stdout.includes('VOPS_PERSIST') };
  }
}

/** An explicit inbound SSH rule — meaningless on this engine (SSH is always open). */
function isManagedSshRule(r: VopsFirewallRule, sshPort: number): boolean {
  return r.direction === 'in' && r.protocol === 'tcp' && (r.port ?? '').trim() === String(sshPort);
}

function applyScript(sudo: string, ruleset: string, nftBin: string): string {
  return [
    'set -e',
    `${sudo}mkdir -p /etc/vops`,
    `${sudo}tee ${CONF} >/dev/null <<'VOPS_NFT_EOF'`,
    ruleset.trimEnd(),
    'VOPS_NFT_EOF',
    `${sudo}${nftBin} -f ${CONF}`,
    'if command -v systemctl >/dev/null 2>&1; then',
    `  ${sudo}tee ${UNIT_PATH} >/dev/null <<'VOPS_UNIT_EOF'`,
    unitFile(nftBin),
    'VOPS_UNIT_EOF',
    `  ${sudo}systemctl daemon-reload || true`,
    `  ${sudo}systemctl enable ${UNIT} >/dev/null 2>&1 || true`,
    '  echo VOPS_PERSIST_SYSTEMD',
    'else',
    '  echo VOPS_PERSIST_NONE',
    'fi',
    '',
  ].join('\n');
}

function clearScript(sudo: string): string {
  return [
    'set -e',
    `${sudo}rm -f ${CONF}`, // first, un-|| : a sudo denial surfaces here (rm -f never fails on absence)
    `${sudo}nft delete table inet ${TABLE} 2>/dev/null || true`, // table may already be absent
    'if command -v systemctl >/dev/null 2>&1; then',
    `  ${sudo}systemctl disable --now ${UNIT} >/dev/null 2>&1 || true`,
    `  ${sudo}rm -f ${UNIT_PATH}`,
    `  ${sudo}systemctl daemon-reload || true`,
    'fi',
    '',
  ].join('\n');
}

function unitFile(nftBin: string): string {
  return [
    '[Unit]',
    'Description=vops host firewall',
    // Firewalls must load BEFORE the network comes up (systemd.special) — otherwise
    // there's an unfirewalled window while daemons start listening.
    'DefaultDependencies=no',
    'Wants=network-pre.target',
    'Before=network-pre.target network.target',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${nftBin} -f ${CONF}`,
    'RemainAfterExit=yes',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}
