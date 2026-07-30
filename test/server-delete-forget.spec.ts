import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pruneKnownHosts, pruneKnownHostsFile } from '../src/lib/known-hosts';
import { forgetDestroyedServer, knownHostTargets, staleHostsFor } from '../src/hosts/host-forget';
import { VopsHost } from '../src/hosts/host.model';
import { VopsHostsService } from '../src/hosts/vops-hosts.service';
import { VopsServersService } from '../src/servers/vops-servers.service';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2Nq';

const host = (over: Partial<VopsHost> = {}): VopsHost => ({
  name: 'vops-val-cold',
  address: '203.0.113.10',
  user: 'root',
  port: 22,
  opsKeyInstalled: false,
  provider: 'hetzner',
  providerServerId: '156484351',
  tags: [],
  addedAt: '2026-07-29T00:00:00Z',
  conn: {
    state: 'ready',
    keyKind: 'user',
    reachable: true,
    hasKey: true,
    authorized: true,
    message: 'ok',
    checkedAt: '2026-07-29T00:00:00Z',
  },
  ...over,
});

/** How OpenSSH stores a hashed entry: HMAC-SHA1 of the pattern, keyed by the salt. */
const hashed = (name: string, salt = 'c2FsdHNhbHRzYWx0c2FsdHNhbHQ='): string =>
  `|1|${salt}|${createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64')}`;

// A destroyed host's key left in known_hosts makes a recycled provider IP fail with
// "host key verification failed" until the user runs ssh-keygen -R by hand.
describe('pruneKnownHosts', () => {
  it('drops the entry for the address and leaves every other line byte-identical', () => {
    const before = `# vops\n198.51.100.7 ${KEY}\n203.0.113.10 ${KEY}\n`;
    const { content, removed } = pruneKnownHosts(before, [{ address: '203.0.113.10' }]);
    expect(removed).toBe(1);
    expect(content).toBe(`# vops\n198.51.100.7 ${KEY}\n`);
  });

  it('drops the bracketed [addr]:port form, on the recorded port or on 22', () => {
    const before = `[203.0.113.10]:2222 ${KEY}\n[198.51.100.7]:22 ${KEY}\n`;
    expect(pruneKnownHosts(before, [{ address: '203.0.113.10', port: 2222 }]).removed).toBe(1);
    expect(pruneKnownHosts(before, [{ address: '198.51.100.7', port: 22 }]).removed).toBe(1);
  });

  it('drops hashed entries — Debian/Ubuntu ship HashKnownHosts yes', () => {
    const before = `${hashed('203.0.113.10')} ${KEY}\n${hashed('198.51.100.7')} ${KEY}\n`;
    const { content, removed } = pruneKnownHosts(before, [{ address: '203.0.113.10' }]);
    expect(removed).toBe(1);
    expect(content).toBe(`${hashed('198.51.100.7')} ${KEY}\n`);
  });

  it('removes only the matching name from a line naming several hosts', () => {
    const before = `203.0.113.10,other.example ${KEY}\n`;
    const { content, removed } = pruneKnownHosts(before, [{ address: '203.0.113.10' }]);
    expect(removed).toBe(0);
    expect(content).toBe(`other.example ${KEY}\n`);
  });

  it('keeps markers on a rewritten line and never touches an unrelated file', () => {
    expect(
      pruneKnownHosts(`@cert-authority 203.0.113.10,keep.example ${KEY}\n`, [
        { address: '203.0.113.10' },
      ]).content,
    ).toBe(`@cert-authority keep.example ${KEY}\n`);
    const untouched = `# only comments\n\n198.51.100.7 ${KEY}\n`;
    expect(pruneKnownHosts(untouched, [{ address: '203.0.113.10' }])).toEqual({
      content: untouched,
      removed: 0,
    });
  });

  it('is a no-op with no targets, and on a file that does not exist', () => {
    expect(pruneKnownHosts(`198.51.100.7 ${KEY}\n`, []).removed).toBe(0);
    expect(pruneKnownHostsFile(path.join(os.tmpdir(), 'vops-absent-known-hosts'), [
      { address: '198.51.100.7' },
    ])).toBe(0);
  });
});

// Without consulting the inventory, `servers delete` leaves the destroyed box reporting `ready`.
describe('staleHostsFor', () => {
  it('matches the provider server id', () => {
    expect(staleHostsFor([host()], { provider: 'hetzner', serverId: '156484351' })).toHaveLength(1);
  });

  it('matches the address even when the entry carries no provider link', () => {
    const external = host({ name: 'external', provider: undefined, providerServerId: undefined });
    const found = staleHostsFor([external], {
      provider: 'hetzner',
      serverId: '156484351',
      address: '203.0.113.10',
    });
    expect(found.map((h) => h.name)).toEqual(['external']);
  });

  it('never matches on the name alone — names are not unique across providers', () => {
    const other = host({ provider: 'scaleway', providerServerId: 'abc', address: '203.0.113.9' });
    expect(staleHostsFor([other], { provider: 'hetzner', serverId: '156484351' })).toEqual([]);
  });

  it('collects the destroyed address plus each forgotten host port', () => {
    const stale = [host({ port: 2222 })];
    expect(knownHostTargets(stale, { provider: 'hetzner', serverId: '1', address: '1.2.3.4' })).toEqual([
      { address: '203.0.113.10', port: 2222 },
      { address: '1.2.3.4', port: 22 },
    ]);
  });
});

describe('forgetDestroyedServer', () => {
  it('reports what it could not do instead of failing the (already destroyed) delete', async () => {
    const out = await forgetDestroyedServer(
      {
        hosts: {
          list: () => [host()],
          remove: () => {
            throw new Error('hosts.json is read-only');
          },
        },
        knownHostsFile: '/nonexistent/known_hosts',
        audit: async () => undefined,
      },
      { provider: 'hetzner', serverId: '156484351' },
    );
    expect(out).toEqual({
      forgotten: [],
      knownHostsPruned: 0,
      warning: expect.stringContaining('hosts.json is read-only'),
    });
  });
});

describe('servers delete — the local records go with the server', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-delete-forget-'));
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'test';
    fs.mkdirSync(path.join(dir, 'profiles', 'test'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  const profileFile = (name: string) => path.join(dir, 'profiles', 'test', name);

  const svc = (deleted: string[]) => {
    const server = {
      id: '156484351',
      name: 'vops-val-cold',
      server_type: 'cx23',
      location: 'fsn1',
      status: 'running',
      public_ip: '203.0.113.10',
    };
    const impl = {
      getServerDetailsAsDto: async () => server,
      deleteServer: async (req: { server_id: string }) => {
        deleted.push(req.server_id);
      },
    };
    return new VopsServersService(
      { getProvider: () => impl } as never,
      {} as never,
      {} as never,
      {} as never,
      { appendAudit: async () => undefined } as never,
      {} as never,
      new VopsHostsService(null as never, null as never, null as never, null as never),
    );
  };

  it('forgets the inventory entry and prunes its host key', async () => {
    fs.writeFileSync(profileFile('hosts.json'), JSON.stringify({ hosts: [host()] }));
    fs.writeFileSync(profileFile('known_hosts'), `203.0.113.10 ${KEY}\n198.51.100.7 ${KEY}\n`);
    const deleted: string[] = [];

    const out = await svc(deleted).delete('hetzner', '156484351', true);

    expect(deleted).toEqual(['156484351']);
    expect(out).toEqual({ deleted: '156484351', forgotten: ['vops-val-cold'], knownHostsPruned: 1 });
    expect(JSON.parse(fs.readFileSync(profileFile('hosts.json'), 'utf8')).hosts).toEqual([]);
    expect(fs.readFileSync(profileFile('known_hosts'), 'utf8')).toBe(`198.51.100.7 ${KEY}\n`);
  });

  it('leaves an unrelated host and its key alone', async () => {
    const keep = host({ name: 'keeper', address: '198.51.100.7', providerServerId: '999' });
    fs.writeFileSync(profileFile('hosts.json'), JSON.stringify({ hosts: [keep] }));
    fs.writeFileSync(profileFile('known_hosts'), `198.51.100.7 ${KEY}\n`);

    const out = await svc([]).delete('hetzner', '156484351', true);

    expect(out).toEqual({ deleted: '156484351', forgotten: [], knownHostsPruned: 0 });
    expect(JSON.parse(fs.readFileSync(profileFile('hosts.json'), 'utf8')).hosts).toHaveLength(1);
    expect(fs.readFileSync(profileFile('known_hosts'), 'utf8')).toBe(`198.51.100.7 ${KEY}\n`);
  });
});
