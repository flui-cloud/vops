import { DnsConflictError, DnsRecordLike, planARecord, sameName } from '../src/apps/ingress-dns-plan';

const FQDN = 'app.example.com';
const NAME = 'app';
const IP = '203.0.113.10';

const rec = (type: string, name: string, value: string, id = `${type}-${value}`): DnsRecordLike => ({
  recordId: id,
  type,
  name,
  value,
});

describe('planning an A record', () => {
  it('creates when the name is free', () => {
    const plan = planARecord([rec('A', 'other', '198.51.100.1')], NAME, FQDN, IP);
    expect(plan.action).toBe('create');
    expect(plan.occupied).toEqual([]);
  });

  it('reuses a record that already says what we want', () => {
    const plan = planARecord([rec('A', NAME, IP)], NAME, FQDN, IP);
    expect(plan.action).toBe('reuse');
    expect(plan.existing?.recordId).toBe(`A-${IP}`);
  });

  it('matches a name however the provider spells it', () => {
    // Providers return relative ('app'), absolute ('app.example.com') or rooted.
    for (const spelling of [NAME, FQDN, `${FQDN}.`, 'APP']) {
      expect(planARecord([rec('A', spelling, IP)], NAME, FQDN, IP).action).toBe('reuse');
    }
  });

  it('REFUSES a name that already points somewhere else', () => {
    // A name serving something real would be silently destroyed, and DNS has no undo.
    const plan = planARecord([rec('A', NAME, '198.51.100.7')], NAME, FQDN, IP);
    expect(plan.action).toBe('conflict');
    expect(plan.reason).toBe('points-elsewhere');
    expect(plan.stale.map((r) => r.value)).toEqual(['198.51.100.7']);
  });

  it('treats a second A value as a conflict, not as litter', () => {
    // Two A records round-robin, so half the traffic already goes to a host that
    // belongs to someone else.
    const plan = planARecord([rec('A', NAME, IP), rec('A', NAME, '198.51.100.7')], NAME, FQDN, IP);
    expect(plan.action).toBe('conflict');
    expect(plan.reason).toBe('points-elsewhere');
  });

  it('refuses when a CNAME occupies the name', () => {
    // DNS forbids any other record beside a CNAME.
    const plan = planARecord([rec('CNAME', NAME, 'elsewhere.example.net')], NAME, FQDN, IP);
    expect(plan.action).toBe('conflict');
    expect(plan.reason).toBe('cname-present');
  });

  it('ignores record types that legitimately coexist with an A', () => {
    // A TXT beside an A is how half the world proves domain ownership; AAAA is
    // dual-stack. Calling these conflicts would refuse ordinary zones.
    const plan = planARecord(
      [rec('TXT', NAME, 'v=verification'), rec('AAAA', NAME, '2001:db8::1'), rec('MX', NAME, 'mx.example.com')],
      NAME,
      FQDN,
      IP,
    );
    expect(plan.action).toBe('create');
  });

  it('still reuses when unrelated types share the name', () => {
    const plan = planARecord([rec('TXT', NAME, 'v=spf1 ~all'), rec('A', NAME, IP)], NAME, FQDN, IP);
    expect(plan.action).toBe('reuse');
  });

  it('reports what is published, for the message', () => {
    const plan = planARecord([rec('A', NAME, '198.51.100.7')], NAME, FQDN, IP);
    expect(plan.occupied).toEqual([{ type: 'A', value: '198.51.100.7' }]);
  });

  it('handles the apex', () => {
    expect(planARecord([rec('A', '@', IP)], '@', 'example.com', IP).action).toBe('reuse');
  });

  it('tolerates whitespace around a provider-returned value', () => {
    expect(planARecord([rec('A', NAME, ` ${IP} `)], NAME, FQDN, IP).action).toBe('reuse');
  });
});

describe('the conflict message', () => {
  it('names the hostname, what is there, and the way out', () => {
    const plan = planARecord([rec('A', NAME, '198.51.100.7')], NAME, FQDN, IP);
    const err = new DnsConflictError(FQDN, plan);
    expect(err.message).toContain(FQDN);
    expect(err.message).toContain('198.51.100.7');
    expect(err.message).toContain('--force-dns');
  });

  it('does not offer --force-dns for a CNAME, which forcing cannot fix', () => {
    const plan = planARecord([rec('CNAME', NAME, 'elsewhere.example.net')], NAME, FQDN, IP);
    const err = new DnsConflictError(FQDN, plan);
    expect(err.message).toContain('CNAME');
    expect(err.message).not.toContain('--force-dns');
  });
});

describe('name matching', () => {
  it('accepts relative, absolute and rooted forms', () => {
    expect(sameName('app', NAME, FQDN)).toBe(true);
    expect(sameName('app.example.com.', NAME, FQDN)).toBe(true);
    expect(sameName('App.Example.Com', NAME, FQDN)).toBe(true);
  });

  it('does not match a different label', () => {
    expect(sameName('apps', NAME, FQDN)).toBe(false);
    expect(sameName('app.other.com', NAME, FQDN)).toBe(false);
  });
});
