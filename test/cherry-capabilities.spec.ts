import { CherryCapabilitiesService, CloudProvider } from '@flui-cloud/infra';

describe('CherryCapabilitiesService', () => {
  const svc = new CherryCapabilitiesService();

  it('advertises hourly provisioning with the host-nftables firewall', () => {
    const caps = svc.getStaticCapabilities();
    expect(caps.credentialType).toBe('api_key');
    expect(caps.pricing.billingCycle).toBe('hourly');
    expect(caps.pricing.currency).toBe('EUR');
    expect(caps.features.nodeProvisioning).toBe(true);
    // Cherry has no per-server firewall API → host-level nftables, like Contabo/OVH.
    expect(caps.firewall.backend).toBe('host-nftables');
  });

  it('declares the uniform credential fields (api token + project id)', async () => {
    const info = await svc.getProviderInfo();
    expect(info.id).toBe(CloudProvider.CHERRY);
    expect(info.credentialFields.type).toBe('api_key');
    const keys = info.credentialFields.fields.map((f) => f.key);
    expect(keys).toEqual(['apiKey', 'projectId']);
    const apiKey = info.credentialFields.fields.find((f) => f.key === 'apiKey');
    const projectId = info.credentialFields.fields.find((f) => f.key === 'projectId');
    expect(apiKey?.secret).toBe(true);
    expect(projectId?.secret).toBe(false);
  });

  it('rejects credentials that are not an API token', async () => {
    const res = await svc.validateCredentials({
      provider: CloudProvider.CHERRY,
      type: 'access_key_secret' as never,
    });
    expect(res.success).toBe(false);
  });
});
