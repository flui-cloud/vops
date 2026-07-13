import {
  parsePortRange,
  toNeutronSpecs,
  toFluiRule,
} from '@flui-cloud/infra';
import { NeutronSecurityGroupRule } from '@flui-cloud/infra';

describe('OVH firewall rule mapping (Flui ↔ Neutron)', () => {
  describe('parsePortRange', () => {
    it('single port → min=max', () => {
      expect(parsePortRange('22')).toEqual({ min: 22, max: 22 });
    });
    it('range → min/max', () => {
      expect(parsePortRange('80-443')).toEqual({ min: 80, max: 443 });
    });
    it('empty/undefined → all ports (null/null)', () => {
      expect(parsePortRange(undefined)).toEqual({ min: null, max: null });
      expect(parsePortRange('')).toEqual({ min: null, max: null });
    });
    it('garbage → null/null (never NaN)', () => {
      expect(parsePortRange('abc')).toEqual({ min: null, max: null });
    });
  });

  describe('toNeutronSpecs', () => {
    it('inbound tcp/22 expands one spec per source CIDR', () => {
      const specs = toNeutronSpecs({
        description: 'ssh',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['0.0.0.0/0', '10.0.0.0/8'],
      });
      expect(specs).toHaveLength(2);
      expect(specs[0]).toMatchObject({
        direction: 'ingress',
        ethertype: 'IPv4',
        protocol: 'tcp',
        portRangeMin: 22,
        portRangeMax: 22,
        remoteIpPrefix: '0.0.0.0/0',
      });
      expect(specs[1].remoteIpPrefix).toBe('10.0.0.0/8');
    });

    it('outbound uses destinationIps and egress', () => {
      const [spec] = toNeutronSpecs({
        description: 'https out',
        direction: 'out',
        protocol: 'tcp',
        port: '443',
        destinationIps: ['0.0.0.0/0'],
      });
      expect(spec.direction).toBe('egress');
      expect(spec.remoteIpPrefix).toBe('0.0.0.0/0');
    });

    it('IPv6 CIDR sets ethertype IPv6', () => {
      const [spec] = toNeutronSpecs({
        description: 'v6',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['::/0'],
      });
      expect(spec.ethertype).toBe('IPv6');
    });

    it('icmp drops port range', () => {
      const [spec] = toNeutronSpecs({
        description: 'ping',
        direction: 'in',
        protocol: 'icmp',
        sourceIps: ['0.0.0.0/0'],
      });
      expect(spec.portRangeMin).toBeNull();
      expect(spec.portRangeMax).toBeNull();
    });

    it('no CIDRs defaults to 0.0.0.0/0', () => {
      const [spec] = toNeutronSpecs({
        description: 'any',
        direction: 'in',
        protocol: 'tcp',
        port: '80',
      });
      expect(spec.remoteIpPrefix).toBe('0.0.0.0/0');
    });
  });

  describe('toFluiRule', () => {
    const base: NeutronSecurityGroupRule = {
      id: 'r1',
      direction: 'ingress',
      ethertype: 'IPv4',
      protocol: 'tcp',
      port_range_min: 80,
      port_range_max: 80,
      remote_ip_prefix: '1.2.3.0/24',
      security_group_id: 'sg1',
      description: 'web',
    };

    it('maps a tcp ingress rule back to Flui shape', () => {
      expect(toFluiRule(base)).toEqual({
        id: 'r1',
        description: 'web',
        direction: 'in',
        protocol: 'tcp',
        port: '80',
        sourceIps: ['1.2.3.0/24'],
      });
    });

    it('port range formats as min-max', () => {
      expect(toFluiRule({ ...base, port_range_min: 80, port_range_max: 443 })?.port).toBe('80-443');
    });

    it('null protocol (Neutron "any") is skipped', () => {
      expect(toFluiRule({ ...base, protocol: null })).toBeNull();
    });

    it('egress maps to out + destinationIps', () => {
      const r = toFluiRule({ ...base, direction: 'egress', remote_ip_prefix: null, ethertype: 'IPv6' });
      expect(r?.direction).toBe('out');
      expect(r?.destinationIps).toEqual(['::/0']);
    });
  });
});
