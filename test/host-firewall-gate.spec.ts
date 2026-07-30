import { CloudProvider } from '@flui-cloud/infra';
import { hasNativeFirewall } from '../src/lib/providers';
import { VopsServersService } from '../src/servers/vops-servers.service';

describe('host-firewall applicability policy', () => {
  it('marks providers WITH a usable native firewall', () => {
    expect(hasNativeFirewall(CloudProvider.HETZNER)).toBe(true);
    expect(hasNativeFirewall(CloudProvider.SCALEWAY)).toBe(true);
  });

  it('marks providers WITHOUT one — the ones host-firewall is for', () => {
    expect(hasNativeFirewall(CloudProvider.CONTABO)).toBe(false);
    expect(hasNativeFirewall(CloudProvider.OVH)).toBe(false);
  });
});

describe('VopsServersService host-firewall gate', () => {
  // plan() runs the gate before touching any dependency, so dummy deps are fine.
  const svc = () =>
    new VopsServersService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const hostFirewall = { rules: [{ description: 'web', direction: 'in' as const, protocol: 'tcp' as const, port: '80' }] };

  it('rejects --host-firewall on a provider WITH a native firewall (Hetzner)', async () => {
    await expect(
      svc().plan({ provider: 'hetzner', plan: 'cx23', location: 'fsn1', hostFirewall }),
    ).rejects.toThrow(/native/i);
  });

  it('rejects --host-firewall on Scaleway too', async () => {
    await expect(
      svc().plan({ provider: 'scaleway', plan: 'DEV1-S', location: 'fr-par-1', hostFirewall }),
    ).rejects.toThrow(/vops firewall/);
  });
});
