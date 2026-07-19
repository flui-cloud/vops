import {
  buildPendingUpdatesScript,
  parsePendingUpdates,
} from '../src/host-ops/pkg-updates';

// A realistic `apt-get -s upgrade` capture: 2 security Inst lines, 2 regular,
// one with no [current], one garbage line, and one whose "Inst" is corrupted by
// an injected control char (so it isn't a real Inst line) → both dropped. curl's
// candidate carries an ANSI escape to exercise sanitization. @@count matches the
// 5 genuine packages, so nothing is truncated.
const DEBIAN = `@@list
Inst libc6 [2.31-13] (2.31-13+deb11u5 Debian-Security:11/stable [amd64])
Inst openssl [1.1.1n-0+deb11u3] (1.1.1w-0+deb11u1 Debian-Security:11 [amd64])
Inst vim [2:8.2.2434-3] (2:8.2.2434-3+deb11u1 Debian:11/stable [amd64])
Inst curl [7.74.0-1.3] (7.74.0-1.3\u001b[31m+deb11u11 Debian:11 [amd64])
Inst newpkg (1.0.0 Debian:11 [amd64])
Reading package lists... Done
In\u001bst evilpkg [1.0] (2.0 Debian:11 [amd64])
@@count 5
`;

const RHEL = `@@list
kernel.x86_64        4.18.0-513.el8    baseos
openssl.x86_64       1.1.1k-9.el8_7    baseos
bash.x86_64          4.4.20-4.el8_6    baseos
sudo.x86_64          1.8.29-8.el8      appstream
@@security
RHSA-2024:1234 Important/Sec. kernel.x86_64
RHSA-2024:5678 Moderate/Sec.  openssl.x86_64
@@count 4
`;

describe('pkg-updates', () => {
  describe('buildPendingUpdatesScript', () => {
    it('emits a bounded, OS-aware, marker-delimited script', () => {
      const debian = buildPendingUpdatesScript('debian');
      expect(debian).toContain('apt-get -s upgrade');
      expect(debian).toContain("grep '^Inst '");
      expect(debian).toContain('head -n 300');
      expect(debian).toContain('@@count');

      const rhel = buildPendingUpdatesScript('rhel');
      expect(rhel).toContain('dnf -q check-update');
      expect(rhel).toContain('updateinfo list security');
      expect(rhel).toContain('@@security');
      expect(rhel).toContain('head -n 300');

      // Undetected OS (unknown/alpine): runtime `command -v` fallback picks the
      // manager, so the detail matches the battery instead of always reporting 0.
      for (const family of ['unknown', 'alpine'] as const) {
        const auto = buildPendingUpdatesScript(family);
        expect(auto).toContain('command -v apt-get');
        expect(auto).toContain('command -v dnf');
        expect(auto).toContain('apt-get -s upgrade');
        expect(auto).toContain('dnf -q check-update');
        expect(auto).toContain('else echo "@@count 0"; fi');
      }
    });
  });

  describe('debian', () => {
    const out = parsePendingUpdates('debian', DEBIAN);
    const byName = Object.fromEntries(out.packages.map((p) => [p.name, p]));

    it('parses name / current / candidate / security and drops bad rows', () => {
      expect(out.packages).toHaveLength(5);
      expect(byName.libc6).toEqual({
        name: 'libc6',
        current: '2.31-13',
        candidate: '2.31-13+deb11u5',
        security: true,
      });
      expect(byName.openssl.security).toBe(true);
      expect(byName.vim.security).toBe(false);
      // no [current] → null, candidate still read from the parens
      expect(byName.newpkg).toEqual({ name: 'newpkg', current: null, candidate: '1.0.0', security: false });
      // garbage + control-char-corrupted "Inst" lines are gone
      expect(byName.evilpkg).toBeUndefined();
      expect(out.packages.some((p) => /Reading|Done/.test(p.name))).toBe(false);
    });

    it('sanitizes untrusted text (ANSI stripped from the candidate)', () => {
      expect(byName.curl.candidate).toBe('7.74.0-1.3+deb11u11');
      expect(byName.curl.candidate).not.toContain('\u001b');
      expect(byName.curl.candidate).not.toContain('[31m');
    });

    it('orders security first, then by name, and is not truncated when count matches', () => {
      expect(out.packages.map((p) => p.name)).toEqual(['libc6', 'openssl', 'curl', 'newpkg', 'vim']);
      expect(out.packages[0].security).toBe(true);
      expect(out.packages[1].security).toBe(true);
      expect(out.total).toBe(5);
      expect(out.truncated).toBe(false);
    });

    it('flags truncation when the total exceeds the listed rows', () => {
      const trunc = parsePendingUpdates('debian', DEBIAN.replace('@@count 5', '@@count 42'));
      expect(trunc.total).toBe(42);
      expect(trunc.packages).toHaveLength(5);
      expect(trunc.truncated).toBe(true);
    });
  });

  describe('rhel', () => {
    const out = parsePendingUpdates('rhel', RHEL);
    const byName = Object.fromEntries(out.packages.map((p) => [p.name, p]));

    it('flags security by advisory-set membership, current null, candidate = version-release', () => {
      expect(out.packages).toHaveLength(4);
      expect(byName.kernel).toEqual({ name: 'kernel', current: null, candidate: '4.18.0-513.el8', security: true });
      expect(byName.openssl.security).toBe(true);
      expect(byName.bash).toEqual({ name: 'bash', current: null, candidate: '4.4.20-4.el8_6', security: false });
      expect(byName.sudo.security).toBe(false);
    });

    it('orders security first and is not truncated', () => {
      expect(out.packages[0].security).toBe(true);
      expect(out.packages[1].security).toBe(true);
      expect(out.total).toBe(4);
      expect(out.truncated).toBe(false);
    });
  });

  describe('unknown / unsupported family', () => {
    it('returns no packages and a zero total', () => {
      const out = parsePendingUpdates('unknown', 'echo skipped\n@@count 0\n');
      expect(out.packages).toEqual([]);
      expect(out.total).toBe(0);
      expect(out.truncated).toBe(false);
    });

    // The auto-detecting script runs the debian probe on an unknown-family host;
    // the parser must route debian-shaped output by content, not return [].
    it('parses debian-shaped output when the family is unknown', () => {
      const stdout =
        '@@list\n' +
        'Inst python3-httplib2 [0.20.4-3] (0.20.4-3ubuntu0.1 Ubuntu:24.04/noble-security [all])\n' +
        '@@count 1\n';
      const out = parsePendingUpdates('unknown', stdout);
      expect(out.packages).toEqual([
        { name: 'python3-httplib2', current: '0.20.4-3', candidate: '0.20.4-3ubuntu0.1', security: true },
      ]);
      expect(out.total).toBe(1);
      expect(out.truncated).toBe(false);
    });
  });
});
