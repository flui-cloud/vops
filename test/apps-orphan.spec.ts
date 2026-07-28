import { VopsAppsService } from '../src/apps/vops-apps.service';

// An install whose deploy host has left the inventory must not wedge every action
// behind a raw "Host not found": list() flags it, and remove() forgets the local
// record instead of trying (and failing) to reach a host that is gone.
function svc(hosts: unknown, store: unknown): VopsAppsService {
  return new VopsAppsService(
    hosts as never, {} as never, {} as never, {} as never, store as never, {} as never,
  );
}

describe('apps — orphaned installs (host gone from inventory)', () => {
  it('list() flags installs whose host no longer exists', async () => {
    const store = {
      listInstalls: async () => [
        { name: 'memos', host: 'gone', appId: 'memos' },
        { name: 'wp', host: 'live', appId: 'wordpress' },
      ],
    };
    const hosts = { get: (n: string) => (n === 'live' ? { name: 'live' } : undefined) };

    const out = await svc(hosts, store).list();
    expect(out.find((i) => i.name === 'memos')?.hostMissing).toBe(true);
    expect(out.find((i) => i.name === 'wp')?.hostMissing).toBeUndefined();
  });

  it('remove() forgets an orphan locally — no SSH, purge forced off', async () => {
    const deleted: string[] = [];
    const audits: string[] = [];
    const store = {
      getInstall: async (n: string) => ({ name: n, host: 'gone' }),
      deleteInstall: async (n: string) => { deleted.push(n); },
      appendAudit: async (t: string) => { audits.push(t); },
    };
    const hosts = { get: () => undefined };

    const res = await svc(hosts, store).remove('memos', { purge: true });
    expect(res).toEqual({ removed: true, purge: false, host: 'gone', orphaned: true });
    expect(deleted).toEqual(['memos']);
    expect(audits).toEqual(['app.forget']);
  });

  it('remove() dry-run on an orphan reports it without deleting', async () => {
    const deleted: string[] = [];
    const store = {
      getInstall: async (n: string) => ({ name: n, host: 'gone' }),
      deleteInstall: async (n: string) => { deleted.push(n); },
      appendAudit: async () => {},
    };
    const hosts = { get: () => undefined };

    const res = await svc(hosts, store).remove('memos', { dryRun: true });
    expect(res).toEqual({ removed: false, purge: false, host: 'gone', orphaned: true });
    expect(deleted).toEqual([]);
  });
});
