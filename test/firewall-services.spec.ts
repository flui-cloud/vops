import {
  FirewallService,
  firstServiceError,
  parseClientIp,
  parseServiceSpec,
  resolveFirewallEngine,
  rulesAllowPort,
  rulesToServices,
  servicesToRules,
} from '../src/firewall/firewall-services';
import { VopsFirewallRule } from '../src/dto/firewall.dto';

const svc = (over: Partial<FirewallService>): FirewallService => ({
  id: 'x', label: 'X', protocol: 'tcp', port: '0', enabled: true, sources: [], ...over,
});

describe('firewall service compiler', () => {
  it('compiles enabled services to inbound rules; anywhere → no sourceIps', () => {
    const rules = servicesToRules([
      svc({ id: 'https', label: 'Web (HTTPS)', port: '443' }),
      svc({ id: 'ssh', label: 'SSH', port: '22', sources: ['203.0.113.4/32'] }),
      svc({ id: 'http', label: 'Web (HTTP)', port: '80', enabled: false }),
    ]);
    expect(rules).toEqual([
      { description: 'Web (HTTPS)', direction: 'in', protocol: 'tcp', port: '443' },
      { description: 'SSH', direction: 'in', protocol: 'tcp', port: '22', sourceIps: ['203.0.113.4/32'] },
    ]);
  });

  it('decompiles rules, naming well-known ports and labelling the rest', () => {
    const rules: VopsFirewallRule[] = [
      { description: 'x', direction: 'in', protocol: 'tcp', port: '443' },
      { description: 'x', direction: 'in', protocol: 'tcp', port: '8080', sourceIps: ['10.0.0.0/8'] },
      { description: 'out', direction: 'out', protocol: 'tcp', port: '25' },
    ];
    const services = rulesToServices(rules);
    expect(services).toEqual([
      { id: 'https', label: 'Web (HTTPS)', protocol: 'tcp', port: '443', enabled: true, sources: [] },
      { id: 'port-tcp-8080', label: 'Port 8080', protocol: 'tcp', port: '8080', enabled: true, sources: ['10.0.0.0/8'] },
    ]);
  });

  it('round-trips services → rules → services', () => {
    const services = [svc({ id: 'ssh', label: 'SSH', port: '22' }), svc({ id: 'https', label: 'Web (HTTPS)', port: '443' })];
    expect(rulesToServices(servicesToRules(services))).toEqual(services);
  });
});

describe('provider-engine helpers', () => {
  const tcp = (port: string): VopsFirewallRule[] => [{ description: 'x', direction: 'in', protocol: 'tcp', port }];
  it('rulesAllowPort matches exact, list member, and range', () => {
    expect(rulesAllowPort(tcp('22'), 22)).toBe(true);
    expect(rulesAllowPort(tcp('80,22,443'), 22)).toBe(true);
    expect(rulesAllowPort(tcp('20-30'), 22)).toBe(true);
    expect(rulesAllowPort(tcp('80,443'), 22)).toBe(false);
    expect(rulesAllowPort([{ description: 'x', direction: 'in', protocol: 'udp', port: '22' }], 22)).toBe(false);
  });
  it('rulesToServices dedupes duplicate proto:port (first wins, unique ids)', () => {
    const services = rulesToServices([
      { description: 'a', direction: 'in', protocol: 'tcp', port: '443', sourceIps: ['1.1.1.1/32'] },
      { description: 'b', direction: 'in', protocol: 'tcp', port: '443', sourceIps: ['2.2.2.2/32'] },
    ]);
    expect(services).toHaveLength(1);
    expect(services[0].sources).toEqual(['1.1.1.1/32']);
  });
});

describe('firstServiceError (validation, fail-closed)', () => {
  it('accepts a legal service', () => {
    expect(firstServiceError([svc({ port: '443', sources: ['203.0.113.4/32'] })])).toBeNull();
    expect(firstServiceError([svc({ port: '8000-8100,9000', sources: [] })])).toBeNull();
    expect(firstServiceError([svc({ port: '22', sources: ['2001:db8::/48'] })])).toBeNull();
  });
  it('rejects an empty or out-of-range port (no fail-open to 0-65535)', () => {
    expect(firstServiceError([svc({ port: '' })])).toMatch(/Invalid port/);
    expect(firstServiceError([svc({ port: '99999' })])).toMatch(/Invalid port/);
    expect(firstServiceError([svc({ port: '0' })])).toMatch(/Invalid port/);
  });
  it('rejects a junk or newline-bearing source', () => {
    expect(firstServiceError([svc({ port: '80', sources: ['999.1.1.1/32'] })])).toMatch(/Invalid source/);
    expect(firstServiceError([svc({ port: '80', sources: ['1.2.3.4/33'] })])).toMatch(/Invalid source/);
    expect(firstServiceError([svc({ port: '80', sources: ['1.2.3.4/32\naccept'] })])).toMatch(/Invalid source/);
    expect(firstServiceError([svc({ port: '80', sources: ['nope'] })])).toMatch(/Invalid source/);
  });
  it('ignores disabled services', () => {
    expect(firstServiceError([svc({ port: '', enabled: false })])).toBeNull();
  });
});

describe('parseClientIp ($SSH_CONNECTION)', () => {
  it('takes the client IP (first field)', () => {
    expect(parseClientIp('203.0.113.7 51886 10.0.0.1 22')).toBe('203.0.113.7');
    expect(parseClientIp('2001:db8::1 40001 2001:db8::2 22\n')).toBe('2001:db8::1');
  });
  it('returns null on empty or junk', () => {
    expect(parseClientIp('')).toBeNull();
    expect(parseClientIp('   ')).toBeNull();
    expect(parseClientIp('garbage here')).toBeNull();
  });
});

describe('parseServiceSpec (CLI tokens)', () => {
  it('resolves a well-known name', () => {
    expect(parseServiceSpec('https')).toEqual({ id: 'https', label: 'Web (HTTPS)', protocol: 'tcp', port: '443', enabled: true, sources: [] });
  });
  it('parses a raw tcp port', () => {
    expect(parseServiceSpec('8080')).toEqual({ id: 'port-tcp-8080', label: 'Port 8080', protocol: 'tcp', port: '8080', enabled: true, sources: [] });
  });
  it('parses proto and source', () => {
    expect(parseServiceSpec('51820/udp@203.0.113.0/24')).toEqual({
      id: 'port-udp-51820', label: 'Port 51820', protocol: 'udp', port: '51820', enabled: true, sources: ['203.0.113.0/24'],
    });
  });
  it('rejects a non-port token', () => {
    expect(() => parseServiceSpec('nonsense')).toThrow(/Bad service/);
  });
});

describe('firewall engine resolution', () => {
  it('provider-native for Hetzner/Scaleway', () => {
    expect(resolveFirewallEngine({ provider: 'hetzner' })).toBe('provider');
    expect(resolveFirewallEngine({ provider: 'scaleway' })).toBe('provider');
  });
  it('nftables for Contabo / OVH / BYOS (no native firewall)', () => {
    expect(resolveFirewallEngine({ provider: 'contabo' })).toBe('nftables');
    expect(resolveFirewallEngine({ provider: 'ovh' })).toBe('nftables');
    expect(resolveFirewallEngine({})).toBe('nftables');
  });
  it('none when no native firewall AND provider-only (no SSH)', () => {
    expect(resolveFirewallEngine({ provider: 'contabo', sshManaged: false })).toBe('none');
    expect(resolveFirewallEngine({ sshManaged: false })).toBe('none');
  });
  it('still provider-native even when SSH management is off (edge-filtered)', () => {
    expect(resolveFirewallEngine({ provider: 'hetzner', sshManaged: false })).toBe('provider');
  });
});
