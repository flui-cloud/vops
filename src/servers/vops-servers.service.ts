import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ProviderFactory,
  CapabilitiesProviderFactory,
  CloudProvider,
  NodeSizeDto,
  CreateServerConfig,
} from '@flui-cloud/infra';
import { resolveProvider, hasNativeFirewall, DISPLAY_NAMES } from '../lib/providers';
import { assertVopsManaged, isVopsManaged } from '../safety/ownership';
import { defaultImage } from '../lib/plan-io';
import { renderCloudInit } from '../host-firewall/nftables';
import { LocalStore } from '../lib/store/local-store';
import { VopsCatalogService } from '../catalog/vops-catalog.service';
import { VopsWriteGateService } from '../safety/vops-write-gate.service';
import { VopsHostFirewall, VopsPlanFile, VopsServer } from '../dto/plan-file.dto';

export interface PlanInput {
  provider: string;
  plan: string;
  location: string;
  image?: string;
  name?: string;
  sshKey?: string;
  hostFirewall?: VopsHostFirewall;
}

export interface CreateOutcome {
  dryRun: boolean;
  /** Non-hourly provider: vops did not provision; it returns how-to guidance. */
  guided?: boolean;
  howTo?: string[];
  plan: VopsPlanFile;
  server: { id: string; ip: string | null; status: string } | null;
}

@Injectable()
export class VopsServersService {
  constructor(
    private readonly providers: ProviderFactory,
    private readonly capabilities: CapabilitiesProviderFactory,
    private readonly catalog: VopsCatalogService,
    private readonly writeGate: VopsWriteGateService,
    private readonly store: LocalStore,
  ) {}

  async plan(input: PlanInput): Promise<VopsPlanFile> {
    const provider = resolveProvider(input.provider);
    if (input.hostFirewall) this.assertHostFirewallApplicable(provider);
    const node = await this.requirePlan(input.provider, input.plan);
    const gate = this.writeGate.evaluate(provider, node);
    const cost = this.estimatedCost(node, input.location);
    return {
      version: 'vops.plan.v1',
      action: 'server.create',
      provider,
      name: input.name ?? this.serverName(node.name),
      plan: node.name,
      location: input.location,
      image: input.image ?? defaultImage(provider),
      sshKey: input.sshKey
        ? { mode: 'existing', id: input.sshKey }
        : { mode: 'none', id: null },
      ...(input.hostFirewall ? { hostFirewall: input.hostFirewall } : {}),
      billingGate: gate,
      estimatedCost: { ...cost, currency: this.currency(provider) },
      createdAt: new Date().toISOString(),
    };
  }

  async create(
    plan: VopsPlanFile,
    opts: { dryRun: boolean; yes: boolean },
  ): Promise<CreateOutcome> {
    const provider = resolveProvider(plan.provider);
    if (plan.hostFirewall) this.assertHostFirewallApplicable(provider);
    // Re-validate live against the current plan state — never trust the file.
    const node = await this.requirePlan(plan.provider, plan.plan);
    const gate = this.writeGate.evaluate(provider, node);

    await this.store.appendAudit('server.create.request', {
      provider,
      plan: plan.plan,
      location: plan.location,
      dryRun: opts.dryRun,
      guided: gate.guided,
      gate,
    });

    if (opts.dryRun) return { dryRun: true, plan, server: null };

    // Non-hourly providers are never provisioned by vops — show how to create.
    if (gate.guided) {
      return { dryRun: false, guided: true, howTo: this.howTo(plan), plan, server: null };
    }

    this.writeGate.assert(gate);
    if (!opts.yes) {
      throw new BadRequestException(
        'Refusing to create without confirmation. Re-run with --yes (or --dry-run).',
      );
    }

    const config: CreateServerConfig = {
      name: plan.name,
      server_type: plan.plan,
      image: plan.image,
      location: plan.location,
      ssh_keys:
        plan.sshKey.mode === 'existing' && plan.sshKey.id
          ? [plan.sshKey.id]
          : undefined,
      // Host-level firewall (nftables via cloud-init) — same on every provider.
      ...(plan.hostFirewall
        ? {
            user_data: renderCloudInit(plan.hostFirewall.rules, {
              defaultInboundPolicy: plan.hostFirewall.policy,
              keepSshOpen: plan.hostFirewall.keepSshOpen,
              allowPing: plan.hostFirewall.allowPing,
              allowOutbound: plan.hostFirewall.allowOutbound,
            }),
          }
        : {}),
    };
    const result = await this.providers.getProvider(provider).createServer(config);
    await this.store.appendAudit('server.created', {
      provider,
      serverId: result.serverId,
      ip: result.ipAddress ?? null,
    });
    return {
      dryRun: false,
      plan,
      server: {
        id: result.serverId,
        ip: result.ipAddress ?? null,
        status: result.status,
      },
    };
  }

  async list(name: string): Promise<VopsServer[]> {
    const provider = resolveProvider(name);
    const servers = await this.providers.getProvider(provider).listServersAsDto();
    return servers.map((s) => this.toServer(s));
  }

  async show(name: string, id: string): Promise<VopsServer | null> {
    const provider = resolveProvider(name);
    const server = await this.providers
      .getProvider(provider)
      .getServerDetailsAsDto(id);
    return server ? this.toServer(server) : null;
  }

  async delete(name: string, id: string, force = false): Promise<void> {
    const provider = resolveProvider(name);
    const impl = this.providers.getProvider(provider);
    // Safety: only ever delete resources vops created (never a pre-existing host).
    const server = await impl.getServerDetailsAsDto(id);
    if (!server) throw new BadRequestException(`Server '${id}' not found on ${name}.`);
    assertVopsManaged('server', server);
    await impl.deleteServer({ server_id: id, provider, force, reason: 'vops delete' });
    await this.store.appendAudit('server.delete', { provider, serverId: id });
  }

  /** Guidance for non-hourly providers: vops shows how to create, never orders. */
  private howTo(plan: VopsPlanFile): string[] {
    const price = plan.estimatedCost.monthly;
    const priceLabel =
      price == null ? 'monthly billing' : `from ${price} ${plan.estimatedCost.currency}/mo`;
    return [
      `${plan.provider} is monthly-billed — vops does not provision it (avoids a monthly commitment).`,
      `Plan: ${plan.plan} · region ${plan.location} · ${priceLabel}`,
      `To create it, order this plan in region '${plan.location}' from the ${plan.provider} control panel.`,
    ];
  }

  /**
   * The host-level firewall is meant only for providers WITHOUT a usable native
   * firewall (Contabo, OVH). Where the provider offers one (Hetzner, Scaleway) it
   * filters at the network edge, before the host — so we refuse to layer a second,
   * host-side firewall and point the user at `vops firewall` instead.
   */
  private assertHostFirewallApplicable(provider: CloudProvider): void {
    if (hasNativeFirewall(provider)) {
      throw new BadRequestException(
        `${DISPLAY_NAMES[provider] ?? provider} has a native, network-edge firewall — ` +
          `use 'vops firewall' for it. The host-level firewall (--host-firewall) is meant ` +
          `only for providers without a native firewall (e.g. Contabo, OVH).`,
      );
    }
  }

  private async requirePlan(name: string, plan: string): Promise<NodeSizeDto> {
    const node = await this.catalog.planNodeSize(name, plan);
    if (!node) {
      throw new BadRequestException(`Plan '${plan}' not found for ${name}.`);
    }
    return node;
  }

  private estimatedCost(
    node: NodeSizeDto,
    location: string,
  ): { hourly: number | null; monthly: number | null } {
    const priced =
      node.prices.find((p) => p.location === location) ?? node.prices[0];
    const num = (v?: string) => {
      const n = Number.parseFloat(v ?? '');
      return Number.isFinite(n) ? n : null;
    };
    return {
      hourly: num(priced?.priceHourly?.net),
      monthly: num(priced?.priceMonthly?.net),
    };
  }

  private currency(provider: CloudProvider): string {
    return this.capabilities
      .getCapabilitiesService(provider)
      .getStaticCapabilities().pricing.currency;
  }

  private serverName(plan: string): string {
    return `vops-${plan.toLowerCase()}-${Date.now().toString(36)}`;
  }

  private toServer(s: {
    id: string;
    name: string;
    server_type: string;
    location: string;
    status: string;
    public_ip?: string;
    labels?: { key: string; value: string }[];
  }): VopsServer {
    return {
      id: s.id,
      name: s.name,
      type: s.server_type,
      location: s.location,
      status: s.status,
      publicIp: s.public_ip ?? null,
      managed: isVopsManaged({ name: s.name, labels: s.labels }),
    };
  }
}
