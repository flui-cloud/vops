import { VopsServerFirewallService } from '../src/firewall/vops-server-firewall.service';
import { VopsFirewall } from '../src/dto/firewall.dto';
import { VopsHost } from '../src/hosts/host.model';

const SERVER_ID = '149137065';

/** A foreign firewall guarding our server. */
const FLUI_FW: VopsFirewall = {
  id: '11274697',
  name: 'flui-control-firewall-16bd88ac',
  rules: [
    { description: 'SSH access for server management', direction: 'in', protocol: 'tcp', port: '22', sourceIps: ['95.246.69.217/32'] },
    { description: 'HTTP Ingress (Traefik)', direction: 'in', protocol: 'tcp', port: '80', sourceIps: ['0.0.0.0/0'] },
  ],
  appliedTo: [{ serverId: SERVER_ID }],
} as VopsFirewall;

const OWN_FW: VopsFirewall = {
  id: '999',
  name: 'vops-control-cluster-master',
  rules: [{ description: 'SSH', direction: 'in', protocol: 'tcp', port: '22', sourceIps: ['0.0.0.0/0'] }],
  appliedTo: [{ serverId: SERVER_ID }],
} as VopsFirewall;

const UNRELATED_FW: VopsFirewall = {
  id: '726556',
  name: 'basic-firewall',
  rules: [],
  appliedTo: [{ serverId: 'some-other-server' }],
} as VopsFirewall;

const host = (over: Partial<VopsHost> = {}): VopsHost => ({
  name: 'control-cluster-master', address: '62.238.51.202', user: 'root', port: 22,
  provider: 'hetzner', providerServerId: SERVER_ID, userKeyName: 'k',
  opsKeyInstalled: false, tags: [], addedAt: '2026-01-01T00:00:00.000Z', ...over,
});

/** No host-level nftables anywhere — isolate the provider plane. */
function svc(list: VopsFirewall[], h: VopsHost) {
  const hosts = { show: () => h };
  const hostFw = { detectForeign: async () => null };
  const providerFw = { list: async () => list };
  return new VopsServerFirewallService(hosts as never, hostFw as never, providerFw as never);
}

describe('provider firewall detection — a guarded host is never reported as open', () => {
  it('a foreign firewall applied to the server is detected read-only and cedes management', async () => {
    const v = await svc([FLUI_FW, UNRELATED_FW], host()).get('control-cluster-master');
    expect(v.engine).toBe('provider');
    expect(v.active).toBe(false); // vops owns no firewall here…
    expect(v.cededTo).toBe('provider');
    expect(v.detected?.source).toBe('provider');
    expect(v.detected?.active).toBe(true); // …but the server IS guarded
    expect(v.detected?.name).toBe('flui-control-firewall-16bd88ac');
    expect(v.detected?.providerFirewallId).toBe('11274697');
    expect(v.detected?.services.map((s) => s.port)).toContain('22');
  });

  it('a firewall applied to some OTHER server is not mistaken for ours', async () => {
    const v = await svc([UNRELATED_FW], host()).get('control-cluster-master');
    expect(v.detected).toBeUndefined();
    expect(v.cededTo).toBeUndefined();
    expect(v.active).toBe(false);
  });

  it("vops's own applied firewall stays editable — no ceding, no foreign detection", async () => {
    const v = await svc([OWN_FW, UNRELATED_FW], host()).get('control-cluster-master');
    expect(v.active).toBe(true);
    expect(v.cededTo).toBeUndefined();
    expect(v.providerFirewallId).toBe('999');
  });

  it('refuses to attach a second firewall to a server someone else already guards', async () => {
    const s = svc([FLUI_FW], host());
    await expect(
      s.set('control-cluster-master', [{ id: 'https', label: 'Web', protocol: 'tcp', port: '443', sources: [], enabled: true }]),
    ).rejects.toThrow(/already guards|didn't create it/i);
  });

  it('a host with no providerServerId cannot match anything by accident', async () => {
    const v = await svc([FLUI_FW], host({ providerServerId: undefined })).get('control-cluster-master');
    expect(v.detected).toBeUndefined();
    expect(v.cededTo).toBeUndefined();
  });
});
