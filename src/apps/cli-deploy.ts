import { Command } from '@oclif/core';
import chalk from 'chalk';
import { AppAccessPart, AppEndpoint } from './app.model';
import { AppAccessView } from './app-deploy-support';
import type { DeployPlanView, DeployResult } from './vops-apps.service';
import type { DeployView } from './deploy-flags';

export function renderDeploy(cmd: Command, view: DeployView): void {
  if ('files' in view) renderPlan(cmd, view);
  else renderResult(cmd, view);
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
