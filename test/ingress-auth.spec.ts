import bcrypt from 'bcryptjs';
import { ingressAuthSecretName, parseAuthMode, resolveDeployGate, resolveIngressAuth } from '../src/apps/ingress-auth';
import { AUTH_HASH_RE, assertRouteAuth } from '../src/apps/ingress-render';
import { buildIngressAuthSecretScript } from '../src/apps/ingress-scripts';
import { AppIngressAuthState } from '../src/apps/app.model';

const HASH = '$2b$12$H.UWvAr0oXzzYyj3x.hOpeuzCdS3Xaa9ydekTKLXT/LAq483VTwHK';
const prevAuth: AppIngressAuthState = { mode: 'basic', user: 'op', secret: 'vops-blog-ingress-auth', hash: HASH };

describe('ingress-auth — resolveIngressAuth', () => {
  it('generates a strong password + a valid bcrypt hash that verifies', () => {
    const r = resolveIngressAuth('blog', { mode: 'basic' })!;
    expect(r.user).toBe('admin');
    expect(r.generated).toBe(true);
    expect(r.plaintext.length).toBeGreaterThanOrEqual(20);
    expect(AUTH_HASH_RE.test(r.hash)).toBe(true);
    expect(bcrypt.compareSync(r.plaintext, r.hash)).toBe(true);
    expect(r.secret).toBe(ingressAuthSecretName('blog'));
  });
  it('honours a user-set password and a custom username', () => {
    const r = resolveIngressAuth('blog', { mode: 'basic', user: 'ops', pass: 'hunter2' })!;
    expect(r.user).toBe('ops');
    expect(r.generated).toBe(false);
    expect(bcrypt.compareSync('hunter2', r.hash)).toBe(true);
  });
  it('rejects a username that could break out of the config', () => {
    expect(() => resolveIngressAuth('blog', { mode: 'basic', user: 'a\nb' })).toThrow();
    expect(() => resolveIngressAuth('blog', { mode: 'basic', user: 'a{b}' })).toThrow();
  });
  it('mode none resolves to no gate', () => {
    expect(resolveIngressAuth('blog', { mode: 'none' })).toBeNull();
  });
});

describe('ingress-auth — resolveDeployGate safety rules', () => {
  it('warns (does NOT block) when a firstVisit app is exposed with no --auth choice', () => {
    const d = resolveDeployGate('blog', { hasIngress: true, accessMode: 'firstVisit' });
    expect(d.gate).toBeNull();
    expect(d.warnings.join(' ')).toMatch(/first visitor/i);
  });
  it('lets --auth none acknowledge naked exposure of a firstVisit app (no warning)', () => {
    const d = resolveDeployGate('blog', { hasIngress: true, accessMode: 'firstVisit', intent: { mode: 'none' } });
    expect(d.gate).toBeNull();
    expect(d.warnings).toEqual([]);
  });
  it('gates a firstVisit app when --auth basic is given', () => {
    const { gate } = resolveDeployGate('blog', { hasIngress: true, accessMode: 'firstVisit', intent: { mode: 'basic' } });
    expect(gate!.secret?.name).toBe(ingressAuthSecretName('blog'));
    expect(gate!.state.mode).toBe('basic');
    assertRouteAuth(gate!.routeAuth); // well-formed for the renderer
  });
  it('refuses --auth basic without a domain to gate', () => {
    expect(() => resolveDeployGate('blog', { hasIngress: false, intent: { mode: 'basic' } })).toThrow(/--domain/);
  });
  it('a plain (non-firstVisit) app with no --auth stays ungated and silent', () => {
    const d = resolveDeployGate('tools', { hasIngress: true, accessMode: 'none' });
    expect(d.gate).toBeNull();
    expect(d.warnings).toEqual([]);
  });
});

describe('ingress-auth — redeploy preserves the gate', () => {
  it('inherits a prior gate when no --auth flag is passed (never silently ungates)', () => {
    const { gate } = resolveDeployGate('blog', { hasIngress: true, accessMode: 'firstVisit', prevAuth });
    expect(gate!.routeAuth).toEqual({ user: 'op', hash: HASH });
    expect(gate!.secret).toBeUndefined(); // secret already on the host — not recreated
    expect(gate!.generated).toBe(false);
    expect(gate!.state).toBe(prevAuth);
  });
  it('--auth none drops an inherited gate on purpose', () => {
    expect(resolveDeployGate('blog', { hasIngress: true, prevAuth, intent: { mode: 'none' } }).gate).toBeNull();
  });
  it('does not inherit a gate when the app is no longer fronted by a domain', () => {
    expect(resolveDeployGate('blog', { hasIngress: false, prevAuth }).gate).toBeNull();
  });
});

describe('ingress-auth — secret script', () => {
  it('creates the secret idempotently over stdin (printf builtin) and reports @@auth', () => {
    const s = buildIngressAuthSecretScript('vops-blog-ingress-auth', 'p4ss');
    expect(s).toContain('podman secret inspect');
    expect(s).toContain('printf %s');
    expect(s).toContain('podman secret create');
    expect(s).toContain("echo '@@auth'");
    expect(s).not.toContain('hash-password'); // never hashes on the host
  });
});

describe('ingress-auth — parseAuthMode', () => {
  it('accepts the two modes, rejects anything else', () => {
    expect(parseAuthMode('basic')).toBe('basic');
    expect(parseAuthMode('none')).toBe('none');
    expect(parseAuthMode('sso')).toBeUndefined();
    expect(parseAuthMode(undefined)).toBeUndefined();
  });
});
