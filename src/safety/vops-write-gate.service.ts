import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CapabilitiesProviderFactory,
  CloudProvider,
  NodeSizeDto,
} from '@flui-cloud/infra';
import { VopsBillingGate } from '../dto/plan-file.dto';
import { isGuided } from '../lib/providers';

/**
 * The single provisioning safety authority. vops only *provisions* hourly-billed,
 * non-bare-metal plans. Non-hourly providers (e.g. Contabo) are never provisioned
 * — they are marked "guided": vops shows how to create, but does not place the
 * (monthly) order. No command may create a server without passing here.
 */
@Injectable()
export class VopsWriteGateService {
  constructor(private readonly capabilities: CapabilitiesProviderFactory) {}

  evaluate(provider: CloudProvider, plan: NodeSizeDto): VopsBillingGate {
    const providerBilling = this.capabilities
      .getCapabilitiesService(provider)
      .getStaticCapabilities().pricing.billingCycle;
    const planSupportsHourly = plan.supportsHourlyBilling;
    const bareMetal = plan.bareMetal;
    const allowed =
      !bareMetal && providerBilling === 'hourly' && planSupportsHourly;
    const guided = !bareMetal && !allowed && isGuided(provider);

    return {
      providerBilling,
      planSupportsHourly,
      bareMetal,
      allowed,
      guided,
      reason: allowed ? null : this.reason(providerBilling, bareMetal),
    };
  }

  assert(gate: VopsBillingGate): void {
    if (!gate.allowed) {
      throw new BadRequestException(gate.reason ?? 'Creation not allowed.');
    }
  }

  /**
   * Provider-level authority for non-server writes (firewalls, networks). These
   * resources carry no per-plan cost, so only the provider's billing model
   * matters: vops acts only on hourly-billed providers (cost-control policy).
   */
  evaluateProvider(provider: CloudProvider): { allowed: boolean; reason: string | null } {
    const providerBilling = this.capabilities
      .getCapabilitiesService(provider)
      .getStaticCapabilities().pricing.billingCycle;
    const allowed = providerBilling === 'hourly';
    return {
      allowed,
      reason: allowed
        ? null
        : `Writes refused: provider is ${providerBilling}-billed. ` +
          `vops only manages hourly-billed providers (cost-control policy).`,
    };
  }

  assertProviderWritable(provider: CloudProvider): void {
    const gate = this.evaluateProvider(provider);
    if (!gate.allowed) throw new BadRequestException(gate.reason ?? 'Writes not allowed.');
  }

  private reason(providerBilling: string, bareMetal: boolean): string {
    let cause: string;
    if (bareMetal) {
      cause = 'bare-metal plan (monthly commitment)';
    } else if (providerBilling === 'hourly') {
      cause = 'plan does not support hourly billing';
    } else {
      cause = `provider is ${providerBilling}-billed`;
    }
    return (
      `Creation refused: ${cause}. ` +
      `vops provisions hourly-billed, non-bare-metal plans (or approved monthly providers).`
    );
  }
}
