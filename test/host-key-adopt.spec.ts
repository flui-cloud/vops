import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VopsHostsService } from '../src/hosts/vops-hosts.service';

// Deferring to resolveKey leaves `host import` unusable whenever more than one local key exists:
// it refuses to choose among several, so nothing gets probed with and the record lands `no-key`.
// Trying the keys settles it by evidence — the one that authenticates IS this host's key — which
// is what makes an imported server reachable without the dashboard.

const DENIED = { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
const DOWN = { code: 255, stdout: '', stderr: 'ssh: connect to host 203.0.113.5 port 22: Operation timed out' };
const OK = { code: 0, stdout: 'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04"\n', stderr: '' };

function keys(names: string[]) {
  const all = names.map((name) => ({
    name, publicKey: `ssh-ed25519 AAAA-${name}`, fingerprint: `SHA256:${name}`,
    privateKeyPath: `/keys/${name}`, hasPrivateKey: true, imported: false, role: 'user' as const,
  }));
  return {
    list: () => all,
    usableUserKeys: () => all,
    // The real service refuses to pick when several are usable — that refusal is the bug's trigger.
    resolveUserKey: (n?: string) => (n ? all.find((k) => k.name === n) ?? null : all.length === 1 ? all[0] : null),
  };
}

function svc(keyNames: string[], answer: (keyPath: string) => typeof OK) {
  const tried: string[] = [];
  const ssh = {
    run: async (t: { keyPath: string }) => {
      tried.push(t.keyPath);
      return answer(t.keyPath);
    },
  };
  const providers = {
    getProvider: () => ({
      getServerDetailsAsDto: async () => ({ id: 'srv-1', name: 'vops-val-hz', public_ip: '203.0.113.5' }),
    }),
  };
  const store = { appendAudit: async () => {} };
  return { s: new VopsHostsService(providers as never, keys(keyNames) as never, ssh as never, store as never), tried };
}

describe('host import — adopts the local key that actually opens the host', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-hosts-'));
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'test';
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  it('tries the candidates and records the one that authenticates', async () => {
    const { s, tried } = svc(['work', 'laptop'], (p) => (p === '/keys/laptop' ? OK : DENIED));
    const { host, probe } = await s.import('hetzner', 'vops-val-hz');
    expect(probe.reachable).toBe(true);
    expect(host.userKeyName).toBe('laptop');
    expect(tried).toEqual(['/keys/work', '/keys/laptop']);
    // Persisted, so every later command resolves the same key without probing again.
    expect(s.show('vops-val-hz').userKeyName).toBe('laptop');
  });

  it('stops at the first attempt when the host is down — every key would fail the same way', async () => {
    const { s, tried } = svc(['work', 'laptop'], () => DOWN);
    const { host } = await s.import('hetzner', 'vops-val-hz');
    expect(tried).toHaveLength(1);
    expect(host.userKeyName).toBeUndefined();
    expect(host.conn?.state).toBe('unreachable');
  });

  it('names the repair command when no key opens the host', async () => {
    const { s } = svc(['work', 'laptop'], () => DENIED);
    const { host, probe } = await s.import('hetzner', 'vops-val-hz');
    expect(probe.message).toContain('vops host key set');
    expect(host.conn?.state).toBe('no-key');
  });

  it('leaves an explicitly pinned key alone instead of silently adopting another', async () => {
    const { s, tried } = svc(['work', 'laptop'], (p) => (p === '/keys/laptop' ? OK : DENIED));
    const { host } = await s.add('web1', { address: '203.0.113.5', userKeyName: 'work' });
    expect(tried).toEqual(['/keys/work']);
    expect(host.userKeyName).toBe('work');
  });
});

describe('setUserKey — refuses a key that does not exist locally', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-hosts-'));
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'test';
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  it('assigns a known key and clears it again', async () => {
    const { s } = svc(['laptop'], () => OK);
    await s.add('web1', { address: '203.0.113.5' });
    expect(s.setUserKey('web1', 'laptop').userKeyName).toBe('laptop');
    expect(s.setUserKey('web1', undefined).userKeyName).toBeUndefined();
  });

  it('refuses an unknown key name rather than pinning an unreachable host', async () => {
    const { s } = svc(['laptop'], () => OK);
    await s.add('web1', { address: '203.0.113.5' });
    expect(() => s.setUserKey('web1', 'nope')).toThrow(/no local ssh key named/i);
  });
});
