/** Ingress basic-auth resolution — the ONE place that pulls a bcrypt implementation. Password is
 * generated and hashed **client-side** (bcryptjs), never `caddy hash-password` on the host (would put
 * plaintext in a remote argv); cost stays modest since bcrypt verifies on every request (self-DoS risk on 1 vCPU). */
import * as crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { AUTH_USER_RE, RouteAuth } from './ingress-render';
import type { AppAccessMode, AppIngressAuthState } from './app.model';

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
  const user = (intent.user ?? DEFAULT_USER).trim();
  if (!AUTH_USER_RE.test(user)) {
    throw new Error(`Invalid --auth-user '${user}' — allowed: letters, digits, and . _ - (max 32).`);
  }
  const provided = intent.pass ?? '';
  const generated = provided.length === 0;
  const plaintext = generated ? crypto.randomBytes(GEN_BYTES).toString('base64url') : provided;
  const hash = bcrypt.hashSync(plaintext, BCRYPT_COST);
  return { mode: 'basic', user, hash, secret: ingressAuthSecretName(app), plaintext, generated };
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
  /** Explicit operator choice, if any (`--auth basic|none`). */
  intent?: IngressAuthIntent;
  /** The gate a prior install already carried (inherited when no explicit choice). */
  prevAuth?: AppIngressAuthState;
}

export interface GateDecision {
  gate: IngressGate | null;
  /** Advisories to surface (e.g. a firstVisit app exposed without a gate). */
  warnings: string[];
}

/** Decide the effective gate: a redeploy with no `--auth` flag **preserves** an inherited gate
 * (never silently ungates). A **firstVisit** app exposed ungated is a real takeover race (CT logs
 * surface the hostname within minutes) — **warned, not blocked**, since the operator is right there. */
export function resolveDeployGate(app: string, i: ResolveGateInput): GateDecision {
  const explicit = i.intent?.mode;
  if (explicit === 'basic') {
    if (!i.hasIngress) {
      throw new Error('--auth basic gates the ingress — add --domain (or --domain auto) so there is something to gate.');
    }
    const r = resolveIngressAuth(app, i.intent);
    return {
      gate: {
        routeAuth: routeAuthOf(r),
        secret: { name: r.secret, plaintext: r.plaintext },
        state: { mode: 'basic', user: r.user, secret: r.secret, hash: r.hash },
        generated: r.generated,
      },
      warnings: [],
    };
  }
  if (explicit === 'none') return { gate: null, warnings: [] }; // acknowledged naked exposure — drop any inherited gate
  if (i.prevAuth && i.hasIngress) {
    return { gate: { routeAuth: { user: i.prevAuth.user, hash: i.prevAuth.hash }, state: i.prevAuth, generated: false }, warnings: [] };
  }
  const warnings =
    i.hasIngress && i.accessMode === 'firstVisit'
      ? [`'${app}' hands admin to the first visitor of its public URL — open it now to claim the account, or re-run with --auth basic to put a login gate in front.`]
      : [];
  return { gate: null, warnings };
}
