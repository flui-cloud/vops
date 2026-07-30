import { BadRequestException, Injectable } from '@nestjs/common';
import { ProviderFactory, ICloudProvider, VNetDetails } from '@flui-cloud/infra';
import { resolveProvider } from '../lib/providers';
import { assertApprovedInService } from '../safety/approval-gate';
import { assertVopsManaged } from '../safety/ownership';
import { LocalStore } from '../lib/store/local-store';
import { VopsWriteGateService } from '../safety/vops-write-gate.service';
import { VopsVnet, VopsVnetCreateInput } from '../dto/vnet.dto';

const DESTRUCTIVE_VNET_ACTIONS = new Set(['detach', 'subnet.delete', 'route.delete']);

export interface VnetMutationOptions {
  dryRun?: boolean;
  yes?: boolean;
}

export interface VnetCreateOutcome {
  dryRun: boolean;
  vnet: VopsVnet | null;
}

/** Private-network lifecycle over ICloudProvider's VNet primitives — same paths as Flui. */
@Injectable()
export class VopsVnetService {
  constructor(
    private readonly providers: ProviderFactory,
    private readonly writeGate: VopsWriteGateService,
    private readonly store: LocalStore,
  ) {}

  async list(name: string): Promise<VopsVnet[]> {
    const provider = resolveProvider(name);
    const list = await this.require(name, 'listVNets').listVNets();
    return list.map((v) => this.toVnet(provider, v));
  }

  async show(name: string, id: string): Promise<VopsVnet | null> {
    const provider = resolveProvider(name);
    const v = await this.require(name, 'getVNet').getVNet(id);
    return v ? this.toVnet(provider, v) : null;
  }

  async create(
    input: VopsVnetCreateInput,
    opts: VnetMutationOptions = {},
  ): Promise<VnetCreateOutcome> {
    const provider = resolveProvider(input.provider);
    this.writeGate.assertProviderWritable(provider);
    await this.store.appendAudit('vnet.create.request', {
      provider,
      name: input.name,
      ipRange: input.ipRange,
      dryRun: !!opts.dryRun,
    });
    if (opts.dryRun) return { dryRun: true, vnet: null };
    this.assertConfirmed(opts, 'Create network', input.name, `It is created on the ${provider} account.`);

    const result = await this.require(input.provider, 'createVNet').createVNet({
      name: input.name,
      ipRange: input.ipRange,
      labels: [{ key: 'managed-by', value: 'vops' }],
      subnets: input.subnets,
    });
    await this.store.appendAudit('vnet.created', { provider, vnetId: result.vnetId });
    const created = await this.show(input.provider, result.vnetId);
    return { dryRun: false, vnet: created };
  }

  async delete(
    name: string,
    id: string,
    opts: VnetMutationOptions = {},
  ): Promise<{ dryRun: boolean }> {
    const provider = resolveProvider(name);
    this.writeGate.assertProviderWritable(provider);
    await this.store.appendAudit('vnet.delete.request', {
      provider,
      vnetId: id,
      dryRun: !!opts.dryRun,
    });
    if (opts.dryRun) return { dryRun: true };
    this.assertConfirmed(opts, 'Delete network', id, 'Attached servers lose their private connectivity.');
    await this.assertManaged(name, id);
    await this.require(name, 'deleteVNet').deleteVNet(id);
    return { dryRun: false };
  }

  async attach(name: string, vnetId: string, serverId: string): Promise<void> {
    await this.mutate(name, 'attach', { vnetId, serverId }, (p) =>
      p.attachServerToVNet({ vnetId, serverId }),
    );
  }

  async detach(name: string, vnetId: string, serverId: string): Promise<void> {
    await this.mutate(name, 'detach', { vnetId, serverId }, (p) =>
      p.detachServerFromVNet({ vnetId, serverId }),
    );
  }

  async addSubnet(
    name: string,
    vnetId: string,
    networkZone: string,
    ipRange?: string,
  ): Promise<void> {
    await this.mutate(name, 'subnet.add', { vnetId, networkZone, ipRange }, (p) =>
      p.addSubnet({ vnetId, networkZone, ipRange }),
    );
  }

  async deleteSubnet(name: string, vnetId: string, ipRange: string): Promise<void> {
    await this.mutate(name, 'subnet.delete', { vnetId, ipRange }, (p) =>
      p.deleteSubnet({ vnetId, ipRange }),
    );
  }

  async addRoute(
    name: string,
    vnetId: string,
    destination: string,
    gateway: string,
  ): Promise<void> {
    await this.mutate(name, 'route.add', { vnetId, destination, gateway }, (p) =>
      p.addRoute({ vnetId, destination, gateway }),
    );
  }

  async deleteRoute(
    name: string,
    vnetId: string,
    destination: string,
    gateway: string,
  ): Promise<void> {
    await this.mutate(name, 'route.delete', { vnetId, destination, gateway }, (p) =>
      p.deleteRoute({ vnetId, destination, gateway }),
    );
  }

  private async mutate(
    name: string,
    action: string,
    detail: Record<string, unknown>,
    run: (p: ICloudProvider) => Promise<unknown>,
  ): Promise<void> {
    const provider = resolveProvider(name);
    this.writeGate.assertProviderWritable(provider);
    if (DESTRUCTIVE_VNET_ACTIONS.has(action) && typeof detail.vnetId === 'string') {
      await this.assertManaged(name, detail.vnetId);
    }
    await this.store.appendAudit(`vnet.${action}`, { provider, ...detail });
    await run(this.require(name, methodFor(action)));
  }

  /** Only ever mutate/delete networks vops created (name vops-* or managed label). */
  private async assertManaged(name: string, vnetId: string): Promise<void> {
    const v = await this.show(name, vnetId);
    if (!v) throw new BadRequestException(`Network '${vnetId}' not found on ${name}.`);
    assertVopsManaged('network', {
      name: v.name,
      labels: Object.entries(v.labels ?? {}).map(([key, value]) => ({ key, value })),
    });
  }

  private require(name: string, method: keyof ICloudProvider): ICloudProvider {
    const provider = resolveProvider(name);
    const impl = this.providers.getProvider(provider);
    if (typeof impl[method] !== 'function') {
      throw new BadRequestException(
        `Provider '${provider}' does not support private networks (${String(method)}).`,
      );
    }
    return impl;
  }

  private assertConfirmed(
    opts: VnetMutationOptions,
    operation: string,
    target: string,
    consequence: string,
  ): void {
    assertApprovedInService({
      operation,
      target,
      approved: !!opts.yes,
      consequence,
      suggestedAction: 'Show the user what this changes, then re-run with --yes once they agree — or --dry-run to preview it.',
    });
  }

  private toVnet(provider: string, v: VNetDetails): VopsVnet {
    return {
      provider,
      id: v.id,
      name: v.name,
      ipRange: v.ipRange,
      subnets: v.subnets,
      routes: v.routes,
      attachedServerIds: v.attachedServerIds,
      labels: v.labels ?? {},
      created: v.created ?? null,
    };
  }
}

function methodFor(action: string): keyof ICloudProvider {
  const map: Record<string, keyof ICloudProvider> = {
    attach: 'attachServerToVNet',
    detach: 'detachServerFromVNet',
    'subnet.add': 'addSubnet',
    'subnet.delete': 'deleteSubnet',
    'route.add': 'addRoute',
    'route.delete': 'deleteRoute',
  };
  return map[action];
}
