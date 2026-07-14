import { VopsHostFirewallService } from '../src/host-ops/vops-host-firewall.service';
import { VopsHost, VopsHostFirewall } from '../src/hosts/host.model';
import { VopsFirewallRule } from '../src/dto/firewall.dto';

const host = (over: Partial<VopsHost> = {}): VopsHost => ({
  name: 'h1',
  address: '203.0.113.10',
  user: 'root',
  port: 22,
  opsKeyInstalled: false,
  userKeyName: 'k1',
  conn: { state: 'ready' } as VopsHost['conn'],
  tags: [],
  addedAt: '2026-07-12T00:00:00Z',
  ...over,
});

function harness(h: VopsHost) {
  const scripts: string[] = [];
  let saved: VopsHost | null = null;
  const ssh = {
    run: jest.fn(async (_t: unknown, cmd: string) => {
      if (cmd.includes('command -v nft')) return { code: 0, stdout: '/usr/sbin/nft', stderr: '' };
      if (cmd.includes('nft list table')) return { code: 0, stdout: 'VOPS_ACTIVE\nVOPS_PERSIST', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }),
    runScript: jest.fn(async (_t: unknown, body: string) => {
      scripts.push(body);
      return { code: 0, stdout: 'VOPS_PERSIST_SYSTEMD', stderr: '' };
    }),
    putFile: jest.fn(),
    putBinary: jest.fn(),
  };
  const hosts = { show: () => h, update: (x: VopsHost) => { saved = x; } };
  const keys = { list: () => [], keyPathFor: () => '/tmp/key' };
  const conn = { assertReady: jest.fn(async () => undefined) };
  const store = { appendAudit: jest.fn(async () => undefined) };
  const svc = new VopsHostFirewallService(
    hosts as never, keys as never, conn as never, ssh as never, store as never,
  );
  return { svc, ssh, scripts, script: () => scripts[scripts.length - 1] ?? '', getSaved: () => saved };
}

describe('VopsHostFirewallService (managed nftables engine)', () => {
  it('applies rules, keeps SSH open, persists intent, and reports state', async () => {
    const t = harness(host());
    const rules: VopsFirewallRule[] = [{ description: 'web', direction: 'in', protocol: 'tcp', port: '80,443' }];
    const status = await t.svc.apply('h1', rules);
    expect(t.script()).toContain('tcp dport { 80, 443 } accept');
    expect(t.script()).toContain('keep-ssh-open (not closable)');
    expect(t.getSaved()?.firewall?.rules).toEqual(rules);
    expect(t.getSaved()?.firewall?.policy).toBe('drop');
    expect(status.active).toBe(true);
    expect(status.persistent).toBe(true);
    expect(status.sshPort).toBe(22);
  });

  it('owns only its table and never flushes the whole ruleset', async () => {
    const t = harness(host());
    await t.svc.apply('h1', []);
    expect(t.script()).not.toContain('flush ruleset');
    expect(t.script()).toContain('delete table inet vops_fw');
    expect(t.script()).toContain('/etc/vops/firewall.nft');
    expect(t.script()).not.toContain('/etc/nftables.conf');
  });

  it('keeps SSH open and strips a source-restricted SSH rule (lock-out proof, honest intent)', async () => {
    const t = harness(host());
    await t.svc.apply('h1', [
      { description: 'ssh-lockdown', direction: 'in', protocol: 'tcp', port: '22', sourceIps: ['203.0.113.4/32'] },
    ]);
    expect(t.script()).toContain('tcp dport 22 accept comment "vops: keep-ssh-open (not closable)"');
    expect(t.script()).not.toContain('ip saddr 203.0.113.4/32'); // the restriction is not rendered
    expect(t.getSaved()?.firewall?.rules).toEqual([]); // nor persisted as intent
  });

  it('honours a custom SSH port and uses sudo for a non-root user', async () => {
    const t = harness(host({ port: 2222, user: 'ubuntu' }));
    await t.svc.apply('h1', []);
    expect(t.script()).toContain('tcp dport 2222 accept comment "vops: keep-ssh-open (not closable)"');
    expect(t.script()).toContain('sudo -n ');
  });

  it('surfaces an nft failure instead of swallowing it', async () => {
    const t = harness(host());
    t.ssh.runScript.mockImplementation(async () => ({ code: 1, stdout: '', stderr: 'syntax error' }));
    await expect(t.svc.apply('h1', [])).rejects.toThrow(/apply failed.*syntax error/);
  });

  it('rejects a malformed port before touching the host (fail closed)', async () => {
    const t = harness(host());
    await expect(t.svc.apply('h1', [{ description: 'x', direction: 'in', protocol: 'tcp', port: '80-90-100' }]))
      .rejects.toThrow(/Invalid port/);
    expect(t.scripts).toHaveLength(0);
  });

  it('refuses to clear a host vops never applied to (no blast radius)', async () => {
    const t = harness(host()); // no .firewall
    await expect(t.svc.clear('h1')).rejects.toThrow(/never applied/);
    expect(t.scripts).toHaveLength(0);
  });

  it('clears a vops-managed host, scoped to its own table, once the table is gone', async () => {
    const fw: VopsHostFirewall = { rules: [], policy: 'drop', appliedAt: '2026-07-12T00:00:00Z' };
    const t = harness(host({ firewall: fw }));
    t.ssh.run.mockImplementation(async (_t: unknown, cmd: string) =>
      cmd.includes('nft list table') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' });
    await t.svc.clear('h1');
    expect(t.script()).toContain('nft delete table inet vops_fw');
    expect(t.script()).toContain('set -e');
    expect(t.script()).not.toContain('flush ruleset');
    expect(t.getSaved()?.firewall).toBeUndefined();
  });

  it('keeps the intent when the clear script fails (no desync)', async () => {
    const fw: VopsHostFirewall = { rules: [], policy: 'drop', appliedAt: '2026-07-12T00:00:00Z' };
    const t = harness(host({ firewall: fw }));
    t.ssh.runScript.mockImplementation(async () => ({ code: 1, stdout: '', stderr: 'sudo: a password is required' }));
    await expect(t.svc.clear('h1')).rejects.toThrow(/clear failed/);
    expect(t.getSaved()).toBeNull(); // intent NOT dropped
  });

  it('keeps the intent when the table is still active after clear', async () => {
    const fw: VopsHostFirewall = { rules: [], policy: 'drop', appliedAt: '2026-07-12T00:00:00Z' };
    const t = harness(host({ firewall: fw })); // default run mock keeps reporting VOPS_ACTIVE
    await expect(t.svc.clear('h1')).rejects.toThrow(/did not remove/);
    expect(t.getSaved()).toBeNull();
  });
});
