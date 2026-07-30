import bcrypt from 'bcryptjs';
import { AgentBadRequest } from '../src/agent-api/agent-http-errors';
import { ingressAuthSecretName, parseAuthMode, resolveDeployGate, resolveIngressAuth } from '../src/apps/ingress-auth';
import { AUTH_HASH_RE, assertRouteAuth } from '../src/apps/ingress-render';
import { buildIngressAuthSecretScript } from '../src/apps/ingress-scripts';
import { AppIngressAuthState } from '../src/apps/app.model';

const HASH = '$2b$12$H.UWvAr0oXzzYyj3x.hOpeuzCdS3Xaa9ydekTKLXT/LAq483VTwHK';
const prevAuth: AppIngressAuthState = { mode: 'basic', user: 'op', secret: 'vops-blog-ingress-auth', hash: HASH };

function refusalOf(run: () => unknown): AgentBadRequest {
  try {
    run();
  } catch (e) {
    return e as AgentBadRequest;
  }
  throw new Error('expected a refusal, got a resolved gate');
}

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

/**
 * Exposing an app that has no reachable login on a public domain REFUSES — it does not warn —
 * until `--auth basic|none` says which risk the operator is taking.
 */
describe('ingress-auth — resolveDeployGate safety rules', () => {
  it('refuses to expose a firstVisit app with no --auth choice', () => {
    expect(() => resolveDeployGate('blog', { hasIngress: true, accessMode: 'firstVisit' })).toThrow(/--auth basic/);
  });
  it('lets --auth none acknowledge naked exposure of a firstVisit app', () => {
    expect(resolveDeployGate('blog', { hasIngress: true, accessMode: 'firstVisit', intent: { mode: 'none' } })).toBeNull();
  });
  it('gates a firstVisit app when --auth basic is given', () => {
    const gate = resolveDeployGate('blog', { hasIngress: true, accessMode: 'firstVisit', intent: { mode: 'basic' } });
    expect(gate!.secret?.name).toBe(ingressAuthSecretName('blog'));
    expect(gate!.state.mode).toBe('basic');
    assertRouteAuth(gate!.routeAuth); // well-formed for the renderer
  });
  it('refuses --auth basic without a domain to gate', () => {
    expect(() => resolveDeployGate('blog', { hasIngress: false, intent: { mode: 'basic' } })).toThrow(/--domain/);
  });
  it('a plain (non-firstVisit) app with no --auth stays ungated and silent', () => {
    expect(resolveDeployGate('tools', { hasIngress: true, accessMode: 'none' })).toBeNull();
  });

  // An app that declares NO authentication of its own (dbgate) was silent where a
  // firstVisit app was warned — the one with no login treated as safer than the one
  // whose login is claimed by the first visitor. Both are refusals now.
  it('refuses to expose an app declaring no authentication of its own', () => {
    expect(() => resolveDeployGate('dbgate', { hasIngress: true, authMode: 'none' })).toThrow(/no login of its own/i);
  });
  it('names both ways out and carries the documented code + exit status', () => {
    const err = refusalOf(() => resolveDeployGate('dbgate', { hasIngress: true, authMode: 'none' }));
    expect(err).toBeInstanceOf(AgentBadRequest);
    expect(err.agent.code).toBe('VOPS_APP_EXPOSURE_UNGATED');
    expect(err.agent.category).toBe('input');
    expect(err.agent.recoverable).toBe(true);
    expect(err.agent.suggestedAction).toMatch(/--auth basic/);
    expect(err.agent.suggestedAction).toMatch(/--auth none/);
    expect(err.exitCode).toBe(2);
  });
  it('leaves a bare (un-exposed) install of a no-auth app alone', () => {
    expect(resolveDeployGate('dbgate', { hasIngress: false, authMode: 'none' })).toBeNull();
  });
  it('does not refuse when the app hands out credentials instead of a login (meilisearch key)', () => {
    expect(resolveDeployGate('meili', { hasIngress: true, authMode: 'none', accessMode: 'credentials' })).toBeNull();
  });
  it('does not refuse an app that declares a login of its own', () => {
    expect(resolveDeployGate('vaultwarden', { hasIngress: true, authMode: 'native' })).toBeNull();
  });
  it('does not refuse a manifest that declares no auth block at all', () => {
    expect(resolveDeployGate('vaultwarden', { hasIngress: true, accessMode: 'credentials' })).toBeNull();
  });
  it('lets --auth none acknowledge a no-auth app, and --auth basic gate it', () => {
    expect(resolveDeployGate('dbgate', { hasIngress: true, authMode: 'none', intent: { mode: 'none' } })).toBeNull();
    const gate = resolveDeployGate('dbgate', { hasIngress: true, authMode: 'none', intent: { mode: 'basic' } });
    expect(gate!.state.mode).toBe('basic');
  });
  it('a redeploy of an already-gated no-auth app needs no flag (inherits, does not refuse)', () => {
    const gate = resolveDeployGate('dbgate', { hasIngress: true, authMode: 'none', prevAuth });
    expect(gate!.routeAuth).toEqual({ user: 'op', hash: HASH });
  });
});

describe('ingress-auth — redeploy preserves the gate', () => {
  it('inherits a prior gate when no --auth flag is passed (never silently ungates)', () => {
    const gate = resolveDeployGate('blog', { hasIngress: true, accessMode: 'firstVisit', prevAuth });
    expect(gate!.routeAuth).toEqual({ user: 'op', hash: HASH });
    expect(gate!.secret).toBeUndefined(); // secret already on the host — not recreated
    expect(gate!.generated).toBe(false);
    expect(gate!.state).toBe(prevAuth);
  });
  it('--auth none drops an inherited gate on purpose', () => {
    expect(resolveDeployGate('blog', { hasIngress: true, prevAuth, intent: { mode: 'none' } })).toBeNull();
  });
  it('does not inherit a gate when the app is no longer fronted by a domain', () => {
    expect(resolveDeployGate('blog', { hasIngress: false, prevAuth })).toBeNull();
  });

  // Re-running the SAME `--auth basic` must not mint a new password: a fresh hash in the route
  // while the podman secret is skipped (create-only) leaves `app credentials --show` reporting a
  // password that returns 401 forever.
  it('re-asserting --auth basic with no password keeps the stored hash instead of rotating', () => {
    const gate = resolveDeployGate('blog', { hasIngress: true, prevAuth, intent: { mode: 'basic' } });
    expect(gate!.routeAuth).toEqual({ user: 'op', hash: HASH });
    expect(gate!.secret).toBeUndefined();
    expect(gate!.generated).toBe(false);
    expect(gate!.state).toEqual(prevAuth);
  });
  it('keeps the prior username on --auth basic (does not reset it to admin)', () => {
    const gate = resolveDeployGate('blog', { hasIngress: true, prevAuth, intent: { mode: 'basic' } });
    expect(gate!.state.user).toBe('op');
  });
  it('applies a new --auth-user to the kept password (bcrypt hashes the password only)', () => {
    const gate = resolveDeployGate('blog', { hasIngress: true, prevAuth, intent: { mode: 'basic', user: 'ops2' } });
    expect(gate!.routeAuth).toEqual({ user: 'ops2', hash: HASH });
    expect(gate!.secret).toBeUndefined();
    expect(gate!.state).toEqual({ ...prevAuth, user: 'ops2' });
  });
  it('still validates a username handed to a kept gate', () => {
    expect(() => resolveDeployGate('blog', { hasIngress: true, prevAuth, intent: { mode: 'basic', user: 'a{b}' } })).toThrow();
  });
  it('rotates — and ships the new plaintext — when --auth-pass is given explicitly', () => {
    const gate = resolveDeployGate('blog', { hasIngress: true, prevAuth, intent: { mode: 'basic', pass: 'rotated1' } });
    expect(gate!.secret).toEqual({ name: 'vops-blog-ingress-auth', plaintext: 'rotated1' });
    expect(bcrypt.compareSync('rotated1', gate!.state.hash)).toBe(true);
    expect(gate!.routeAuth.hash).toBe(gate!.state.hash);
  });
  it('generates on the first --auth basic (no prior gate) and ships the plaintext', () => {
    const gate = resolveDeployGate('blog', { hasIngress: true, intent: { mode: 'basic' } });
    expect(gate!.generated).toBe(true);
    expect(bcrypt.compareSync(gate!.secret!.plaintext, gate!.state.hash)).toBe(true);
  });
});

describe('ingress-auth — secret script', () => {
  it('writes the secret over stdin (printf builtin) and reports @@auth', () => {
    const s = buildIngressAuthSecretScript('vops-blog-ingress-auth', 'p4ss');
    expect(s).toContain('podman secret inspect');
    expect(s).toContain('printf %s');
    expect(s).toContain('podman secret create');
    expect(s).toContain("echo '@@auth'");
    expect(s).not.toContain('hash-password'); // never hashes on the host
  });
  // The create was guarded by `if ! podman secret inspect`, so a rotated password
  // rewrote the route hash while the secret kept the old plaintext.
  it('replaces an existing secret instead of skipping the write', () => {
    const s = buildIngressAuthSecretScript('vops-blog-ingress-auth', 'p4ss');
    expect(s).toContain("podman secret rm 'vops-blog-ingress-auth'");
    expect(s).not.toMatch(/if ! podman secret inspect/);
    expect(s.indexOf('secret rm')).toBeLessThan(s.indexOf('secret create'));
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
