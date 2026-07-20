import {
  CloudProvider,
  CherryProviderService,
  CherryClient,
  CherryServer,
  CherrySshKey,
} from '@flui-cloud/infra';

class FakeClient {
  deployArgs: { projectId: string; req: any } | null = null;
  deleted: string[] = [];
  servers: CherryServer[] = [];
  sshKeys: CherrySshKey[] = [];
  created: Array<{ label: string; key: string }> = [];

  async deployServer(projectId: string, req: any): Promise<CherryServer> {
    this.deployArgs = { projectId, req };
    return {
      id: 77,
      hostname: req.hostname,
      status: 'pending',
      ip_addresses: [{ address: '1.2.3.4', type: 'primary-ip' }],
    };
  }
  async getServer(id: string): Promise<CherryServer> {
    const found = this.servers.find((s) => String(s.id) === id);
    if (!found) throw new Error(`Cherry API GET /servers/${id} → 404`);
    return found;
  }
  async listProjectServers(): Promise<CherryServer[]> {
    return this.servers;
  }
  async deleteServer(id: string): Promise<void> {
    this.deleted.push(id);
  }
  async listSshKeys(): Promise<CherrySshKey[]> {
    return this.sshKeys;
  }
  async createSshKey(label: string, key: string): Promise<CherrySshKey> {
    this.created.push({ label, key });
    const created = { id: 900 + this.created.length, label, key, fingerprint: `fp-${label}` };
    this.sshKeys.push(created);
    return created;
  }
}

const config = (vars: Record<string, string>) =>
  ({ get: (k: string) => vars[k] }) as any;

const svc = (client: FakeClient, vars: Record<string, string> = { CHERRY_PROJECT_ID: 'proj-9' }) =>
  new CherryProviderService(config(vars), undefined, client as unknown as CherryClient);

describe('CherryProviderService provisioning', () => {
  it('maps a create config to a Cherry deploy request (hourly, tags, ssh keys)', async () => {
    const client = new FakeClient();
    const result = await svc(client).createServer({
      name: 'vops-b2-1-123',
      server_type: 'B2-1-1gb-20s-shared',
      location: 'LT-Siauliai',
      image: 'ubuntu_24_04_64bit',
      ssh_keys: ['5'],
      labels: [{ key: 'managed-by', value: 'vops' }],
    });
    expect(client.deployArgs?.projectId).toBe('proj-9');
    expect(client.deployArgs?.req).toEqual({
      plan: 'B2-1-1gb-20s-shared',
      region: 'LT-Siauliai',
      image: 'ubuntu_24_04_64bit',
      hostname: 'vops-b2-1-123',
      cycle: 'hourly',
      ssh_keys: ['5'],
      tags: { 'managed-by': 'vops' },
    });
    expect(result).toEqual({ serverId: '77', ipAddress: '1.2.3.4', status: 'pending' });
  });

  it('falls back to CHERRY_IMAGE and refuses when no image is available', async () => {
    const client = new FakeClient();
    await svc(client, { CHERRY_PROJECT_ID: 'proj-9', CHERRY_IMAGE: 'debian_12' }).createServer({
      name: 'vops-x',
      server_type: 'B2-1',
      location: 'LT-Siauliai',
    });
    expect(client.deployArgs?.req.image).toBe('debian_12');

    await expect(
      svc(client, { CHERRY_PROJECT_ID: 'proj-9' }).createServer({
        name: 'vops-x',
        server_type: 'B2-1',
        location: 'LT-Siauliai',
      }),
    ).rejects.toThrow(/image/i);
  });

  it('deletes by server id and reports it', async () => {
    const client = new FakeClient();
    const res = await svc(client).deleteServer({
      server_id: '77',
      provider: CloudProvider.CHERRY,
    });
    expect(client.deleted).toEqual(['77']);
    expect(res.message).toMatch(/77/);
  });

  it('reads status and lists servers as DTOs', async () => {
    const client = new FakeClient();
    client.servers = [
      { id: 77, hostname: 'vops-a', status: 'active', region: 'LT-Siauliai', plan: 'B2-1' },
    ];
    expect(await svc(client).getServerStatus('77')).toBe('active');
    const list = await svc(client).listServersAsDto();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('vops-a');
    expect(list[0].provider).toBe(CloudProvider.CHERRY);
  });

  it('resolveSSHKeys reuses cached ids, matches by fingerprint, else creates', async () => {
    const client = new FakeClient();
    client.sshKeys = [{ id: 12, label: 'known', key: 'ssh-ed25519 AAA', fingerprint: 'fp-known' }];
    const ids = await svc(client).resolveSSHKeys([
      { fluiId: 'a', name: 'cached', publicKey: 'ssh-ed25519 X', fingerprint: 'fpx', existingProviderId: '999' },
      { fluiId: 'b', name: 'known', publicKey: 'ssh-ed25519 AAA', fingerprint: 'fp-known' },
      { fluiId: 'c', name: 'fresh', publicKey: 'ssh-ed25519 NEW', fingerprint: 'fp-fresh' },
    ]);
    expect(ids).toEqual(['999', '12', '901']);
    expect(client.created).toEqual([{ label: 'fresh', key: 'ssh-ed25519 NEW' }]);
  });

  it('testConnection authenticates when a token is set', async () => {
    const client = new FakeClient();
    const ok = await svc(client, { CHERRY_API_KEY: 'tok', CHERRY_PROJECT_ID: 'proj-9' }).testConnection();
    expect(ok.success).toBe(true);
  });
});
