import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CloudProvider,
  HetznerProviderService,
  NodeSizeDto,
  isCredentialError,
  isCredentialRejected,
  isCredentialStoreLocked,
} from '@flui-cloud/infra';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { toFailure } from '../src/agent-api/agent-output';
import { VopsCatalogService } from '../src/catalog/vops-catalog.service';
import { PASSPHRASE_ENV } from '../src/lib/keyring/unlock';
import { VaultLockedError, clearVaultKey } from '../src/lib/keyring/vault-session';
import { AllExceptionsFilter } from '../src/local-api/all-exceptions.filter';

/**
 * A locked vault must not die inside the provider layer's degrade-to-empty
 * catch. Recognising only a credential error or a raw 401, `rethrowIfCredentialError`
 * turns `VaultLockedError` into a bare "Failed to fetch node sizes" and the local API
 * answers 502 instead of 423 — leaving the dashboard unable to tell "unlock your vault"
 * from "the provider is down".
 *
 * It is a THIRD state, not a credential error: these tests also pin that it stays
 * out of `isCredentialError`, so a locked vault never reports as a missing or
 * invalid credential (auth / exit 7), whose remedy is a different one.
 */
const config = { get: (_key: string, fallback?: string) => fallback } as never;
const locked = {
  getActiveApiToken: async () => {
    throw new VaultLockedError();
  },
} as never;

function hetzner(): HetznerProviderService {
  return new HetznerProviderService(config, locked, {} as never, {} as never, {} as never);
}

describe('a locked vault survives the provider boundary', () => {
  it('propagates out of getNodeSizes instead of "Failed to fetch node sizes"', async () => {
    await expect(hetzner().getNodeSizes(true)).rejects.toThrow(VaultLockedError);
    await expect(hetzner().getNodeSizes(true)).rejects.toThrow('vops keyring unlock');
  });

  it('propagates out of a degrade-to-empty read instead of an empty list', async () => {
    await expect(hetzner().listServersAsDto()).rejects.toThrow(VaultLockedError);
  });

  it('is recognised by the marker, not by the class — a duplicated copy still matches', () => {
    expect(isCredentialStoreLocked(new VaultLockedError())).toBe(true);
    expect(isCredentialStoreLocked(new Error('Failed to fetch node sizes'))).toBe(false);
  });
});

describe('a locked vault is not a credential error', () => {
  const error = new VaultLockedError();

  it('stays out of the credential duck-types', () => {
    expect(isCredentialError(error)).toBe(false);
    expect(isCredentialRejected(error)).toBe(false);
  });

  it('does not reach the CLI as a missing/invalid credential (exit 7)', () => {
    const failure = toFailure(error);

    expect(failure.error.code).not.toBe('VOPS_CREDENTIALS_MISSING');
    expect(failure.error.code).not.toBe('VOPS_CREDENTIALS_INVALID');
    expect(failure.exitCode).not.toBe(ExitCode.AUTH);
    expect(failure.error.message).toContain('vops keyring unlock');
  });
});

describe('the local API turns it into 423 Locked', () => {
  function respond(exception: unknown): { status: number; body: unknown } {
    const captured = { status: 0, body: undefined as unknown };
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => res }) };
    new AllExceptionsFilter().catch(exception, host as never);
    return captured;
  }

  it('answers 423 with a locked-vault body', () => {
    const out = respond(new VaultLockedError());

    expect(out.status).toBe(423);
    expect(out.body).toMatchObject({ statusCode: 423, error: 'Locked' });
    expect((out.body as { message: string }).message).toContain('vops keyring unlock');
  });

  it('still answers 502 for a real provider failure', () => {
    expect(respond(new Error('Hetzner API 503')).status).toBe(502);
  });
});

/** The progressive unlock must not break by a different door: `compare` with no provider named keeps
 * answering rows on a locked vault, even for a provider whose client reaches the
 * credential path anyway — that provider is left out and named, never thrown. */
describe('compare with no provider named', () => {
  let base: string;
  const prevDir = process.env.VOPS_CONFIG_DIR;
  const prevPass = process.env[PASSPHRASE_ENV];

  const capabilities = {
    getCapabilitiesService: () => ({
      getStaticCapabilities: () => ({ pricing: { currency: 'EUR' } }),
    }),
  };

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

  /** Contabo prices statically, so `comparableSizes` does not screen it — a client
   * that still opens the store is exactly the unscreened path. */
  function service(): VopsCatalogService {
    const providers = {
      getProvider: (provider: CloudProvider) => ({
        getNodeSizes: async (): Promise<NodeSizeDto[]> => {
          if (provider === CloudProvider.CONTABO) throw new VaultLockedError();
          return [size(provider)];
        },
      }),
    };
    const store = {
      getCache: jest.fn().mockResolvedValue(null),
      setCache: jest.fn().mockResolvedValue(undefined),
    };
    return new VopsCatalogService(providers as never, capabilities as never, store as never);
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-f18-'));
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

  it('returns the providers it could price rather than failing', async () => {
    const rows = await service().compare({});

    expect(rows.map((r) => r.plan)).toContain('ovh-1');
    expect(rows.map((r) => r.plan)).not.toContain('contabo-1');
  });

  it('names the sealed provider as skipped, not failed', async () => {
    const report = await service().compareReport({});

    expect(report.failed).toEqual([]);
    expect(report.skipped.find((s) => s.provider === 'Contabo')?.cause).toBe('sealed');
  });
});
