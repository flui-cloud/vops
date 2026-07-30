import { Flags } from '@oclif/core';
import { AgentWarning, EnvelopeOptions } from '../agent-api/agent-envelope';
import { approvalPending } from '../safety/approval-gate';
import { IngressAuthIntent, parseAuthMode } from './ingress-auth';
import { deployInvocation, redactedFlags } from './deploy-invocation';
import type { AppSource, DeployPlanView, DeployResult, VopsAppsService } from './vops-apps.service';

/** `--auth`, shared by every command that can put a domain in front of an app (`app install`,
 * `app deploy`, `app expose`, `deploy plan`) — one definition, because the rule it describes is
 * enforced in one place (`resolveDeployGate`) and a per-command copy would drift from it. */
export const ingressAuthFlag = {
  auth: Flags.string({
    options: ['none', 'basic'],
    description:
      "Put the exposed app behind an ingress login gate ('basic'), or acknowledge naked exposure ('none'). " +
      'Required with --domain when the app has no login of its own — nothing asks you for a password, or its ' +
      'first visitor becomes its admin; an app with its own login, or a redeploy that already has a gate, needs no flag.',
  }),
};

/** Ingress flags shared by `app install` and `app deploy`. */
export const ingressDeployFlags = {
  domain: Flags.string({ description: 'Front the app with this hostname via the vops ingress (or "auto" for an sslip.io demo host)' }),
  email: Flags.string({ description: 'ACME account email (required to provision ingress on a host that has none yet)' }),
  tls: Flags.boolean({ default: true, allowNo: true, description: 'Request a TLS certificate for --domain (use --no-tls for plain HTTP)' }),
  staging: Flags.boolean({ default: false, description: 'Use Let’s Encrypt staging (browser-untrusted, no rate limit — for testing)' }),
  'expose-direct': Flags.boolean({ default: false, description: 'Keep the app on its public high port too, alongside ingress' }),
  public: Flags.boolean({ allowNo: true, description: 'Bind published ports on 0.0.0.0 (reachable from any network the host is on). Default: loopback-only — the app answers only on the host itself; give it a --domain to reach it from anywhere.' }),
  'force-dns': Flags.boolean({ default: false, description: 'Repoint the hostname even if its DNS record already points somewhere else' }),
  ...ingressAuthFlag,
  'auth-user': Flags.string({ description: 'Basic-auth username for --auth basic (default: admin)' }),
  'auth-pass': Flags.string({ description: 'Basic-auth password for --auth basic (default: a generated one, shown once + revealable)' }),
};

/** Which install a name-taking `app` command means. Installs are keyed by `(host, name)`, so the
 * same name can exist on two hosts; this is matched against the RECORDED host, so it also reaches
 * an install whose server has since left the inventory. */
export const installHostFlag = {
  host: Flags.string({ description: 'Host carrying the install (needed only when the same name exists on more than one; also reaches an install whose host is gone)' }),
};

/** Image + pull credentials for a `kind: Application` manifest built elsewhere. */
export const imageDeployFlags = {
  image: Flags.string({ description: 'Image to run for a kind: Application manifest (from `vops build run`, or one you already have)' }),
  'registry-user': Flags.string({ description: 'Registry username, when the image is private' }),
  'registry-token': Flags.string({ description: 'Registry token with read access to packages (written to root auth.json on the host)', env: 'VOPS_REGISTRY_TOKEN' }),
};

export interface DeployFlags {
  host: string;
  name?: string;
  image?: string;
  'registry-user'?: string;
  'registry-token'?: string;
  set?: string[];
  domain?: string;
  email?: string;
  tls: boolean;
  staging: boolean;
  'expose-direct': boolean;
  'force-dns'?: boolean;
  public?: boolean;
  auth?: string;
  'auth-user'?: string;
  'auth-pass'?: string;
  yes: boolean;
  'dry-run': boolean;
  json: boolean;
}

export function parseSet(pairs?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const eq = p.indexOf('=');
    if (eq < 0) throw new Error(`Invalid --set '${p}' (expected KEY=value).`);
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

export function registryFromFlags(flags: { 'registry-user'?: string; 'registry-token'?: string }) {
  const user = flags['registry-user'];
  const token = flags['registry-token'];
  return user && token ? { user, token } : undefined;
}

/** The ingress basic-auth intent from `--auth`/`--auth-user`/`--auth-pass` (undefined when no --auth). */
export function authFromFlags(flags: { auth?: string; 'auth-user'?: string; 'auth-pass'?: string }): IngressAuthIntent | undefined {
  const mode = parseAuthMode(flags.auth);
  if (!mode) return undefined;
  return { mode, user: flags['auth-user'], pass: flags['auth-pass'] };
}

/** Build the ingress option block from flags (undefined when neither a domain nor an
 * auth gate is requested — the service refuses `--auth basic` without a domain). */
export function ingressFromFlags(flags: DeployFlags) {
  const auth = authFromFlags(flags);
  if (!flags.domain && !auth) return undefined;
  return { domain: flags.domain, email: flags.email, tls: flags.tls, staging: flags.staging, exposeDirect: flags['expose-direct'], forceDns: flags['force-dns'], auth };
}

export type DeployView = DeployPlanView | DeployResult;

/** Shared deploy driver for `app install`/`app deploy`, as the envelope body those commands hand
 * to `runAgentCommand`. Without `--yes` (or with `--dry-run`) it produces the plan and refuses —
 * the consent gate — with the plan itself as the envelope payload, since a refusal an agent
 * cannot read is a refusal it cannot put to the user. */
export async function deployBody(
  svc: Pick<VopsAppsService, 'deploy'>,
  source: AppSource,
  flags: DeployFlags,
): Promise<{ data: DeployView } & EnvelopeOptions> {
  const set = parseSet(flags.set);
  const ingress = ingressFromFlags(flags);
  const registry = registryFromFlags(flags);
  const target = { ...source, ...(flags.image ? { image: flags.image } : {}) };

  if (flags['dry-run'] || !flags.yes) {
    const view = (await svc.deploy(target, flags.host, { name: flags.name, set, ingress, public: flags.public, dryRun: true })) as DeployPlanView;
    if (flags.yes) return { data: view, warnings: deployWarnings(view.warnings) };
    return {
      data: view,
      warnings: deployWarnings(view.warnings),
      ...approvalPending({
        operation: 'Deploy',
        target: `${view.app} → ${flags.host}`,
        consequence: 'It creates containers on the host and may replace an app of the same name.',
      }),
      nextActions: [{ command: deployInvocation(source, flags), description: redeployDescription(source, flags) }],
    };
  }

  const res = (await svc.deploy(target, flags.host, { name: flags.name, set, ingress, public: flags.public, registry })) as DeployResult;
  return {
    data: res,
    warnings: deployWarnings(res.warnings),
    nextActions: [{ command: `vops app status ${res.app} --host ${res.host} --json`, description: 'Confirm the units came up before reporting success' }],
  };
}

function deployWarnings(warnings?: string[]): AgentWarning[] {
  return (warnings ?? []).map((message) => ({ code: 'VOPS_DEPLOY_ADVISORY', message }));
}

/** Envelope warnings for `app expose`, which runs the very same deploy: the ingress advisories AND
 * the deploy's own. Dropping the latter hid every plan-level advisory at the one moment a domain is
 * put in front of an app — the `exposure: internal` notice among them. */
export function exposeWarnings(data: Pick<DeployResult, 'ingress' | 'warnings'>): AgentWarning[] {
  return [
    ...(data.ingress?.warnings ?? []).map((message) => ({ code: 'VOPS_INGRESS_ADVISORY', message })),
    ...deployWarnings(data.warnings),
  ];
}

function redeployDescription(source: AppSource, flags: DeployFlags): string {
  const redacted = redactedFlags(source, flags);
  const base = 'Deploy once the user has approved this plan';
  if (!redacted.length) return base;
  return `${base} — re-supply the values behind ${redacted.join(', ')}, which are not echoed here`;
}
