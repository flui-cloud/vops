import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudProvider } from '@flui-cloud/infra';

const TMP = path.join(os.tmpdir(), 'vops-cred-svc-test');

const field = (key: string, required = true, secret = true) => ({
  key,
  label: key,
  providerLabel: key,
  hint: '',
  secret,
  required,
});

const INFO: Record<string, any> = {
  hetzner: { displayName: 'Hetzner Cloud', credentialFields: { type: 'api_key', supportsExpiry: true, fields: [field('apiKey')] } },
  scaleway: { displayName: 'Scaleway', credentialFields: { type: 'access_key_secret', supportsExpiry: false, fields: [field('accessKey', true, false), field('secretKey')] } },
  contabo: { displayName: 'Contabo', credentialFields: { type: 'user_password', supportsExpiry: false, fields: [field('clientId', true, false), field('clientSecret'), field('username', true, false), field('password')] } },
  cherry: { displayName: 'Cherry Servers', credentialFields: { type: 'api_key', supportsExpiry: false, fields: [field('apiKey'), field('projectId', true, false)] } },
};

const fakeFactory: any = {
  getCapabilitiesService: (provider: CloudProvider) => ({
    getProviderInfo: async () => ({ id: provider, ...INFO[provider] }),
    validateCredentials: async (creds: any) => ({ success: !!creds.apiKey, message: creds.apiKey ? 'ok' : 'no token' }),
  }),
};

// Import AFTER setting VOPS_CONFIG_DIR so the store lands in the temp dir.
const load = () => {
  process.env.VOPS_CONFIG_DIR = TMP;
  const { VopsCredentialsService } = require('../src/credentials/vops-credentials.service');
  return new VopsCredentialsService(fakeFactory);
};

describe('VopsCredentialsService', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    for (const k of ['CHERRY_API_KEY', 'CHERRY_PROJECT_ID']) delete process.env[k];
  });
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('lists the configurable providers with field metadata and no secret values', async () => {
    const list = await load().list();
    expect(list.map((p: any) => p.provider).sort()).toEqual(['cherry', 'contabo', 'hetzner', 'scaleway']);
    const cherry = list.find((p: any) => p.provider === 'cherry');
    expect(cherry.configured).toBe(false);
    expect(cherry.fields.map((f: any) => f.key)).toEqual(['apiKey', 'projectId']);
    // metadata only — never a `value` on the fields
    expect(cherry.fields.every((f: any) => !('value' in f))).toBe(true);
  });

  it('saves valid credentials, persists them, and hydrates env', async () => {
    const svc = load();
    const res = await svc.save('cherry', { apiKey: 'tok', projectId: 'p1' });
    expect(res).toEqual({ provider: 'cherry', configured: true, validation: { ok: true, message: 'ok' } });
    expect(process.env.CHERRY_API_KEY).toBe('tok');
    expect(process.env.CHERRY_PROJECT_ID).toBe('p1');
    const after = await svc.list();
    expect(after.find((p: any) => p.provider === 'cherry').configured).toBe(true);
  });

  it('rejects when a required field is missing', async () => {
    await expect(load().save('cherry', { apiKey: 'tok' })).rejects.toThrow(/projectId/);
  });

  it('persists only declared fields (drops stray keys)', async () => {
    const svc = load();
    await svc.save('cherry', { apiKey: 'tok', projectId: 'p1', evil: 'x' } as any);
    const { LocalConfigStore } = require('../src/lib/config/local-config-store');
    const stored = new LocalConfigStore().getCredentials(CloudProvider.CHERRY);
    expect(stored).toEqual({ apiKey: 'tok', projectId: 'p1' });
  });

  it('removes credentials from store and env', async () => {
    const svc = load();
    await svc.save('cherry', { apiKey: 'tok', projectId: 'p1' });
    const res = svc.remove('cherry');
    expect(res).toEqual({ provider: 'cherry', configured: false });
    expect(process.env.CHERRY_API_KEY).toBeUndefined();
    const list = await svc.list();
    expect(list.find((p: any) => p.provider === 'cherry').configured).toBe(false);
  });
});
