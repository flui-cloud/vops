import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CloudProvider,
  CredentialUnavailableError,
  HetznerFirewallService,
  HetznerProviderService,
  OvhProviderService,
  isCredentialError,
} from '@flui-cloud/infra';
import { toFailure } from '../src/agent-api/agent-output';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { LocalCredentialProvider } from '../src/lib/credentials/local-credential-provider';

/**
 * A missing credential must not be caught by the provider layer's
 * degrade-to-empty guard and reported as `status: "success", data: []`, exit 0 —
 * the same answer as an account with nothing in it. The guard stays (a mapping
 * quirk on one server must not sink the list); credential failures pass
 * through it and reach the agent envelope as auth/exit 7.
 */
const config = { get: (_key: string, fallback?: string) => fallback } as never;
const missing = new CredentialUnavailableError('No credentials configured for hetzner.', 'hetzner');
const credentials = {
  getActiveApiToken: async () => {
    throw missing;
  },
} as never;

function hetzner(): HetznerProviderService {
  return new HetznerProviderService(config, credentials, {} as never, {} as never, {} as never);
}

describe('a credential error is never an empty result', () => {
  it('propagates out of listServersAsDto instead of logging and returning []', async () => {
    await expect(hetzner().listServersAsDto()).rejects.toThrow(CredentialUnavailableError);
  });

  it('propagates out of listSSHKeys', async () => {
    await expect(hetzner().listSSHKeys()).rejects.toThrow(CredentialUnavailableError);
  });

  it('propagates out of getServerDetailsAsDto instead of answering "not found"', async () => {
    await expect(hetzner().getServerDetailsAsDto('42')).rejects.toThrow(CredentialUnavailableError);
  });

  it('propagates out of listFirewalls', async () => {
    const svc = new HetznerFirewallService(config, credentials, {} as never);

    await expect(svc.listFirewalls()).rejects.toThrow(CredentialUnavailableError);
  });

  it('is what OVH raises when the OpenStack environment is unset', async () => {
    const svc = new OvhProviderService(config);

    await expect(svc.listVNets()).rejects.toThrow(CredentialUnavailableError);
    await expect(svc.listServersAsDto()).rejects.toThrow(CredentialUnavailableError);
  });
});

describe('the degrade-to-empty guard still holds for everything else', () => {
  it('returns [] for an authenticated account that genuinely has no servers', async () => {
    const svc = hetzner();
    jest
      .spyOn(svc as never, 'createServersApi')
      .mockResolvedValue({ listServers: async () => ({ data: { servers: [] } }) } as never);

    await expect(svc.listServersAsDto()).resolves.toEqual([]);
  });

  it('returns [] when the provider API itself fails', async () => {
    const svc = hetzner();
    jest
      .spyOn(svc as never, 'createServersApi')
      .mockRejectedValue(new Error('Hetzner API 503') as never);

    await expect(svc.listServersAsDto()).resolves.toEqual([]);
  });
});

describe('the CLI turns it into the documented exit code', () => {
  it('maps a credential error to VOPS_CREDENTIALS_MISSING / auth / 7', () => {
    const failure = toFailure(missing);

    expect(failure.error.code).toBe('VOPS_CREDENTIALS_MISSING');
    expect(failure.error.category).toBe('auth');
    expect(failure.error.recoverable).toBe(false);
    expect(failure.exitCode).toBe(ExitCode.AUTH);
  });

  it('leaves every other failure operational', () => {
    const failure = toFailure(new Error('ssh: connect timed out'));

    expect(failure.error.code).toBe('VOPS_OPERATION_FAILED');
    expect(failure.exitCode).toBe(ExitCode.FAILURE);
  });
});

describe('LocalCredentialProvider', () => {
  let base: string;
  const prevDir = process.env.VOPS_CONFIG_DIR;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-cred-'));
    process.env.VOPS_CONFIG_DIR = base;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevDir;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('raises a recognisable credential error when nothing is configured', async () => {
    const provider = new LocalCredentialProvider();

    const error = await provider
      .getActiveApiToken(CloudProvider.HETZNER)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(isCredentialError(error)).toBe(true);
    expect((error as Error).message).toContain('vops config set hetzner');
  });
});
