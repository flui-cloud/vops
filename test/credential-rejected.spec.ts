import {
  CredentialRejectedError,
  CredentialUnavailableError,
  HetznerFirewallService,
  HetznerProviderService,
  ScalewayProviderService,
  isCredentialError,
  isCredentialRejected,
  rethrowIfCredentialError,
  rethrowIfCredentialsBlockedAll,
} from '@flui-cloud/infra';
import { toFailure } from '../src/agent-api/agent-output';
import { ExitCode } from '../src/agent-api/agent-envelope';

/**
 * A credential that is *present and wrong* must not be swallowed by the
 * degrade-to-empty guard: a revoked Hetzner token answering `status: "success",
 * data: [], exit 0` is the same envelope as an account with nothing in it, and
 * recognising credential *absence* alone is not enough.
 *
 * A provider 401 is converted to `CredentialRejectedError` inside the same
 * guard every read path already funnels through, and the CLI maps it to
 * `VOPS_CREDENTIALS_INVALID` / auth / exit 7. HTTP 403 stays operational on
 * purpose: providers use it for quota and scope, not only for a bad credential.
 */
const config = { get: (_key: string, fallback?: string) => fallback } as never;
const validToken = { getActiveApiToken: async () => 'a-token' } as never;

/** The real shape reaching the catch: axios, with hcloud's body under `response.data`. */
function unauthorized(message = 'the token you have provided is invalid'): Error {
  return Object.assign(new Error('Request failed with status code 401'), {
    isAxiosError: true,
    response: { status: 401, data: { error: { code: 'unauthorized', message } } },
  });
}

function forbidden(message = 'quota exceeded'): Error {
  return Object.assign(new Error('Request failed with status code 403'), {
    isAxiosError: true,
    response: { status: 403, data: { error: { code: 'resource_limit_exceeded', message } } },
  });
}

function hetzner(): HetznerProviderService {
  return new HetznerProviderService(config, validToken, {} as never, {} as never, {} as never);
}

describe('a refused credential is never an empty result', () => {
  it('propagates out of listServersAsDto instead of logging and returning []', async () => {
    const svc = hetzner();
    jest.spyOn(svc as never, 'createServersApi').mockRejectedValue(unauthorized() as never);

    await expect(svc.listServersAsDto()).rejects.toThrow(CredentialRejectedError);
  });

  it('carries the provider name and the provider’s own wording', async () => {
    const svc = hetzner();
    jest.spyOn(svc as never, 'createServersApi').mockRejectedValue(unauthorized() as never);

    const error = await svc.listServersAsDto().then(() => null, (e: unknown) => e);

    expect((error as Error).message).toContain('hetzner');
    expect((error as Error).message).toContain('the token you have provided is invalid');
    expect((error as CredentialRejectedError).provider).toBe('hetzner');
  });

  it('propagates out of listFirewalls', async () => {
    const svc = new HetznerFirewallService(config, validToken, {} as never);
    jest.spyOn(svc as never, 'createFirewallsApi').mockRejectedValue(unauthorized() as never);

    await expect(svc.listFirewalls()).rejects.toThrow(CredentialRejectedError);
  });

  it('propagates out of getNodeSizes instead of the bare "Failed to fetch node sizes"', async () => {
    const svc = hetzner();
    jest.spyOn(svc as never, 'createServerTypesApi').mockRejectedValue(unauthorized() as never);

    await expect(svc.getNodeSizes()).rejects.toThrow(CredentialRejectedError);
  });

  it('survives a fan-out read where every zone was refused', async () => {
    const refused = {
      listServers: async () => {
        throw unauthorized('denied authentication');
      },
    } as never;
    const svc = new ScalewayProviderService(
      validToken,
      {} as never,
      refused,
      refused,
      {} as never,
      {} as never,
    );

    await expect(svc.listServersAsDto()).rejects.toThrow(CredentialRejectedError);
  });
});

describe('the degrade-to-empty guard still holds for everything else', () => {
  it('keeps [] for an authenticated account that genuinely has no servers', async () => {
    const svc = hetzner();
    jest
      .spyOn(svc as never, 'createServersApi')
      .mockResolvedValue({ listServers: async () => ({ data: { servers: [] } }) } as never);

    await expect(svc.listServersAsDto()).resolves.toEqual([]);
  });

  it('keeps [] for a provider 5xx', async () => {
    const svc = hetzner();
    jest
      .spyOn(svc as never, 'createServersApi')
      .mockRejectedValue(Object.assign(new Error('Hetzner API 503'), { response: { status: 503 } }) as never);

    await expect(svc.listServersAsDto()).resolves.toEqual([]);
  });

  it('keeps [] for a 403 — quota and scope are not "your credential is wrong"', async () => {
    const svc = hetzner();
    jest.spyOn(svc as never, 'createServersApi').mockRejectedValue(forbidden() as never);

    await expect(svc.listServersAsDto()).resolves.toEqual([]);
  });

  it('leaves a fan-out alone when one call answered: the credential works', () => {
    expect(() =>
      rethrowIfCredentialsBlockedAll(
        [
          { status: 'fulfilled', value: [] },
          { status: 'rejected', reason: unauthorized() },
        ],
        'scaleway',
      ),
    ).not.toThrow();
  });
});

describe('the guard itself', () => {
  it('recognises a rejected credential as a credential error, and as rejected', () => {
    const error = new CredentialRejectedError('refused', 'hetzner');

    expect(isCredentialError(error)).toBe(true);
    expect(isCredentialRejected(error)).toBe(true);
  });

  it('does not call an absent credential "rejected" — the remedies differ', () => {
    const error = new CredentialUnavailableError('nothing configured', 'hetzner');

    expect(isCredentialError(error)).toBe(true);
    expect(isCredentialRejected(error)).toBe(false);
  });

  it('reads a bare status as well as an axios response', () => {
    expect(() => rethrowIfCredentialError({ status: 401 }, 'ovh')).toThrow(CredentialRejectedError);
    expect(() => rethrowIfCredentialError({ statusCode: 401 })).toThrow(CredentialRejectedError);
    expect(() => rethrowIfCredentialError(new Error('ECONNRESET'))).not.toThrow();
  });
});

describe('the CLI turns it into the documented exit code', () => {
  it('maps a refused credential to VOPS_CREDENTIALS_INVALID / auth / 7', () => {
    const failure = toFailure(new CredentialRejectedError('refused by the provider', 'hetzner'));

    expect(failure.error.code).toBe('VOPS_CREDENTIALS_INVALID');
    expect(failure.error.category).toBe('auth');
    expect(failure.error.recoverable).toBe(false);
    expect(failure.exitCode).toBe(ExitCode.AUTH);
  });

  it('still maps an absent credential to VOPS_CREDENTIALS_MISSING / auth / 7', () => {
    const failure = toFailure(new CredentialUnavailableError('No credentials configured', 'hetzner'));

    expect(failure.error.code).toBe('VOPS_CREDENTIALS_MISSING');
    expect(failure.exitCode).toBe(ExitCode.AUTH);
  });
});
