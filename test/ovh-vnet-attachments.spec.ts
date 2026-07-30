import {
  OvhProviderService,
  OpenStackClient,
  NeutronPort,
  NeutronNetwork,
  NeutronSubnet,
  attachedServerIdsOf,
  isInstancePort,
} from '@flui-cloud/infra';

const NET_ID = '1f7d012a-21e1-4875-976b-7437d2336065';
const OTHER_NET_ID = '9c0a11bb-7f2e-4d55-b0aa-3a1f0d2c4e77';
const INSTANCE_ID = '4c2b7c31-9d55-4d0d-8f3c-1b6a7d2e5f90';

const port = (p: Partial<NeutronPort>): NeutronPort => ({
  id: 'port-' + (p.id ?? Math.random().toString(16).slice(2)),
  device_id: '',
  network_id: NET_ID,
  security_groups: [],
  ...p,
});

/** The two ports OVH's Neutron creates by itself for every DHCP-enabled subnet. */
const dhcpPorts = (): NeutronPort[] => [
  port({
    id: 'dhcp-a',
    device_owner: 'network:dhcp',
    device_id: `dhcpa461502c-a83b-50d7-ab88-8cff97ce74b4-${NET_ID}`,
  }),
  port({
    id: 'dhcp-b',
    device_owner: 'network:dhcp',
    device_id: `dhcp70ec69a6-fa8c-50dc-8beb-1d2517c37fdc-${NET_ID}`,
  }),
];

const instancePort = (deviceId = INSTANCE_ID, networkId = NET_ID): NeutronPort =>
  port({ id: 'compute-1', device_owner: 'compute:eu-west-1a', device_id: deviceId, network_id: networkId });

const routerPort = (): NeutronPort =>
  port({
    id: 'router-1',
    device_owner: 'network:router_interface',
    device_id: 'a6d8e0a2-04e2-4a4c-8f31-0d54a2f6be21',
  });

const unownedPort = (): NeutronPort =>
  port({ id: 'unowned-1', device_owner: '', device_id: 'bb0f2f52-7cba-4a5e-9e63-2f7ad1cc4b10' });

const network: NeutronNetwork = { id: NET_ID, name: 'vops-f200-vnet2', subnets: ['sub-1'] };
const otherNetwork: NeutronNetwork = { id: OTHER_NET_ID, name: 'vops-other', subnets: ['sub-2'] };
const subnet = (id: string, cidr: string, networkId: string): NeutronSubnet => ({
  id,
  name: 'vops-subnet',
  network_id: networkId,
  cidr,
  gateway_ip: cidr.replace(/0\/\d+$/, '1'),
  ip_version: 4,
  enable_dhcp: true,
});
const subnets: NeutronSubnet[] = [
  subnet('sub-1', '10.61.0.0/24', NET_ID),
  subnet('sub-2', '10.62.0.0/24', OTHER_NET_ID),
];

class FakeOpenStack {
  portListCalls: string[] = [];
  portListFails = false;
  constructor(
    private readonly networks: NeutronNetwork[],
    private readonly ports: NeutronPort[],
  ) {}
  async regions(): Promise<string[]> {
    return ['DE1'];
  }
  async listNetworksFull(): Promise<NeutronNetwork[]> {
    return this.networks;
  }
  async getNetwork(id: string): Promise<NeutronNetwork | null> {
    return this.networks.find((n) => n.id === id) ?? null;
  }
  async listSubnets(_region: string, networkId?: string): Promise<NeutronSubnet[]> {
    return networkId ? subnets.filter((s) => s.network_id === networkId) : subnets;
  }
  async listPorts(region: string): Promise<NeutronPort[]> {
    this.portListCalls.push(`listPorts:${region}`);
    if (this.portListFails) throw new Error('Neutron GET /ports → 403');
    return this.ports;
  }
  async listNetworkPorts(region: string, networkId: string): Promise<NeutronPort[]> {
    this.portListCalls.push(`listNetworkPorts:${region}:${networkId}`);
    if (this.portListFails) throw new Error('Neutron GET /ports → 403');
    return this.ports.filter((p) => p.network_id === networkId);
  }
}

const svc = (client: FakeOpenStack) =>
  new OvhProviderService({ get: () => undefined } as never, client as unknown as OpenStackClient);

describe('OVH vnet attachments', () => {
  describe('port classification by device_owner', () => {
    it('a Neutron DHCP agent port is not an instance port', () => {
      for (const p of dhcpPorts()) expect(isInstancePort(p)).toBe(false);
    });
    it('a compute:<az> port is an instance port', () => {
      expect(isInstancePort(instancePort())).toBe(true);
      expect(isInstancePort({ device_owner: 'compute:nova', device_id: INSTANCE_ID })).toBe(true);
    });
    it('a router interface port is not an instance port', () => {
      expect(isInstancePort(routerPort())).toBe(false);
    });
    it('a port with an empty or missing device_owner is not an instance port', () => {
      expect(isInstancePort(unownedPort())).toBe(false);
      expect(isInstancePort({ device_id: INSTANCE_ID })).toBe(false);
    });
    it('a compute port with no device_id yields nothing', () => {
      expect(attachedServerIdsOf(NET_ID, [port({ device_owner: 'compute:nova' })])).toEqual([]);
    });
    it('keeps only compute ports of the asked network, deduped', () => {
      expect(
        attachedServerIdsOf(NET_ID, [
          ...dhcpPorts(),
          routerPort(),
          unownedPort(),
          instancePort(),
          instancePort(),
          instancePort('other-instance', OTHER_NET_ID),
        ]),
      ).toEqual([INSTANCE_ID]);
    });
  });

  describe('show path — getVNet', () => {
    it('a fresh network with nothing attached reports no attached servers', async () => {
      const details = await svc(new FakeOpenStack([network], dhcpPorts())).getVNet(`DE1/${NET_ID}`);
      expect(details?.attachedServerIds).toEqual([]);
    });

    it('reports the instance id and never a dhcp/router device_id', async () => {
      const client = new FakeOpenStack([network], [...dhcpPorts(), routerPort(), instancePort()]);
      const details = await svc(client).getVNet(`DE1/${NET_ID}`);
      expect(details?.attachedServerIds).toEqual([INSTANCE_ID]);
    });

    it('degrades to no attachments when the port list fails, keeping the network', async () => {
      const client = new FakeOpenStack([network], dhcpPorts());
      client.portListFails = true;
      const details = await svc(client).getVNet(`DE1/${NET_ID}`);
      expect(details?.id).toBe(`DE1/${NET_ID}`);
      expect(details?.attachedServerIds).toEqual([]);
    });
  });

  describe('list path — listVNets', () => {
    it('reports real attachments instead of always empty', async () => {
      const client = new FakeOpenStack([network], [...dhcpPorts(), instancePort()]);
      const [vnet] = await svc(client).listVNets();
      expect(vnet.attachedServerIds).toEqual([INSTANCE_ID]);
      expect(client.portListCalls).toEqual(['listPorts:DE1']);
    });

    it('agrees with getVNet on the same network in the same moment', async () => {
      const ports = [...dhcpPorts(), routerPort(), unownedPort(), instancePort()];
      const listed = await svc(new FakeOpenStack([network, otherNetwork], ports)).listVNets();
      const shown = await svc(new FakeOpenStack([network, otherNetwork], ports)).getVNet(
        `DE1/${NET_ID}`,
      );
      const fromList = listed.find((v) => v.id === `DE1/${NET_ID}`);
      expect(fromList?.attachedServerIds).toEqual(shown?.attachedServerIds);
      expect(fromList?.attachedServerIds).toEqual([INSTANCE_ID]);
    });

    it('does not attribute another network’s instance port', async () => {
      const client = new FakeOpenStack(
        [network, otherNetwork],
        [...dhcpPorts(), instancePort('other-instance', OTHER_NET_ID)],
      );
      const listed = await svc(client).listVNets();
      expect(listed.find((v) => v.id === `DE1/${NET_ID}`)?.attachedServerIds).toEqual([]);
      expect(listed.find((v) => v.id === `DE1/${OTHER_NET_ID}`)?.attachedServerIds).toEqual([
        'other-instance',
      ]);
    });

    it('still lists the networks when the region port list fails', async () => {
      const client = new FakeOpenStack([network], [...dhcpPorts(), instancePort()]);
      client.portListFails = true;
      const listed = await svc(client).listVNets();
      expect(listed.map((v) => v.id)).toEqual([`DE1/${NET_ID}`]);
      expect(listed[0].attachedServerIds).toEqual([]);
    });
  });
});
