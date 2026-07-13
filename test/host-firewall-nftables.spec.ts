import { renderNftables, renderCloudInit } from '../src/host-firewall/nftables';
import { VopsFirewallRule } from '../src/dto/firewall.dto';

const inRule = (over: Partial<VopsFirewallRule>): VopsFirewallRule => ({
  description: 't',
  direction: 'in',
  protocol: 'tcp',
  ...over,
});

describe('host-firewall nftables renderer', () => {
  it('defaults to deny-by-default input with established/loopback/invalid handling', () => {
    const nft = renderNftables([]);
    expect(nft).toContain('table inet vops_fw');
    expect(nft).toContain('policy drop;');
    expect(nft).toContain('ct state established,related accept');
    expect(nft).toContain('ct state invalid drop');
    expect(nft).toContain('iif "lo" accept');
    expect(nft).toContain('chain forward');
    expect(nft).toContain('chain output');
  });

  it('keeps SSH open by default so a drop policy cannot lock you out', () => {
    const nft = renderNftables([]);
    expect(nft).toContain('tcp dport 22 accept comment "vops: keep-ssh-open"');
  });

  it('does NOT inject the broad SSH rule when the user restricts 22 to a source', () => {
    const nft = renderNftables([inRule({ port: '22', sourceIps: ['203.0.113.4/32'] })]);
    expect(nft).not.toContain('keep-ssh-open');
    expect(nft).toContain('ip saddr 203.0.113.4/32 tcp dport 22 accept');
  });

  it('respects an SSH rule hidden inside a port range', () => {
    const nft = renderNftables([inRule({ port: '20-30' })]);
    expect(nft).not.toContain('keep-ssh-open');
  });

  it('omits the SSH guard when keepSshOpen=false', () => {
    const nft = renderNftables([], { keepSshOpen: false });
    expect(nft).not.toContain('keep-ssh-open');
  });

  it('single port from anywhere → no saddr filter', () => {
    const nft = renderNftables([inRule({ port: '443' })]);
    expect(nft).toContain('tcp dport 443 accept');
  });

  it('comma list becomes an nft set', () => {
    const nft = renderNftables([inRule({ port: '80,443' })]);
    expect(nft).toContain('tcp dport { 80, 443 } accept');
  });

  it('range is passed through', () => {
    const nft = renderNftables([inRule({ port: '8000-8100' })]);
    expect(nft).toContain('tcp dport 8000-8100 accept');
  });

  it('splits IPv4 and IPv6 sources into separate lines', () => {
    const nft = renderNftables([inRule({ port: '5432', sourceIps: ['10.0.0.0/8', '2001:db8::/32'] })]);
    expect(nft).toContain('ip saddr 10.0.0.0/8 tcp dport 5432 accept');
    expect(nft).toContain('ip6 saddr 2001:db8::/32 tcp dport 5432 accept');
  });

  it('multiple v4 sources collapse into a single set', () => {
    const nft = renderNftables([inRule({ port: '5432', sourceIps: ['10.0.0.0/8', '192.168.0.0/16'] })]);
    expect(nft).toContain('ip saddr { 10.0.0.0/8, 192.168.0.0/16 } tcp dport 5432 accept');
  });

  it('0.0.0.0/0 in sources is treated as "any" (no saddr filter)', () => {
    const nft = renderNftables([inRule({ port: '443', sourceIps: ['0.0.0.0/0'] })]);
    expect(nft).toContain('tcp dport 443 accept');
    expect(nft).not.toContain('ip saddr 0.0.0.0/0');
  });

  it('udp is supported', () => {
    const nft = renderNftables([inRule({ protocol: 'udp', port: '51820' })]);
    expect(nft).toContain('udp dport 51820 accept');
  });

  it('accept policy skips the anti-lockout SSH guard (nothing to lock out)', () => {
    const nft = renderNftables([], { defaultInboundPolicy: 'accept' });
    expect(nft).toContain('policy accept;');
    expect(nft).not.toContain('keep-ssh-open');
  });

  it('allowOutbound=false locks egress but keeps established + loopback', () => {
    const nft = renderNftables([], { allowOutbound: false });
    expect(nft).toContain('type filter hook output priority 0; policy drop;');
    expect(nft).toContain('oif "lo" accept');
  });

  it('outbound rules do not appear in the input chain', () => {
    const nft = renderNftables([
      { description: 'out', direction: 'out', protocol: 'tcp', port: '25', destinationIps: ['0.0.0.0/0'] },
    ]);
    expect(nft).not.toContain('dport 25');
  });
});

describe('host-firewall cloud-init generator', () => {
  it('produces a valid #cloud-config that installs, writes and applies the ruleset', () => {
    const ci = renderCloudInit([inRule({ port: '80' })]);
    expect(ci.startsWith('#cloud-config')).toBe(true);
    expect(ci).toContain('packages:\n  - nftables');
    expect(ci).toContain('path: /etc/nftables.conf');
    expect(ci).toContain('nft -f /etc/nftables.conf');
    expect(ci).toContain('systemctl enable nftables');
    // ruleset content is indented under content: |
    expect(ci).toContain('      table inet vops_fw');
    expect(ci).toContain('      tcp dport 80 accept');
  });
});
