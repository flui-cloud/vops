import { domainOptions, isPubliclyResolvable } from '../src/apps/domain-options';

const HOST = '203.0.113.10';

const build = (zones: Array<{ provider: string; zoneName: string }>) =>
  domainOptions({ hostAddress: HOST, installName: 'home-assistant', zones });

describe('offering the domains that are actually possible', () => {
  it('always ends with a way forward, even with no DNS at all', () => {
    const opts = build([]);
    expect(opts.map((o) => o.kind)).toEqual(['byo', 'sslip']);
    // With nothing better available, the zero-config one is what to preselect.
    expect(opts.find((o) => o.recommended)?.kind).toBe('sslip');
  });

  it('prefers a zone vops can write to over the temporary domain', () => {
    const opts = build([{ provider: 'hetzner', zoneName: 'example.com' }]);
    const recommended = opts.find((o) => o.recommended);
    expect(recommended?.kind).toBe('managed-zone');
    expect(recommended?.hostname).toBe('home-assistant.example.com');
    expect(opts.find((o) => o.kind === 'sslip')?.recommended).toBe(false);
  });

  it('proposes one hostname per zone, shortest first, recommending only one', () => {
    const opts = build([
      { provider: 'hetzner', zoneName: 'longer.example.com' },
      { provider: 'scaleway', zoneName: 'short.io' },
    ]);
    const managed = opts.filter((o) => o.kind === 'managed-zone');
    expect(managed.map((o) => o.zone)).toEqual(['short.io', 'longer.example.com']);
    expect(managed.filter((o) => o.recommended)).toHaveLength(1);
  });

  it('never offers a private DNS zone — a cert can never be issued for one', () => {
    // Found against a real Scaleway project: VPC private DNS lists zones like
    // <uuid>.<uuid>.privatedns, which resolve only inside the VPC. Offering one
    // fails at issuance, AFTER the app is deployed.
    const opts = build([
      { provider: 'scaleway', zoneName: 'da76fd03-c3b6-4aa2-b18c-244615ad9630.a1937079-a302-4684-8647-3260963d98b9.privatedns' },
      { provider: 'hetzner', zoneName: 'flui.cloud' },
    ]);
    const managed = opts.filter((o) => o.kind === 'managed-zone');
    expect(managed).toHaveLength(1);
    expect(managed[0]?.zone).toBe('flui.cloud');
  });

  it('falls back to the temporary domain when every zone is private', () => {
    const opts = build([{ provider: 'scaleway', zoneName: 'x.privatedns' }]);
    expect(opts.filter((o) => o.kind === 'managed-zone')).toHaveLength(0);
    expect(opts.find((o) => o.recommended)?.kind).toBe('sslip');
  });

  it('does not offer the same zone twice when two providers list it', () => {
    const opts = build([
      { provider: 'hetzner', zoneName: 'example.com' },
      { provider: 'scaleway', zoneName: 'Example.com.' },
    ]);
    expect(opts.filter((o) => o.kind === 'managed-zone')).toHaveLength(1);
  });

  it('says who creates the record and whether the certificate can be trusted', () => {
    const opts = build([{ provider: 'hetzner', zoneName: 'example.com' }]);
    const managed = opts.find((o) => o.kind === 'managed-zone');
    const byo = opts.find((o) => o.kind === 'byo');
    const sslip = opts.find((o) => o.kind === 'sslip');

    expect([managed?.dns, managed?.tls]).toEqual(['automatic', 'reliable']);
    expect([byo?.dns, byo?.tls]).toEqual(['manual', 'reliable']);
    // The honest bit: sslip.io shares one Let's Encrypt bucket with the world.
    expect([sslip?.dns, sslip?.tls]).toEqual(['not-needed', 'best-effort']);
    expect(sslip?.detail).toMatch(/50 certificates/);
  });

  it('leaves the bring-your-own hostname empty and tells the user where to point it', () => {
    const byo = build([]).find((o) => o.kind === 'byo');
    expect(byo?.hostname).toBe('');
    expect(byo?.detail).toContain(HOST);
  });

  it('derives the temporary hostname from the host address', () => {
    expect(build([]).find((o) => o.kind === 'sslip')?.hostname).toBe('home-assistant.203-0-113-10.sslip.io');
  });

  it('sanitises an install name that is not hostname-safe', () => {
    const opts = domainOptions({ hostAddress: HOST, installName: 'My App_1', zones: [{ provider: 'hetzner', zoneName: 'example.com' }] });
    expect(opts[0]?.hostname).toMatch(/^[a-z0-9-]+\.example\.com$/);
  });
});

describe('public resolvability', () => {
  it('accepts real domains', () => {
    for (const z of ['flui.cloud', 'gojodigital.com', 'fluicloud.eu', 'a.b.example.org']) {
      expect(isPubliclyResolvable(z)).toBe(true);
    }
  });

  it('rejects the suffixes reserved for private use', () => {
    for (const z of ['x.privatedns', 'host.local', 'srv.internal', 'a.home.arpa', 'db.lan', 'foo.test', 'localhost']) {
      expect(isPubliclyResolvable(z)).toBe(false);
    }
  });

  it('ignores case and a trailing dot', () => {
    expect(isPubliclyResolvable('Flui.Cloud.')).toBe(true);
    expect(isPubliclyResolvable('X.PrivateDNS.')).toBe(false);
  });
});
