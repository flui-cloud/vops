import { VopsWriteGateService } from '../src/safety/vops-write-gate.service';
import { CloudProvider } from '@flui-cloud/infra';

function capabilities(billingCycle: string): any {
  return {
    getCapabilitiesService: () => ({
      getStaticCapabilities: () => ({ pricing: { billingCycle } }),
    }),
  };
}

const plan = (over: Record<string, unknown> = {}): any => ({
  supportsHourlyBilling: true,
  bareMetal: false,
  ...over,
});

describe('VopsWriteGateService', () => {
  it('allows hourly-billed, non-bare-metal plans', () => {
    const gate = new VopsWriteGateService(capabilities('hourly')).evaluate(
      CloudProvider.HETZNER,
      plan(),
    );
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBeNull();
  });

  it('blocks bare-metal plans even when hourly', () => {
    const gate = new VopsWriteGateService(capabilities('hourly')).evaluate(
      CloudProvider.SCALEWAY,
      plan({ bareMetal: true }),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('bare-metal');
  });

  it('blocks monthly-billed providers', () => {
    const gate = new VopsWriteGateService(capabilities('monthly')).evaluate(
      CloudProvider.HETZNER,
      plan(),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('monthly-billed');
  });

  it('blocks plans that do not support hourly billing', () => {
    const gate = new VopsWriteGateService(capabilities('hourly')).evaluate(
      CloudProvider.HETZNER,
      plan({ supportsHourlyBilling: false }),
    );
    expect(gate.allowed).toBe(false);
  });

  it('assert() throws on a blocked gate', () => {
    const service = new VopsWriteGateService(capabilities('monthly'));
    const gate = service.evaluate(CloudProvider.HETZNER, plan());
    expect(() => service.assert(gate)).toThrow();
  });

  it('provider-level gate allows hourly providers for firewall/network writes', () => {
    const service = new VopsWriteGateService(capabilities('hourly'));
    expect(service.evaluateProvider(CloudProvider.HETZNER).allowed).toBe(true);
    expect(() => service.assertProviderWritable(CloudProvider.HETZNER)).not.toThrow();
  });

  it('provider-level gate blocks monthly providers for firewall/network writes', () => {
    const service = new VopsWriteGateService(capabilities('monthly'));
    const gate = service.evaluateProvider(CloudProvider.SCALEWAY);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('monthly-billed');
    expect(() => service.assertProviderWritable(CloudProvider.SCALEWAY)).toThrow();
  });

  it('marks Contabo as guided (never provisioned) rather than allowed', () => {
    const service = new VopsWriteGateService(capabilities('monthly'));
    const gate = service.evaluate(CloudProvider.CONTABO, plan({ supportsHourlyBilling: false }));
    expect(gate.allowed).toBe(false);
    expect(gate.guided).toBe(true);
    // Guided providers are not auto-provisioned; assert() must still throw.
    expect(() => service.assert(gate)).toThrow();
  });

  it('does not mark bare-metal Contabo plans as guided', () => {
    const service = new VopsWriteGateService(capabilities('monthly'));
    const gate = service.evaluate(
      CloudProvider.CONTABO,
      plan({ supportsHourlyBilling: false, bareMetal: true }),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.guided).toBe(false);
    expect(gate.reason).toContain('bare-metal');
  });
});
