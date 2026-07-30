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
      findInstalls: async (n: string) => [{ name: n, host: 'gone' }],
      deleteInstall: async (h: string, n: string) => { deleted.push(`${n}@${h}`); },
      appendAudit: async (t: string) => { audits.push(t); },
    };
    const hosts = { get: () => undefined };

    const res = await svc(hosts, store).remove('memos', { purge: true });
    expect(res).toEqual({ removed: true, purge: false, host: 'gone', orphaned: true });
    expect(deleted).toEqual(['memos@gone']);
    expect(audits).toEqual(['app.forget']);
  });

  it('remove() dry-run on an orphan reports it without deleting', async () => {
    const deleted: string[] = [];
    const store = {
      findInstalls: async (n: string) => [{ name: n, host: 'gone' }],
      deleteInstall: async (h: string, n: string) => { deleted.push(`${n}@${h}`); },
      appendAudit: async () => {},
    };
    const hosts = { get: () => undefined };

    const res = await svc(hosts, store).remove('memos', { dryRun: true });
    expect(res).toEqual({ removed: false, purge: false, host: 'gone', orphaned: true });
    expect(deleted).toEqual([]);
  });
});

// `app expose <name>` is what every "left on plain HTTP" note tells the user to rerun. Until it
// reused the hostname the install already records, that instruction was not runnable as written.
describe('apps — expose reuses the hostname the install already carries', () => {
  function exposeSvc(install: Record<string, unknown>) {
    const s = svc({ get: () => ({ name: install.host }) }, { findInstalls: async () => [install] });
    const seen: Array<Record<string, any>> = [];
    (s as unknown as { deploy: unknown }).deploy = async (_src: unknown, _host: string, opts: Record<string, any>) => {
      seen.push(opts);
      return {};
    };
    return { s, seen };
  }
  const exposed = { name: 'tools', appId: 'it-tools', host: 'web1', ingress: { hostname: 'tools.example.com' } };

  it('falls back to the recorded hostname when --domain is omitted', async () => {
    const { s, seen } = exposeSvc(exposed);
    await s.expose('tools', {});
    expect(seen[0].ingress.domain).toBe('tools.example.com');
  });

  it('lets an explicit --domain move the app to a new hostname', async () => {
    const { s, seen } = exposeSvc(exposed);
    await s.expose('tools', { domain: 'new.example.com' });
    expect(seen[0].ingress.domain).toBe('new.example.com');
  });

  it('still refuses an app that has never been exposed and names the flag', async () => {
    const { s } = exposeSvc({ name: 'tools', appId: 'it-tools', host: 'web1' });
    await expect(s.expose('tools', {})).rejects.toThrow('--domain');
  });
});
