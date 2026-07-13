import { BadRequestException, Injectable } from '@nestjs/common';
import {
  FirewallProviderFactory,
  FirewallDetails,
  FirewallRule,
  IFirewallProvider,
} from '@flui-cloud/infra';
import { resolveProvider } from '../lib/providers';
import { assertVopsManaged } from '../safety/ownership';
import { LocalStore } from '../lib/store/local-store';
import { VopsWriteGateService } from '../safety/vops-write-gate.service';
import {
  VopsFirewall,
  VopsFirewallCreateInput,
  VopsFirewallRule,
} from '../dto/firewall.dto';

export interface FirewallMutationOptions {
  dryRun?: boolean;
  yes?: boolean;
}

export interface FirewallCreateOutcome {
  dryRun: boolean;
  firewall: VopsFirewall | null;
}

/** Firewall lifecycle over the shared IFirewallProvider — same code paths as Flui. */
@Injectable()
export class VopsFirewallService {
  constructor(
    private readonly firewalls: FirewallProviderFactory,
    private readonly writeGate: VopsWriteGateService,
    private readonly store: LocalStore,
  ) {}

  async list(name: string): Promise<VopsFirewall[]> {
    const provider = resolveProvider(name);
    const list = await this.api(name).listFirewalls();
    return list.map((f) => this.toFirewall(provider, f));
  }

  async show(name: string, id: string): Promise<VopsFirewall | null> {
    const provider = resolveProvider(name);
    const fw = await this.api(name).getFirewall(id);
    return fw ? this.toFirewall(provider, fw) : null;
  }

  async create(
    input: VopsFirewallCreateInput,
    opts: FirewallMutationOptions = {},
  ): Promise<FirewallCreateOutcome> {
    const provider = resolveProvider(input.provider);
    this.writeGate.assertProviderWritable(provider);
    await this.store.appendAudit('firewall.create.request', {
      provider,
      name: input.name,
      dryRun: !!opts.dryRun,
    });
    if (opts.dryRun) return { dryRun: true, firewall: null };
    this.assertConfirmed(opts, 'create a firewall');

    const result = await this.api(input.provider).createFirewall({
      name: input.name,
      labels: [{ key: 'managed-by', value: 'vops' }],
      rules: (input.rules ?? []).map(toProviderRule),
      applyToServerIds: input.applyToServerIds,
    });
    await this.store.appendAudit('firewall.created', {
      provider,
      firewallId: result.firewallId,
    });
    const created = await this.show(input.provider, result.firewallId);
    return { dryRun: false, firewall: created };
  }

  async updateRules(
    name: string,
    id: string,
    rules: VopsFirewallRule[],
  ): Promise<void> {
    const provider = resolveProvider(name);
    this.writeGate.assertProviderWritable(provider);
    await this.assertManaged(name, id);
    await this.store.appendAudit('firewall.rules.update', {
      provider,
      firewallId: id,
      ruleCount: rules.length,
    });
    await this.api(name).updateFirewallRules(id, rules.map(toProviderRule));
  }

  async delete(
    name: string,
    id: string,
    opts: FirewallMutationOptions = {},
  ): Promise<{ dryRun: boolean }> {
    const provider = resolveProvider(name);
    this.writeGate.assertProviderWritable(provider);
    await this.store.appendAudit('firewall.delete.request', {
      provider,
      firewallId: id,
      dryRun: !!opts.dryRun,
    });
    if (opts.dryRun) return { dryRun: true };
    this.assertConfirmed(opts, 'delete a firewall');
    await this.assertManaged(name, id);
    await this.api(name).deleteFirewall(id);
    return { dryRun: false };
  }

  /** Only ever mutate/delete firewalls vops created (name vops-* or managed label). */
  private async assertManaged(name: string, id: string): Promise<void> {
    const fw = await this.api(name).getFirewall(id);
    if (!fw) throw new BadRequestException(`Firewall '${id}' not found on ${name}.`);
    assertVopsManaged('firewall', {
      name: fw.name,
      labels: Object.entries(fw.labels ?? {}).map(([key, value]) => ({ key, value })),
    });
  }

  async apply(name: string, id: string, serverIds: string[]): Promise<void> {
    const provider = resolveProvider(name);
    this.writeGate.assertProviderWritable(provider);
    await this.store.appendAudit('firewall.apply', { provider, firewallId: id, serverIds });
    await this.api(name).applyToServers(id, serverIds);
  }

  async remove(name: string, id: string, serverIds: string[]): Promise<void> {
    const provider = resolveProvider(name);
    this.writeGate.assertProviderWritable(provider);
    await this.store.appendAudit('firewall.remove', { provider, firewallId: id, serverIds });
    await this.api(name).removeFromServers(id, serverIds);
  }

  private api(name: string): IFirewallProvider {
    const provider = resolveProvider(name);
    return this.firewalls.getFirewallProviderOrFail(provider);
  }

  private assertConfirmed(opts: FirewallMutationOptions, action: string): void {
    if (!opts.yes) {
      throw new BadRequestException(
        `Refusing to ${action} without confirmation. Re-run with --yes (or --dry-run).`,
      );
    }
  }

  private toFirewall(provider: string, f: FirewallDetails): VopsFirewall {
    return {
      provider,
      id: f.id,
      name: f.name,
      rules: f.rules,
      labels: f.labels,
      appliedTo: f.appliedTo,
    };
  }
}

function toProviderRule(r: VopsFirewallRule): FirewallRule {
  return {
    id: r.id,
    description: r.description,
    direction: r.direction,
    protocol: r.protocol,
    port: r.port,
    sourceIps: r.sourceIps,
    destinationIps: r.destinationIps,
  };
}
