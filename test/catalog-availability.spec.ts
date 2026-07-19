import { VopsCatalogService } from '../src/catalog/vops-catalog.service';
import { CloudClient, RemoteAvailabilityReport } from '../src/lib/cloud-client';

/**
 * Availability is served from the hosted catalog, never from the user's provider
 * credentials — so these tests pin the mapping and, above all, the two states the
 * wire format compresses: "up in every region" (region list omitted) and "we do
 * not publish this provider" (live: false). Rendering either as "sold out" would
 * be the exact inversion of the truth.
 */
function report(over: Partial<RemoteAvailabilityReport> = {}): RemoteAvailabilityReport {
  return {
    provider: 'hetzner',
    live: true,
    limited: [],
    everywhere: [],
    ratio: { limited: 0, total: 0 },
    meta: { updatedAt: Date.now(), ageSeconds: 42, staleAfterSeconds: 600, stale: false },
    ...over,
  };
}

/** An always-empty cache: every test exercises the fetch path unless it says
 * otherwise. `setCache` is recorded so the caching test can assert the TTL. */
function fakeStore() {
  return {
    getCache: jest.fn().mockResolvedValue(null),
    setCache: jest.fn().mockResolvedValue(undefined),
  };
}

function serviceReturning(
  r: RemoteAvailabilityReport,
  store = fakeStore(),
): VopsCatalogService {
  jest.spyOn(CloudClient.prototype, 'availabilityReport').mockResolvedValue(r);
  // Only `availability` is exercised; it touches no provider SDK.
  return new VopsCatalogService(null as never, null as never, store as never);
}

afterEach(() => jest.restoreAllMocks());

describe('VopsCatalogService.availability', () => {
  it('maps limited plans to per-location rows', async () => {
    const svc = serviceReturning(
      report({
        limited: [
          { plan: 'cx43', status: 'limited', vcpu: 8, ram: 16, regions: [
            { code: 'fsn1', up: false },
            { code: 'nbg1', up: true },
          ] },
        ],
      }),
    );

    const { plans } = await svc.availability('hetzner');

    expect(plans).toEqual([
      { id: 'cx43', name: 'cx43', locations: [
        { location: 'fsn1', available: false },
        { location: 'nbg1', available: true },
      ] },
    ]);
  });

  it('flags "up everywhere" plans instead of emitting an empty location list', async () => {
    const svc = serviceReturning(report({ everywhere: ['cpx11', 'cpx21'] }));

    const { plans } = await svc.availability('hetzner');

    // The flag is the whole point: locations is empty for these, and a consumer
    // that reads emptiness as "nowhere available" would invert the meaning.
    expect(plans).toEqual([
      { id: 'cpx11', name: 'cpx11', locations: [], everywhere: true },
      { id: 'cpx21', name: 'cpx21', locations: [], everywhere: true },
    ]);
  });

  it('reports live=false so callers can say "not published" rather than "none"', async () => {
    const svc = serviceReturning(report({ live: false }));

    const result = await svc.availability('contabo');

    expect(result.live).toBe(false);
    expect(result.plans).toEqual([]);
  });

  it('carries staleness through so the reading can be labelled', async () => {
    const svc = serviceReturning(
      report({ meta: { updatedAt: 1, ageSeconds: 900, staleAfterSeconds: 600, stale: true } }),
    );

    const result = await svc.availability('hetzner');

    expect(result).toMatchObject({ ageSeconds: 900, stale: true });
  });

  it('does not crash when the catalog omits meta entirely', async () => {
    const r = report();
    delete (r as Partial<RemoteAvailabilityReport>).meta;
    const svc = serviceReturning(r);

    const result = await svc.availability('hetzner');

    expect(result).toMatchObject({ ageSeconds: null, stale: false });
  });

  it('applies the family filter to both limited and everywhere plans', async () => {
    const svc = serviceReturning(
      report({
        limited: [
          { plan: 'cx43', status: 'limited', vcpu: 8, ram: 16, regions: [{ code: 'fsn1', up: false }] },
          { plan: 'ccx13', status: 'limited', vcpu: 2, ram: 8, regions: [{ code: 'fsn1', up: false }] },
        ],
        everywhere: ['cpx11', 'ccx23'],
      }),
    );

    const { plans } = await svc.availability('hetzner', 'cx');

    // 'ccx13'/'ccx23' must not match the 'cx' family — prefix, not substring.
    expect(plans.map((p) => p.name)).toEqual(['cx43']);
  });

  it('resolves a display name to the provider id the catalog expects', async () => {
    const spy = jest
      .spyOn(CloudClient.prototype, 'availabilityReport')
      .mockResolvedValue(report());
    const svc = new VopsCatalogService(null as never, null as never, fakeStore() as never);

    await svc.availability('Hetzner Cloud');

    expect(spy).toHaveBeenCalledWith('hetzner');
  });
});

/**
 * The dashboard fans one request per provider out on every render, so an uncached
 * read here meant a round trip to the hosted API per provider per page load.
 */
describe('availability caching', () => {
  it('serves a cached report without calling the API', async () => {
    const store = fakeStore();
    store.getCache.mockResolvedValue({
      report: report({ everywhere: ['cpx11'] }),
      fetchedAt: Date.now(),
    });
    const spy = jest.spyOn(CloudClient.prototype, 'availabilityReport');
    const svc = new VopsCatalogService(null as never, null as never, store as never);

    const { plans } = await svc.availability('hetzner');

    expect(spy).not.toHaveBeenCalled();
    expect(plans.map((p) => p.name)).toEqual(['cpx11']);
  });

  it('caches a fresh report under a per-provider key with a short TTL', async () => {
    const store = fakeStore();
    const svc = serviceReturning(report(), store);

    await svc.availability('hetzner');

    expect(store.setCache).toHaveBeenCalledWith(
      'availability:hetzner',
      expect.objectContaining({ fetchedAt: expect.any(Number) }),
      60,
    );
  });

  it('adds the time held locally to the age, instead of replaying it verbatim', async () => {
    const store = fakeStore();
    store.getCache.mockResolvedValue({
      report: report({ meta: { updatedAt: 1, ageSeconds: 100, staleAfterSeconds: 600, stale: false } }),
      fetchedAt: Date.now() - 45_000,
    });
    const svc = new VopsCatalogService(null as never, null as never, store as never);

    const result = await svc.availability('hetzner');

    // 100s at the server + 45s sitting here. Reporting 100 would claim the
    // reading is fresher than it is.
    expect(result.ageSeconds).toBe(145);
  });

  it('flips a cached reading to stale once the accumulated age crosses the threshold', async () => {
    const store = fakeStore();
    store.getCache.mockResolvedValue({
      report: report({ meta: { updatedAt: 1, ageSeconds: 580, staleAfterSeconds: 600, stale: false } }),
      fetchedAt: Date.now() - 60_000,
    });
    const svc = new VopsCatalogService(null as never, null as never, store as never);

    const result = await svc.availability('hetzner');

    expect(result).toMatchObject({ ageSeconds: 640, stale: true });
  });

  it('--refresh bypasses the cache even when one is present', async () => {
    const store = fakeStore();
    store.getCache.mockResolvedValue({
      report: report({ everywhere: ['stale-plan'] }),
      fetchedAt: Date.now(),
    });
    const svc = serviceReturning(report({ everywhere: ['fresh-plan'] }), store);

    const { plans } = await svc.availability('hetzner', undefined, true);

    expect(store.getCache).not.toHaveBeenCalled();
    expect(plans.map((p) => p.name)).toEqual(['fresh-plan']);
  });
});
