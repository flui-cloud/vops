import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { AppAccessPart, AppEndpoint } from './app.model';
import { AppAccessView } from './app-deploy-support';
import { IngressAuthIntent, parseAuthMode } from './ingress-auth';
import {
  AppSource,
  DeployPlanView,
  DeployResult,
  VopsAppsService,
} from './vops-apps.service';

/** Ingress flags shared by `app install` and `app deploy`. */
export const ingressDeployFlags = {
  domain: Flags.string({ description: 'Front the app with this hostname via the vops ingress (or "auto" for an sslip.io demo host)' }),
  email: Flags.string({ description: 'ACME account email (required to provision ingress on a host that has none yet)' }),
  tls: Flags.boolean({ default: true, allowNo: true, description: 'Request a TLS certificate for --domain (use --no-tls for plain HTTP)' }),
  staging: Flags.boolean({ default: false, description: 'Use Let’s Encrypt staging (browser-untrusted, no rate limit — for testing)' }),
  'expose-direct': Flags.boolean({ default: false, description: 'Keep the app on its public high port too, alongside ingress' }),
  public: Flags.boolean({ allowNo: true, description: 'Bind published ports on 0.0.0.0 (reachable from any network the host is on). Default: loopback-only — the app answers only on the host itself; give it a --domain to reach it from anywhere.' }),
  'force-dns': Flags.boolean({ default: false, description: 'Repoint the hostname even if its DNS record already points somewhere else' }),
  auth: Flags.string({ options: ['none', 'basic'], description: "Put the exposed app behind an ingress login gate ('basic'), or acknowledge naked exposure ('none'). Required to expose a first-visit-admin app." }),
  'auth-user': Flags.string({ description: 'Basic-auth username for --auth basic (default: admin)' }),
  'auth-pass': Flags.string({ description: 'Basic-auth password for --auth basic (default: a generated one, shown once + revealable)' }),
};

export function parseSet(pairs?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const eq = p.indexOf('=');
    if (eq < 0) throw new Error(`Invalid --set '${p}' (expected KEY=value).`);
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

/** Image + pull credentials for a `kind: Application` manifest built elsewhere. */
export const imageDeployFlags = {
  image: Flags.string({ description: 'Image to run for a kind: Application manifest (from `vops build run`, or one you already have)' }),
  'registry-user': Flags.string({ description: 'Registry username, when the image is private' }),
  'registry-token': Flags.string({ description: 'Registry token with read access to packages (written to root auth.json on the host)', env: 'VOPS_REGISTRY_TOKEN' }),
};

export function registryFromFlags(flags: { 'registry-user'?: string; 'registry-token'?: string }) {
  const user = flags['registry-user'];
  const token = flags['registry-token'];
  return user && token ? { user, token } : undefined;
}

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

/** Shared deploy driver for `app install`/`app deploy`. Without `--yes` (or with `--dry-run`)
 * it renders the plan and refuses — the bench-style consent gate. */
export async function runDeploy(cmd: Command, svc: VopsAppsService, source: AppSource, flags: DeployFlags): Promise<void> {
  const set = parseSet(flags.set);
  const ingress = ingressFromFlags(flags);
  const registry = registryFromFlags(flags);
  const target = { ...source, ...(flags.image ? { image: flags.image } : {}) };

  if (flags['dry-run'] || !flags.yes) {
    const view = (await svc.deploy(target, flags.host, { name: flags.name, set, ingress, public: flags.public, dryRun: true })) as DeployPlanView;
    if (flags.json) cmd.log(JSON.stringify(view, null, 2));
    else renderPlan(cmd, view);
    if (!flags.yes) cmd.error('Refusing to deploy without confirmation. Re-run with --yes.', { exit: 1 });
    if (flags['dry-run']) return;
  }

  const res = (await svc.deploy(target, flags.host, { name: flags.name, set, ingress, public: flags.public, registry })) as DeployResult;
  if (flags.json) cmd.log(JSON.stringify(res, null, 2));
  else renderResult(cmd, res);
}

function renderPlan(cmd: Command, v: DeployPlanView): void {
  cmd.log(chalk.bold(`${v.app}`) + chalk.dim(`  → ${v.host} · ${v.kind}${v.coexistence ? ' · k3s coexistence' : ''}`));
  cmd.log(chalk.dim(`unit dir: ${v.unitDir}`));
  if (v.secrets.length) cmd.log(chalk.dim(`secrets: ${v.secrets.join(', ')}`));
  for (const e of v.endpoints) cmd.log(`endpoint: ${chalk.cyan(e.url)} ${chalk.dim('(' + endpointTag(e, v.host) + ')')}`);
  loopbackHint(cmd, v.endpoints, v.host, '');
  if (v.ingress) {
    const ca = v.ingress.staging ? 'LE staging' : 'Let’s Encrypt';
    const scheme = v.ingress.tls ? `TLS (${ca})` : 'plain HTTP';
    cmd.log(chalk.magenta(`ingress: ${v.ingress.hostname}`) + chalk.dim(`  ${scheme} · the ingress will be ensured on :80/:443`));
    for (const w of v.ingress.warnings) cmd.log(chalk.yellow(`  ! ${w}`));
  }
  if (v.gate) cmd.log(chalk.magenta('ingress gate: ') + chalk.dim('basic-auth, user ') + chalk.cyan(v.gate.user));
  renderAccess(cmd, v.access, v.app);
  for (const w of v.warnings ?? []) cmd.log(chalk.yellow(`  ! ${w}`));
  cmd.log('');
  for (const [name, content] of Object.entries(v.files)) {
    cmd.log(chalk.bold.dim(`# ${name}`));
    cmd.log(content.trimEnd());
    cmd.log('');
  }
  cmd.log(chalk.dim('nothing was changed (dry-run/preflight).'));
}

function renderResult(cmd: Command, r: DeployResult): void {
  cmd.log(chalk.green('✓ deployed ') + chalk.bold(r.app) + chalk.dim(`  on ${r.host}`));
  for (const c of r.components) cmd.log(chalk.dim(`  ${c.name}: ${c.image}`));
  for (const e of r.endpoints) cmd.log(`  endpoint: ${chalk.cyan(e.url)} ${chalk.dim('(' + endpointTag(e, r.host) + ')')}`);
  loopbackHint(cmd, r.endpoints, r.host, '  ');
  if (r.ingress) {
    cmd.log(`  ${chalk.magenta('ingress:')} ${chalk.cyan((r.ingress.tls ? 'https://' : 'http://') + r.ingress.hostname)} ${chalk.dim('· ' + r.ingress.note)}`);
    for (const w of r.ingress.warnings) cmd.log(chalk.yellow(`  ! ${w}`));
  }
  cmd.log(chalk.dim(`  smoke: ${r.smoke}`));
  renderGate(cmd, r.gate, r.app);
  renderAccess(cmd, r.access, r.app);
  for (const w of r.warnings ?? []) cmd.log(chalk.yellow(`  ! ${w}`));
}

/** Post-deploy ingress-gate block — the login that fronts the app, kept distinct from
 * the app's own credentials. Never prints the password: a generated one is revealed on
 * demand, a user-set one was chosen by the operator. */
function renderGate(cmd: Command, gate: DeployResult['gate'], appName: string): void {
  if (!gate) return;
  cmd.log(chalk.bold('  ingress gate:') + chalk.dim(' basic-auth — a browser login before the app is reached'));
  cmd.log(chalk.dim('  gate user: ') + gate.user);
  const pass = gate.generated
    ? chalk.dim('generated → ') + chalk.cyan(`vops app credentials ${appName} --show`)
    : chalk.dim('(set at install)');
  cmd.log(chalk.dim('  gate pass: ') + pass);
}

/** Post-deploy login block. Never prints a secret value: generated creds point to
 * `vops app credentials`; user-set ones say so; only public defaults are shown. */
function renderAccess(cmd: Command, access: AppAccessView | undefined, appName: string): void {
  if (!access || access.mode === 'none') return;
  cmd.log(chalk.bold('  access:') + (access.url ? ' ' + chalk.cyan(access.url) : ''));
  if (access.mode === 'firstVisit') {
    cmd.log(chalk.yellow(`  ! ${access.note ?? 'The first visitor to this URL becomes the admin — open it now to claim the account.'}`));
    return;
  }
  if (access.username) cmd.log(chalk.dim('  user: ') + credDisplay(access.username, appName));
  if (access.password) cmd.log(chalk.dim('  pass: ') + credDisplay(access.password, appName));
  if (access.note) cmd.log(chalk.dim(`  note: ${access.note}`));
}

/** Endpoint parenthetical: a loopback endpoint is annotated as host-local so the printed
 * 127.0.0.1 URL is never mistaken for an internet-reachable address. */
function endpointTag(e: AppEndpoint, host: string): string {
  return e.reach === 'loopback' ? `${e.component} · local to ${host}` : e.component;
}

/** Say plainly that a loopback endpoint cannot be opened from here — the printed
 * `127.0.0.1:<port>` is real on the server, not the reader's machine, so name the host it belongs to. */
function loopbackHint(cmd: Command, endpoints: AppEndpoint[], host: string, indent: string): void {
  const loop = endpoints.find((e) => e.reach === 'loopback');
  if (!loop) return;
  cmd.log(
    chalk.yellow(`${indent}reachable only from ${host} itself`) +
      chalk.dim(' — that 127.0.0.1 is the server’s, not yours.'),
  );
  cmd.log(chalk.dim(`${indent}  from here:  `) + chalk.cyan(`ssh -L ${loop.port}:127.0.0.1:${loop.port} ${host}`));
  cmd.log(chalk.dim(`${indent}  or publish it:  `) + chalk.cyan(`vops app expose <name> --domain <hostname> --yes`));
}

function credDisplay(part: AppAccessPart, appName: string): string {
  if (part.kind === 'userSet') return chalk.dim('(set at install)');
  if (part.kind === 'generated') return chalk.dim('generated → ') + chalk.cyan(`vops app credentials ${appName} --show`);
  return part.value ?? '';
}
