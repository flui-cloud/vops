import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudProvider, CredentialUnavailableError, NodeSizeDto } from '@flui-cloud/infra';
import { compareErrors, compareWarnings } from '../src/catalog/compare-envelope';
import { VopsCatalogService } from '../src/catalog/vops-catalog.service';
import { PASSPHRASE_ENV } from '../src/lib/keyring/unlock';
import { clearVaultKey } from '../src/lib/keyring/vault-session';

/**
 * The comparison fan-out needs per-provider isolation: without it the first provider that
 * rejects aborts the loop and the user loses every other provider's prices — the command
 * that is supposed to work with nothing configured returns nothing at all.
 *
 * A provider that is left out has to be named with the reason it was left out, and
 * the two silent reasons ("nothing configured" / "the vault is sealed") are not the same
 * instruction to the user.
 *
 * The store is a bare temp dir: no vault, nothing configured, so the credential-priced
 * providers take the skip path and cannot reach the network.
 */
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

const emptyStore = {
  getCache: jest.fn().mockResolvedValue(null),
  setCache: jest.fn().mockResolvedValue(undefined),
};

/** Every provider prices, except the ones told to fail. */
function service(failures: Partial<Record<CloudProvider, Error>>): VopsCatalogService {
  const providers = {
    getProvider: (provider: CloudProvider) => ({
      getNodeSizes: async (): Promise<NodeSizeDto[]> => {
        const failure = failures[provider];
        if (failure) throw failure;
        return [size(provider)];
      },
    }),
  };
  return new VopsCatalogService(providers as never, capabilities as never, emptyStore as never);
}

describe('one provider must not empty the comparison', () => {
  let base: string;
  const prevDir = process.env.VOPS_CONFIG_DIR;
  const prevPass = process.env[PASSPHRASE_ENV];

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-isolate-'));
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

  it('keeps the rows of the providers that answered when one rejects', async () => {
    const report = await service({
      [CloudProvider.OVH]: new Error('OVH catalog is down'),
    }).compareReport({});

    expect(report.rows.map((r) => r.plan).sort()).toEqual(['cherry-1', 'contabo-1']);
    expect(report.failed.map((f) => f.provider)).toEqual(['OVHcloud']);
  });

  it('reports the provider that failed with the code it would have had alone', async () => {
    const report = await service({
      [CloudProvider.CONTABO]: new CredentialUnavailableError('No credentials configured for contabo', 'contabo'),
    }).compareReport({});

    const errors = compareErrors(report);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('VOPS_CREDENTIALS_MISSING');
    expect(errors[0].category).toBe('auth');
    expect(errors[0].message).toContain('Contabo could not be priced');
    expect(report.rows.length).toBeGreaterThan(0);
  });

  it('still throws when the user named the provider — that failure is the command', async () => {
    const svc = service({ [CloudProvider.OVH]: new Error('OVH catalog is down') });

    await expect(svc.compareReport({ provider: 'ovh' })).rejects.toThrow('OVH catalog is down');
  });

  it('re-throws for the rows-only caller, which has nowhere to report the gap', async () => {
    const svc = service({ [CloudProvider.OVH]: new Error('OVH catalog is down') });

    await expect(svc.compare({})).rejects.toThrow('OVH catalog is down');
  });

  it('names an unconfigured provider as unconfigured, not as a sealed vault', async () => {
    const report = await service({}).compareReport({});

    const skipped = report.skipped.map((s) => [s.provider, s.cause]);
    expect(skipped).toEqual([
      ['Hetzner Cloud', 'unconfigured'],
      ['Scaleway', 'unconfigured'],
    ]);
    expect(report.skipped[0].reason).toContain('no credential is configured');
    expect(compareWarnings(report).map((w) => w.code)).toEqual([
      'VOPS_PROVIDER_SKIPPED',
      'VOPS_PROVIDER_SKIPPED',
    ]);
    expect(compareErrors(report)).toEqual([]);
  });
});
