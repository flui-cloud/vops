/** Ingress basic-auth resolution — the ONE place that pulls a bcrypt implementation. Password is
 * generated and hashed **client-side** (bcryptjs), never `caddy hash-password` on the host (would put
 * plaintext in a remote argv); cost stays modest since bcrypt verifies on every request (self-DoS risk on 1 vCPU). */
import * as crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ExitCode, agentError } from '../agent-api/agent-envelope';
import { AgentBadRequest } from '../agent-api/agent-http-errors';
import { AUTH_USER_RE, RouteAuth } from './ingress-render';
import type { AppAccessMode, AppAuthMode, AppIngressAuthState } from './app.model';

/** bcrypt cost — 12 is ample; 14 (caddy's default) is a per-request DoS lever on 1 vCPU. */
const BCRYPT_COST = 12;
const DEFAULT_USER = 'admin';
/** Generated-password entropy: 18 random bytes → 24 url-safe chars (~144 bits). */
const GEN_BYTES = 18;

export type IngressAuthMode = 'none' | 'basic';

/** Raw operator intent from `--auth`/`--auth-user`/`--auth-pass` (or the UI form). */
export interface IngressAuthIntent {
  mode: IngressAuthMode;
  user?: string;
  pass?: string;
}

/** A resolved gate: the bcrypt hash for the route fragment + the plaintext to stash as
 * a Podman secret. `generated` = vops chose the password (surface it to the operator). */
export interface IngressAuthResolved {
  mode: 'basic';
  user: string;
  hash: string;
  secret: string;
  /** Plaintext — travels once over SSH into `podman secret create`; never stored/printed. */
  plaintext: string;
  generated: boolean;
}

/** The Podman secret holding the gate password (root-only stash, never mounted). */
export function ingressAuthSecretName(app: string): string {
  return `vops-${app}-ingress-auth`;
}

export function parseAuthMode(v: string | undefined): IngressAuthMode | undefined {
  if (v === 'none' || v === 'basic') return v;
  return undefined;
}

/** Turn `--auth basic` intent into a rendered gate: validate the username (config-injection
 * guard), take `--auth-pass` or generate one, and bcrypt-hash it. Null for mode 'none'. */
export function resolveIngressAuth(app: string, intent: IngressAuthIntent): IngressAuthResolved | null {
  if (intent.mode !== 'basic') return null;
  const user = checkedUser(intent.user, DEFAULT_USER);
  const provided = intent.pass ?? '';
  const generated = provided.length === 0;
  const plaintext = generated ? crypto.randomBytes(GEN_BYTES).toString('base64url') : provided;
  const hash = bcrypt.hashSync(plaintext, BCRYPT_COST);
  return { mode: 'basic', user, hash, secret: ingressAuthSecretName(app), plaintext, generated };
}

function checkedUser(user: string | undefined, fallback: string): string {
  const u = (user ?? fallback).trim();
  if (!AUTH_USER_RE.test(u)) {
    throw new Error(`Invalid --auth-user '${u}' — allowed: letters, digits, and . _ - (max 32).`);
  }
  return u;
}

/** The render-facing view of a resolved gate (user + hash — no plaintext). */
export function routeAuthOf(a: IngressAuthResolved): RouteAuth {
  return { user: a.user, hash: a.hash };
}

/** A deploy-time gate decision: what to render into the route, an optional secret to
 * create host-side (present only when a new password was set this deploy), and the
 * state to persist so a redeploy re-applies the same gate. */
export interface IngressGate {
  routeAuth: RouteAuth;
  /** Create this Podman secret (plaintext) host-side before the fragment is written. */
  secret?: { name: string; plaintext: string };
  state: AppIngressAuthState;
  /** vops picked the password (surface it once) — false when user-set or inherited. */
  generated: boolean;
}

export interface ResolveGateInput {
  /** The app is being fronted by a public domain this deploy. */
  hasIngress: boolean;
  /** The manifest's access mode (firstVisit apps must not be exposed naked). */
  accessMode?: AppAccessMode;
  /** The manifest's effective auth mode — `none` means the app has no login of its own. */
  authMode?: AppAuthMode;
  /** Explicit operator choice, if any (`--auth basic|none`). */
  intent?: IngressAuthIntent;
  /** The gate a prior install already carried (inherited when no explicit choice). */
  prevAuth?: AppIngressAuthState;
}

/** An app the manifest says has no login of its own AND hands out no credentials: nothing stands
 * between its public URL and the internet. Declared-only — a manifest with no `auth` block makes no
 * claim either way, and refusing all of those would block apps whose login vops cannot see. */
function nakedByDeclaration(i: ResolveGateInput): boolean {
  return i.authMode === 'none' && i.accessMode !== 'credentials';
}

/** Decide the effective gate: a redeploy with no `--auth` flag **preserves** an inherited gate
 * (never silently ungates). Putting a public domain in front of an app that has no reachable
 * login of its own — a **firstVisit** admin race, or a manifest declaring no authentication at
 * all — is **refused** until the operator says which they mean (`--auth basic` to gate it,
 * `--auth none` to accept a naked URL): certificate transparency publishes that hostname within
 * seconds, and which risk to take is not vops's call to make silently. */
export function resolveDeployGate(app: string, i: ResolveGateInput): IngressGate | null {
  const explicit = i.intent?.mode;
  if (explicit === 'basic') {
    if (!i.hasIngress) {
      throw new Error('--auth basic gates the ingress — add --domain (or --domain auto) so there is something to gate.');
    }
    const kept = keptGate(i);
    if (kept) return kept;
    const r = resolveIngressAuth(app, i.intent);
    return {
      routeAuth: routeAuthOf(r),
      secret: { name: r.secret, plaintext: r.plaintext },
      state: { mode: 'basic', user: r.user, secret: r.secret, hash: r.hash },
      generated: r.generated,
    };
  }
  if (explicit === 'none') return null; // acknowledged naked exposure — drop any inherited gate
  if (i.prevAuth && i.hasIngress) {
    return { routeAuth: { user: i.prevAuth.user, hash: i.prevAuth.hash }, state: i.prevAuth, generated: false };
  }
  if (i.hasIngress) assertAuthChoice(app, i);
  return null;
}

/** `--auth basic` with no password on an app that already carries a gate is a re-assertion of that
 * gate, not a rotation: the stored hash is reused so the route keeps matching the Podman secret
 * `app credentials --show` reads back. Generating a fresh password here would rewrite the route but
 * leave the secret untouched, so the only password vops can show would stop authenticating.
 * A supplied password is an explicit rotation and falls through. */
function keptGate(i: ResolveGateInput): IngressGate | null {
  const prev = i.prevAuth;
  if (!prev || (i.intent?.pass ?? '').length > 0) return null;
  const user = checkedUser(i.intent?.user, prev.user);
  return { routeAuth: { user, hash: prev.hash }, state: { ...prev, user }, generated: false };
}

/** Why this app must not reach a public domain unattended, or null when it may. */
function nakedReason(i: ResolveGateInput): string | null {
  if (i.accessMode === 'firstVisit') {
    return 'it hands admin to the first visitor of its public URL, and certificate transparency logs publish that hostname within seconds';
  }
  if (nakedByDeclaration(i)) {
    return 'it has no login of its own — anyone who reaches its public URL is inside it, and certificate transparency logs publish that hostname within seconds';
  }
  return null;
}

const WAYS_OUT = 'Re-run with --auth basic to put a login gate in front, --auth none to expose it with no login at all, or drop --domain to keep it on the host.';

function assertAuthChoice(app: string, i: ResolveGateInput): void {
  const reason = nakedReason(i);
  if (!reason) return;
  throw new AgentBadRequest(
    agentError('VOPS_APP_EXPOSURE_UNGATED', 'input', `Refusing to expose '${app}' on a public domain: ${reason}. ${WAYS_OUT}`, {
      recoverable: true,
      suggestedAction: `Ask the user which they want, then re-run: \`--auth basic\` gates ${app} behind a generated login, \`--auth none\` exposes it with no login at all.`,
    }),
    ExitCode.INVALID_INPUT,
  );
}
