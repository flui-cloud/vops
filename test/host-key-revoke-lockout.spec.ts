import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VopsHostKeysService } from '../src/host-ops/vops-host-keys.service';
import { opsTag } from '../src/host-ops/authorized-keys';
import { profileId } from '../src/lib/profile';
import { OPS_KEY_NAME } from '../src/ssh-keys/vops-ssh-keys.service';
import { VopsHost } from '../src/hosts/host.model';

// `revoke-ops` must not accept ANY successful user-key session as proof that access survives
// removing the ops line. On a host whose userKeyName IS the ops key, that check verifies with the
// very key about to be removed and reports safe:true for what would leave zero authorized keys.

const OPS_BLOB = 'AAAAOPSKEYBLOB';
const USER_BLOB = 'AAAAUSERKEYBLOB';

const localKey = (name: string, blob: string, role: 'user' | 'ops') => ({
  name,
  publicKey: `ssh-ed25519 ${blob} ${name}`,
  fingerprint: `SHA256:${name}`,
  privateKeyPath: `/keys/${name}`,
  hasPrivateKey: true,
  imported: false,
  role,
});

const host = (userKeyName?: string): VopsHost => ({
  name: 'vops-val-hz2',
  address: '203.0.113.10',
  user: 'root',
  port: 22,
  opsKeyInstalled: true,
  tags: [],
  addedAt: '2026-07-29T00:00:00Z',
  userKeyName,
});

function svc(opts: { ak: string; userKeyName?: string; keys?: ReturnType<typeof localKey>[] }) {
  const all = opts.keys ?? [localKey(OPS_KEY_NAME, OPS_BLOB, 'ops'), localKey('laptop', USER_BLOB, 'user')];
  const users = all.filter((k) => k.role === 'user');
  const resolveUserKey = (n?: string) =>
    n ? (all.find((k) => k.name === n) ?? null) : (users.length === 1 ? users[0] : null);
  const keys = {
    list: () => all,
    resolveUserKey,
    keyPathFor: (n?: string) => resolveUserKey(n)?.privateKeyPath ?? null,
  };
  const writes: Array<{ path: string; content: string }> = [];
  const ssh = {
    // A session opens iff that key's blob is actually in the host's authorized_keys.
    run: async (t: { keyPath: string }, cmd: string) => {
      const blob = all.find((k) => k.privateKeyPath === t.keyPath)?.publicKey.split(' ')[1] ?? '';
      if (!blob || !opts.ak.includes(blob)) {
        return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
      }
      if (cmd.startsWith('printf')) return { code: 0, stdout: '/root', stderr: '' };
      if (cmd.includes('cat')) return { code: 0, stdout: opts.ak, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    putFile: async (_t: unknown, p: string, content: string) => {
      writes.push({ path: p, content });
    },
  };
  const hosts = { show: () => host(opts.userKeyName), update: () => {} };
  const store = { appendAudit: async () => {} };
  const s = new VopsHostKeysService(
    hosts as never,
    keys as never,
    {} as never,
    ssh as never,
    store as never,
  );
  return { s, writes };
}

describe('revoke-ops never removes the last access path', () => {
  let dir: string;
  let TAG: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-revoke-'));
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'test';
    TAG = opsTag(profileId());
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  const opsLine = () => `no-agent-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 ${OPS_BLOB} ${TAG}`;
  const userLine = `ssh-ed25519 ${USER_BLOB} user@laptop`;

  it('reports safe:false when the verifying user key IS the ops key being removed', async () => {
    const { s, writes } = svc({ ak: `${opsLine()}\n`, userKeyName: OPS_KEY_NAME });
    const dry = await s.revokeOps('vops-val-hz2', { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, wouldRemove: 1, safe: false });

    await expect(s.revokeOps('vops-val-hz2')).rejects.toThrow(/Refusing to revoke/);
    await expect(s.revokeOps('vops-val-hz2')).rejects.toThrow(/ops key itself/);
    expect(writes).toHaveLength(0);
  });

  it('still reports safe:true when a distinct user key remains authorized', async () => {
    const { s, writes } = svc({ ak: `${userLine}\n${opsLine()}\n`, userKeyName: 'laptop' });
    const dry = await s.revokeOps('vops-val-hz2', { dryRun: true });
    expect(dry).toMatchObject({ wouldRemove: 1, safe: true });

    const done = await s.revokeOps('vops-val-hz2');
    expect(done).toMatchObject({ revoked: true, removed: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0].content.trim()).toBe(userLine);
  });

  it('refuses when no user key is set and the ops line is the only key', async () => {
    const { s, writes } = svc({
      ak: `${opsLine()}\n`,
      keys: [localKey(OPS_KEY_NAME, OPS_BLOB, 'ops')],
    });
    const dry = await s.revokeOps('vops-val-hz2', { dryRun: true });
    expect(dry).toMatchObject({ safe: false });
    await expect(s.revokeOps('vops-val-hz2')).rejects.toThrow(/no user key verifies/);
    expect(writes).toHaveLength(0);
  });

  it('--force still overrides the refusal', async () => {
    const { s, writes } = svc({ ak: `${opsLine()}\n`, userKeyName: OPS_KEY_NAME });
    const done = await s.revokeOps('vops-val-hz2', { force: true });
    expect(done).toMatchObject({ revoked: true, removed: 1 });
    expect(writes[0].content).toBe('');
  });
});
