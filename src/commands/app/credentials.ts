import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { AppCredentialsView, VopsAppsService } from '../../apps/vops-apps.service';
import { AppAccessPart } from '../../apps/app.model';
import { AppAccessView } from '../../apps/app-deploy-support';

type Revealed = Record<string, string>;
type Gate = NonNullable<AppCredentialsView['gate']>;

export default class AppCredentials extends Command {
  static readonly description =
    'Show a deployed app’s login (URL + credentials) and any ingress basic-auth gate. ' +
    'Secrets are masked; --show reads them back from the host (podman secret --showsecret).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> nextcloud',
    '<%= config.bin %> <%= command.id %> vaultwarden --show',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    show: Flags.boolean({ default: false, description: 'Read back and print secret values from the host' }),
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppCredentials);
    try {
      const svc = (await getVopsApp()).get(VopsAppsService);
      const cred = await svc.credentials(args.name);

      const revealed: Revealed = {};
      if (flags.show) {
        const secrets = [cred.access?.username?.secret, cred.access?.password?.secret, cred.gate?.secret].filter(Boolean);
        for (const s of secrets) revealed[s] = (await svc.revealCredential(cred.app, s)).value;
      }

      if (flags.json) this.log(JSON.stringify(toJson(cred, revealed, flags.show), null, 2));
      else this.render(cred, revealed, flags.show);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }

  private render(cred: AppCredentialsView, revealed: Revealed, show: boolean): void {
    const { app, host, access, gate } = cred;
    const url = access?.url ?? gate?.url;
    this.log(chalk.bold(app) + chalk.dim(`  on ${host}`) + (url ? '  ' + chalk.cyan(url) : ''));
    if (gate) this.renderGate(gate, revealed, show);
    if (access) this.renderAccess(access, revealed, show);
    else if (!gate) this.log(chalk.dim('no login required.'));
    const hasSecret = access?.username?.secret || access?.password?.secret || gate?.secret;
    if (!show && hasSecret) this.log(chalk.dim('(run with --show to read secret values back from the host)'));
  }

  private renderGate(gate: Gate, revealed: Revealed, show: boolean): void {
    this.log(chalk.magenta('ingress gate') + chalk.dim(' (browser login before the app is reached):'));
    this.log(chalk.dim('  user: ') + gate.user);
    this.log(chalk.dim('  pass: ') + gatePassText(gate, revealed, show));
  }

  private renderAccess(access: AppAccessView, revealed: Revealed, show: boolean): void {
    if (access.mode === 'none') {
      this.log(chalk.dim('no app login required.'));
      return;
    }
    if (access.mode === 'firstVisit') {
      this.log(chalk.yellow(`! ${access.note ?? FIRST_VISIT}`));
      return;
    }
    this.log(chalk.dim('app login:'));
    if (access.username) this.log(chalk.dim('  user: ') + partText(access.username, revealed, show));
    if (access.password) this.log(chalk.dim('  pass: ') + partText(access.password, revealed, show));
    if (access.note) this.log(chalk.dim(`  note: ${access.note}`));
  }
}

const FIRST_VISIT = 'The first visitor to this URL becomes the admin — open it now to claim the account.';

function gatePassText(gate: Gate, revealed: Revealed, show: boolean): string {
  if (show && revealed[gate.secret] != null) return revealed[gate.secret];
  return chalk.dim('•••••••• (run --show to reveal)');
}

function partText(part: AppAccessPart, revealed: Revealed, show: boolean): string {
  if (part.kind === 'value') return part.value ?? '';
  if (show && part.secret && revealed[part.secret] != null) return revealed[part.secret];
  return chalk.dim(part.kind === 'generated' ? '•••••••• (generated)' : '•••••••• (set at install)');
}

function toJson(cred: AppCredentialsView, revealed: Revealed, show: boolean) {
  const { app, host, access, gate } = cred;
  const part = (p?: AppAccessPart) => {
    if (!p) return undefined;
    if (p.kind === 'value') return p.value ?? '';
    return show && p.secret ? revealed[p.secret] ?? null : null;
  };
  return {
    app,
    host,
    url: access?.url ?? gate?.url,
    gate: gate ? { user: gate.user, password: show ? revealed[gate.secret] ?? null : null } : undefined,
    access: access ? { mode: access.mode, username: part(access.username), password: part(access.password), note: access.note } : undefined,
  };
}
