import { assertHostWritable } from '../src/safety/host-write-gate';
import { parseOsRelease } from '../src/hosts/vops-hosts.service';
import {
  adminUserScript,
  sshdCheck,
  sshdDirectiveScript,
  unattendedUpgradesScript,
} from '../src/host-ops/harden-steps';
import { renderSshRateLimit } from '../src/host-firewall/nftables';
import { VopsHost } from '../src/hosts/host.model';

const host = (over: Partial<VopsHost> = {}): VopsHost => ({
  name: 'h1',
  address: '203.0.113.10',
  user: 'root',
  port: 22,
  opsKeyInstalled: false,
  tags: [],
  addedAt: '2026-07-12T00:00:00Z',
  ...over,
});

describe('assertHostWritable', () => {
  afterEach(() => delete process.env.VOPS_READONLY);

  it('refuses an unknown host', () => {
    expect(() => assertHostWritable(undefined)).toThrow(/Unknown host/);
  });
  it('honours VOPS_READONLY', () => {
    process.env.VOPS_READONLY = '1';
    expect(() => assertHostWritable(host())).toThrow(/read-only/);
  });
  it('allows a known host by default', () => {
    expect(() => assertHostWritable(host())).not.toThrow();
  });
});

describe('parseOsRelease', () => {
  it('maps ubuntu to the debian family', () => {
    const os = parseOsRelease('ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04 LTS"');
    expect(os.family).toBe('debian');
    expect(os.pretty).toBe('Ubuntu 24.04 LTS');
  });
  it('maps rocky/centos to rhel via ID_LIKE', () => {
    expect(parseOsRelease('ID=rocky\nID_LIKE="rhel centos fedora"').family).toBe('rhel');
  });
  it('detects alpine and falls back to unknown', () => {
    expect(parseOsRelease('ID=alpine').family).toBe('alpine');
    expect(parseOsRelease('ID=plan9').family).toBe('unknown');
  });
});

describe('harden-steps renderers', () => {
  it('sshd directive script validates before reload and self-reverts', () => {
    const s = sshdDirectiveScript('PasswordAuthentication', 'no');
    expect(s).toContain('00-vops.conf');
    expect(s).toContain('sshd -t');
    expect(s).toContain('PasswordAuthentication no');
    expect(sshdCheck('passwordauthentication', 'no')).toContain('sshd -T');
  });
  it('admin user script is idempotent and installs the key', () => {
    const s = adminUserScript('admin', 'ssh-ed25519 AAAA user@x', 'debian');
    expect(s).toContain('useradd');
    expect(s).toContain('sudo'); // debian sudo group
    expect(s).toContain('ssh-ed25519 AAAA user@x');
    expect(adminUserScript('admin', 'k', 'rhel')).toContain('wheel');
  });
  it('unattended upgrades differ by family', () => {
    expect(unattendedUpgradesScript('debian')).toContain('unattended-upgrades');
    expect(unattendedUpgradesScript('rhel')).toContain('dnf-automatic');
  });
});

describe('renderSshRateLimit', () => {
  it('renders a standalone anti-bruteforce table (no flush)', () => {
    const r = renderSshRateLimit();
    expect(r).toContain('table inet vops_ssh_ratelimit');
    expect(r).not.toContain('flush ruleset');
    expect(r).toContain('tcp dport 22');
    expect(r).toContain('limit rate over 10/minute');
    expect(renderSshRateLimit({ port: 2222, ratePerMinute: 3 })).toContain('tcp dport 2222');
  });
});
