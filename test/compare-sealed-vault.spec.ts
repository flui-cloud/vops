import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudProvider, NodeSizeDto } from '@flui-cloud/infra';
import { compareWarnings } from '../src/catalog/compare-envelope';
import { VopsCatalogService } from '../src/catalog/vops-catalog.service';
import { LocalConfigStore } from '../src/lib/config/local-config-store';
import { hasReachableCredential } from '../src/lib/credentials/provider-credentials';
import { LocalCredentialProvider } from '../src/lib/credentials/local-credential-provider';
import { PASSPHRASE_ENV, ensureVaultUnlocked } from '../src/lib/keyring/unlock';
import { clearVaultKey } from '../src/lib/keyring/vault-session';
import { createVault } from '../src/lib/keyring/vault-store';
import { needsCredentialToPrice } from '../src/lib/providers';

/**
 * Progressive unlock, from `compare`'s side. Hetzner and Scaleway only name a
 * price through their authenticated API, so a fan-out that enters the credential path lets a
 * sealed vault turn the one command that must work on a fresh install into a passphrase prompt
 * (`NoTtyError` with no terminal).
 *
 * These tests drive the REAL credential provider, unlock and vault against a temp
 * profile: a fake provider that never asks for a token could not have caught this.
 */
const PASSPHRASE = 'correct horse battery staple';

function size(provider: CloudProvider): NodeSizeDto {
  return {
    id: `${provider}-1`,
    name: `${provider}-1`,
    description: '2 vCPU, 4 GB RAM',
    cores: 2,
    memory: 4,
    disk: 40,
    storageType: 'local',
    cpuType: 'shared',
    architecture: 'x86',
    deprecated: false,
    bareMetal: false,
    managedFirewall: false,
    supportsHourlyBilling: true,
    prices: [
      {
        location: 'eu-1',
        priceHourly: { net: '0.01', gross: '0.012' },
        priceMonthly: { net: '5', gross: '6' },
      },
    ],
    locations: [],
    availability: [],
  };
}

const capabilities = {
  getCapabilitiesService: () => ({
    getStaticCapabilities: () => ({ pricing: { currency: 'EUR' } }),
  }),
};

function fakeStore(cache: Record<string, unknown> = {}) {
  return {
    getCache: jest.fn(async (key: string) => cache[key] ?? null),
    setCache: jest.fn().mockResolvedValue(undefined),
  };
}

/** Providers that price behind a token read one exactly as the real SDKs do. */
function providerFactory(asked: CloudProvider[]) {
  const credentials = new LocalCredentialProvider();
  return {
    getProvider: (provider: CloudProvider) => ({
      getNodeSizes: async (): Promise<NodeSizeDto[]> => {
        asked.push(provider);
        if (needsCredentialToPrice(provider)) {
          await credentials.getActiveApiToken(provider);
        }
        return [size(provider)];
      },
    }),
  };
}

function service(asked: CloudProvider[], store = fakeStore()): VopsCatalogService {
  return new VopsCatalogService(
    providerFactory(asked) as never,
    capabilities as never,
    store as never,
  );
}

describe('compare under a sealed vault', () => {
  let base: string;
  let profile: string;
  const prevDir = process.env.VOPS_CONFIG_DIR;
  const prevPass = process.env[PASSPHRASE_ENV];

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-compare-'));
    profile = path.join(base, 'profiles', 'default');
    process.env.VOPS_CONFIG_DIR = base;
    delete process.env[PASSPHRASE_ENV];
    clearVaultKey();
    createVault(profile, PASSPHRASE);
  });

  afterEach(() => {
    clearVaultKey();
    if (prevDir === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevDir;
    if (prevPass === undefined) delete process.env[PASSPHRASE_ENV];
    else process.env[PASSPHRASE_ENV] = prevPass;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('returns the credential-free providers instead of asking for the passphrase', async () => {
    const asked: CloudProvider[] = [];

    const rows = await service(asked).compare({});

    expect(asked).not.toContain(CloudProvider.HETZNER);
    expect(asked).not.toContain(CloudProvider.SCALEWAY);
    expect(rows.map((r) => r.plan).sort()).toEqual(['cherry-1', 'contabo-1', 'ovh-1']);
  });

  it('names the providers it left out, so a partial comparison never reads as complete', async () => {
    const report = await service([]).compareReport({});

    expect(report.skipped.map((s) => s.provider).sort()).toEqual(['Hetzner Cloud', 'Scaleway']);
    expect(report.skipped[0].reason).toContain('the vault is sealed');
  });

  /** "no credential configured" and "vault sealed" are one silence today; they have
   * different remedies, so the skip has to say which one it was. */
  it('says the vault was sealed, not that the credential is missing', async () => {
    await ensureVaultUnlocked({ dir: profile, passphrase: PASSPHRASE, noDaemon: true });
    new LocalConfigStore().setToken('hetzner', 'tok-sealed');
    clearVaultKey();

    const report = await service([]).compareReport({});

    const hetzner = report.skipped.find((s) => s.provider === 'Hetzner Cloud');
    expect(hetzner?.cause).toBe('sealed');
    expect(hetzner?.reason).toContain('without a passphrase');
    expect(compareWarnings(report).map((w) => w.code)).toContain('VOPS_PROVIDER_VAULT_SEALED');
  });

  it('still prices a provider whose credential is reachable', async () => {
    await ensureVaultUnlocked({ dir: profile, passphrase: PASSPHRASE, noDaemon: true });
    new LocalConfigStore().setToken('hetzner', 'tok-sealed');
    const asked: CloudProvider[] = [];

    const rows = await service(asked).compare({});

    expect(asked).toContain(CloudProvider.HETZNER);
    expect(rows.map((r) => r.plan)).toContain('hetzner-1');
  });

  it('reports nothing skipped once every credential is reachable', async () => {
    await ensureVaultUnlocked({ dir: profile, passphrase: PASSPHRASE, noDaemon: true });
    new LocalConfigStore().setToken('hetzner', 'tok-sealed');
    new LocalConfigStore().setCredentials('scaleway', { secretKey: 'tok-scw' });

    const report = await service([]).compareReport({});

    expect(report.skipped).toEqual([]);
  });

  it('serves a cached catalog without consulting the credential store at all', async () => {
    const store = fakeStore({ 'nodesizes:hetzner': [size(CloudProvider.HETZNER)] });
    const asked: CloudProvider[] = [];

    const rows = await service(asked, store).compare({});

    expect(asked).not.toContain(CloudProvider.HETZNER);
    expect(rows.map((r) => r.plan)).toContain('hetzner-1');
  });

  it('keeps asking when the user names the provider — that credential is the request', async () => {
    const asked: CloudProvider[] = [];

    await expect(service(asked).compare({ provider: 'hetzner' })).rejects.toThrow();

    expect(asked).toEqual([CloudProvider.HETZNER]);
  });
});

describe('hasReachableCredential', () => {
  let base: string;
  const prevDir = process.env.VOPS_CONFIG_DIR;
  const prevPass = process.env[PASSPHRASE_ENV];

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-reach-'));
    process.env.VOPS_CONFIG_DIR = base;
    delete process.env[PASSPHRASE_ENV];
    clearVaultKey();
  });

  afterEach(() => {
    clearVaultKey();
    if (prevDir === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevDir;
    if (prevPass === undefined) delete process.env[PASSPHRASE_ENV];
    else process.env[PASSPHRASE_ENV] = prevPass;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('answers false for a sealed vault nobody has opened, without prompting', async () => {
    createVault(path.join(base, 'profiles', 'default'), PASSPHRASE);

    await expect(hasReachableCredential(CloudProvider.HETZNER)).resolves.toBe(false);
  });

  it('opens the vault from VOPS_PASSPHRASE and reads what is stored', async () => {
    const profile = path.join(base, 'profiles', 'default');
    createVault(profile, PASSPHRASE);
    await ensureVaultUnlocked({ dir: profile, passphrase: PASSPHRASE, noDaemon: true });
    new LocalConfigStore().setToken('hetzner', 'tok-sealed');
    clearVaultKey();
    process.env[PASSPHRASE_ENV] = PASSPHRASE;

    await expect(hasReachableCredential(CloudProvider.HETZNER)).resolves.toBe(true);
    await expect(hasReachableCredential(CloudProvider.SCALEWAY)).resolves.toBe(false);
  });

  it('answers from the legacy store without any vault at all', async () => {
    new LocalConfigStore().setToken('hetzner', 'tok-legacy');

    await expect(hasReachableCredential(CloudProvider.HETZNER)).resolves.toBe(true);
    await expect(hasReachableCredential(CloudProvider.SCALEWAY)).resolves.toBe(false);
  });
});
