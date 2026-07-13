import { Injectable } from '@nestjs/common';
import {
  CapabilitiesProviderFactory,
  CloudProvider,
  ProviderCapabilities,
} from '@flui-cloud/infra';
import { computeWriteGate, BillingModel } from '../safety/write-gate';
import {
  VopsLocation,
  VopsProviderCapabilities,
  VopsProviderSummary,
} from '../dto/provider.dto';
import {
  DISPLAY_NAMES,
  SUPPORTED,
  isGuided,
  resolveProvider,
} from '../lib/providers';

/**
 * Read-only research surface over the shared capabilities services. Static
 * capabilities need no credentials; locations hit the live provider API.
 */
@Injectable()
export class VopsProvidersService {
  constructor(private readonly factory: CapabilitiesProviderFactory) {}

  list(): VopsProviderSummary[] {
    return SUPPORTED.map((p) => this.summary(p, this.staticCaps(p)));
  }

  capabilities(name: string): VopsProviderCapabilities {
    const provider = resolveProvider(name);
    const caps = this.staticCaps(provider);
    return {
      ...this.summary(provider, caps),
      credentialType: caps.credentialType,
      currency: caps.pricing.currency,
      minimumCost: caps.pricing.minimumCost,
      firewallBackend: caps.firewall.backend,
      privateNetworkRequired: caps.vnetRequired,
    };
  }

  async locations(name: string): Promise<VopsLocation[]> {
    const provider = resolveProvider(name);
    const regions = await this.factory
      .getCapabilitiesService(provider)
      .getAvailableRegions();
    return regions.map((r) => ({
      id: r.id,
      name: r.displayName ?? r.name,
      location: r.location,
      available: r.available,
      country: r.country ?? null,
    }));
  }

  private summary(
    provider: CloudProvider,
    caps: ProviderCapabilities,
  ): VopsProviderSummary {
    const billingModel = caps.pricing.billingCycle as BillingModel;
    const gate = computeWriteGate(billingModel);
    return {
      provider,
      displayName: DISPLAY_NAMES[provider] ?? provider,
      billingModel,
      writeEnabled: gate.writeEnabled,
      writeDisabledReason: gate.writeDisabledReason,
      guided: isGuided(provider),
      features: {
        firewall: caps.firewall.backend !== 'none',
        dns: caps.features.dnsZones,
        privateNetwork: caps.features.privateNetworking,
        snapshots: caps.features.snapshots,
      },
    };
  }

  private staticCaps(provider: CloudProvider): ProviderCapabilities {
    return this.factory
      .getCapabilitiesService(provider)
      .getStaticCapabilities();
  }
}
