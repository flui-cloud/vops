import { BadRequestException, Injectable } from '@nestjs/common';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { VopsFirewall, VopsFirewallRule, VopsFirewallTarget } from '../dto/firewall.dto';
import { VopsHostFirewallService } from '../host-ops/vops-host-firewall.service';
import { VopsFirewallService } from './vops-firewall.service';
import {
  FirewallEngine,
  FirewallService,
  firstServiceError,
  isServiceRule,
  resolveFirewallEngine,
  rulesAllowPort,
  rulesToServices,
  servicesToRules,
} from './firewall-services';
import { ForeignFirewall } from './foreign-firewall';

/** Who owns a host's firewall when vops doesn't — vops reads it, never writes it. */
export type FirewallCededTo = 'flui' | 'provider';

/** A firewall vops didn't apply, surfaced read-only so a protected host isn't shown as open. */
export interface DetectedFirewallView {
  source: 'flui' | 'other' | 'provider';
  active: boolean;
  persistent: boolean;
  /** Decoded rules as simple services — populated for 'flui'/'provider', empty for 'other'. */
  services: FirewallService[];
  rulesetPath?: string;
  /** Provider plane only: which firewall at the provider is guarding this server. */
  providerFirewallId?: string;
  name?: string;
}

export interface ServerFirewallView {
  host: string;
  engine: FirewallEngine;
  services: FirewallService[];
  /** nftables engine keeps SSH open to the world, non-closable. */
  sshAlwaysOpen: boolean;
  /** Live: the vops ruleset is active on the host (nftables) or applied (provider). */
  active: boolean;
  /** Survives reboot / persisted at the edge. */
  persistent: boolean;
  /** SSH port (kept open on the nftables engine). */
  sshPort: number;
  appliedAt?: string;
  /** Provider engine only. */
  providerFirewallId?: string;
  appliedTo?: VopsFirewallTarget[];
  /** A firewall vops doesn't manage, detected live on the host (read-only). */
  detected?: DetectedFirewallView;
  /** Someone else owns this host's firewall → vops management is ceded (read-only). */
  cededTo?: FirewallCededTo;
}

/**
 * Unified per-server firewall — one surface for the CLI and the dashboard. It
 * resolves the engine (provider-native for Hetzner/Scaleway, vops nftables for the
 * rest and BYOS) and routes get/set through the simple-service compiler, so callers
 * never touch engine specifics.
 *
 * The nftables engine is lock-out-proof by construction (SSH always open). The
 * provider engine can't self-guarantee that, so `set` refuses a provider rule set
 * that wouldn't leave SSH reachable, and only ever mutates a `vops-<host>` firewall.
 */
@Injectable()
export class VopsServerFirewallService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly hostFw: VopsHostFirewallService,
    private readonly providerFw: VopsFirewallService,
  ) {}

  async get(name: string): Promise<ServerFirewallView> {
    const host = this.hosts.show(name);
    const engine = resolveFirewallEngine(host);
    const detected = await this.hostFw.detectForeign(name).catch(() => null);
    const base = await this.getBase(name, host, engine);
    return this.withDetected(base, detected, engine);
  }

  private async getBase(name: string, host: VopsHost, engine: FirewallEngine): Promise<ServerFirewallView> {
    if (engine === 'nftables') return this.getNftables(name);
    if (engine === 'provider') return this.getProvider(host);
    return { host: name, engine: 'none', services: [], sshAlwaysOpen: false, active: false, persistent: false, sshPort: host.port ?? 22 };
  }

  // Attach any non-vops HOST-level firewall (read-only). On the nftables engine, an
  // active flui firewall means vops cedes management (one manager per host — no
  // stacking drop layers), so `cededTo` disables vops apply.
  private withDetected(
    view: ServerFirewallView,
    detected: ForeignFirewall | null,
    engine: FirewallEngine,
  ): ServerFirewallView {
    // An inactive host-level ruleset must never mask a live provider firewall the
    // engine already found — that would report a guarded host as open again.
    if (!detected || (!detected.active && view.detected)) return view;
    const ceded = engine === 'nftables' && detected.source === 'flui' && detected.active;
    return {
      ...view,
      detected: {
        source: detected.source,
        active: detected.active,
        persistent: detected.persistent,
        services: rulesToServices(detected.rules),
        rulesetPath: detected.rulesetPath,
      },
      ...(ceded ? { cededTo: 'flui' as const } : {}),
    };
  }

  async set(name: string, services: FirewallService[]): Promise<ServerFirewallView> {
    const host = this.hosts.show(name);
    const engine = resolveFirewallEngine(host);
    const invalid = firstServiceError(services);
    if (invalid) throw new BadRequestException(invalid);
    const rules = servicesToRules(services);
    if (engine === 'nftables') {
      const foreign = await this.hostFw.detectForeign(name).catch(() => null);
      if (foreign?.source === 'flui' && foreign.active) {
        throw new BadRequestException(
          `flui manages the host firewall on '${name}' (nftables). vops won't apply a second, stacking ruleset — ` +
            `edit these rules in flui, or remove flui's firewall first.`,
        );
      }
      await this.hostFw.apply(name, rules, { policy: 'drop' });
      return this.getNftables(name);
    }
    if (engine === 'provider') {
      const foreign = await this.findForeignProviderFirewall(host);
      if (foreign) {
        throw new BadRequestException(
          `'${foreign.name}' already guards '${name}' at ${host.provider}, and vops didn't create it. ` +
            `vops won't attach a second firewall to the same server — edit it where it's managed, or detach it first.`,
        );
      }
      // No SSH-always-open safety net at the edge — refuse a lock-out before applying.
      if (!rulesAllowPort(rules, host.port ?? 22)) {
        throw new BadRequestException(
          `This would remove SSH (port ${host.port ?? 22}) from the provider firewall and lock you out. Keep SSH allowed.`,
        );
      }
      await this.applyProvider(host, rules);
      return this.getProvider(host);
    }
    throw new BadRequestException(
      `No firewall engine for '${name}': it has no native firewall and no SSH management to run nftables.`,
    );
  }

  /** The operator's IP as the host sees it — for "restrict a service to my IP". */
  myIp(name: string): Promise<string | null> {
    return this.hostFw.clientIp(name);
  }

  async clear(name: string): Promise<void> {
    const host = this.hosts.show(name);
    const engine = resolveFirewallEngine(host);
    if (engine === 'nftables') return this.hostFw.clear(name);
    if (engine === 'provider') return this.clearProvider(host);
    throw new BadRequestException(`No firewall engine for '${name}'.`);
  }

  private async getNftables(name: string): Promise<ServerFirewallView> {
    const status = await this.hostFw.status(name);
    return {
      host: name,
      engine: 'nftables',
      services: rulesToServices(status.intended?.rules ?? []),
      sshAlwaysOpen: true,
      active: status.active,
      persistent: status.persistent,
      sshPort: status.sshPort,
      appliedAt: status.intended?.appliedAt,
    };
  }

  private async getProvider(host: VopsHost): Promise<ServerFirewallView> {
    const list = host.provider ? await this.providerFw.list(host.provider) : [];
    const mine = this.firewallName(host);
    const fw = list.find((f) => f.name === mine) ?? null;
    const applied = !!fw && this.guardsHost(fw, host);
    const base: ServerFirewallView = {
      host: host.name,
      engine: 'provider',
      services: rulesToServices(fw?.rules ?? []),
      sshAlwaysOpen: false,
      active: applied, // exists-but-not-applied is NOT active
      persistent: applied,
      sshPort: host.port ?? 22,
      providerFirewallId: fw?.id,
      appliedTo: fw?.appliedTo,
    };
    if (applied) return base;

    // vops owns no firewall here — but the server may still be guarded by one it
    // didn't create. The ownership rule governs writes; reading it is what keeps a
    // protected host from being reported as wide open.
    const foreign = list.find((f) => f.name !== mine && this.guardsHost(f, host));
    if (!foreign) return base;
    return {
      ...base,
      detected: {
        source: 'provider',
        active: true,
        persistent: true,
        services: rulesToServices(foreign.rules),
        providerFirewallId: foreign.id,
        name: foreign.name,
      },
      cededTo: 'provider',
    };
  }

  /** Is this firewall applied to the host's provider server? */
  private guardsHost(fw: VopsFirewall, host: VopsHost): boolean {
    return !!host.providerServerId && fw.appliedTo.some((t) => sameServer(t.serverId, host.providerServerId));
  }

  /** A provider firewall guarding this server that vops did NOT create (read-only). */
  private async findForeignProviderFirewall(host: VopsHost): Promise<VopsFirewall | null> {
    if (!host.provider || !host.providerServerId) return null;
    const list = await this.providerFw.list(host.provider).catch(() => [] as VopsFirewall[]);
    const mine = this.firewallName(host);
    if (list.some((f) => f.name === mine && this.guardsHost(f, host))) return null;
    return list.find((f) => f.name !== mine && this.guardsHost(f, host)) ?? null;
  }

  // Mutation only ever targets the vops-owned `vops-<host>` firewall — never a
  // firewall merely applied to the server (which could belong to another host).
  private async findManagedFirewall(host: VopsHost): Promise<VopsFirewall | null> {
    if (!host.provider) return null;
    const list = await this.providerFw.list(host.provider);
    return list.find((f) => f.name === this.firewallName(host)) ?? null;
  }

  private async applyProvider(host: VopsHost, rules: VopsFirewallRule[]): Promise<void> {
    if (!host.provider) throw new BadRequestException(`Host '${host.name}' has no provider firewall to manage.`);
    const existing = await this.findManagedFirewall(host);
    if (existing) {
      // Preserve rules the simple model can't express (icmp, outbound, portless).
      const preserved = existing.rules.filter((r) => !isServiceRule(r));
      await this.providerFw.updateRules(host.provider, existing.id, [...preserved, ...rules]);
      const alreadyApplied = host.providerServerId
        && existing.appliedTo.some((t) => sameServer(t.serverId, host.providerServerId));
      if (host.providerServerId && !alreadyApplied) {
        await this.providerFw.apply(host.provider, existing.id, [host.providerServerId]);
      }
      return;
    }
    await this.providerFw.create(
      {
        provider: host.provider,
        name: this.firewallName(host),
        rules,
        applyToServerIds: host.providerServerId ? [host.providerServerId] : [],
      },
      { yes: true },
    );
  }

  private async clearProvider(host: VopsHost): Promise<void> {
    const fw = await this.findManagedFirewall(host);
    if (!fw || !host.provider) {
      throw new BadRequestException(`vops has no firewall on '${host.name}' to clear.`);
    }
    // Detach from every server first — providers refuse to delete an in-use firewall.
    // Include the host's canonical id: some providers (Scaleway) list appliedTo as a
    // bare UUID that their own detach API won't accept.
    const ids = new Set(fw.appliedTo.map((t) => t.serverId));
    if (host.providerServerId) ids.add(host.providerServerId);
    if (ids.size) await this.providerFw.remove(host.provider, fw.id, [...ids]);
    await this.providerFw.delete(host.provider, fw.id, { yes: true });
  }

  private firewallName(host: VopsHost): string {
    return `vops-${host.name}`;
  }
}

/**
 * Match a firewall's appliedTo serverId against the host's providerServerId, tolerating
 * format differences: Hetzner uses bare numeric ids on both sides; Scaleway lists a bare
 * UUID in appliedTo but the host carries the canonical `instance:<zone>:<uuid>`. Compare
 * on the trailing id segment so "applied?" is correct on both.
 */
function sameServer(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return (a.split(':').pop() ?? a) === (b.split(':').pop() ?? b);
}
