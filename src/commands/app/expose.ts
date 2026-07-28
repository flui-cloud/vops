import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { DeployResult, VopsAppsService } from '../../apps/vops-apps.service';
import { authFromFlags, ingressDeployFlags } from '../../apps/cli-deploy';

export default class AppExpose extends Command {
  static readonly description =
    'Front an already-deployed catalog app with a domain + TLS via the vops ingress. Recreates the ' +
    'container bound to loopback and routes it through Traefik (ensures ingress is up).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> tools --domain tools.example.com --yes',
    '<%= config.bin %> <%= command.id %> tools --domain auto --yes',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    ...ingressDeployFlags,
    yes: Flags.boolean({ default: false, description: 'Actually expose (recreates the container on a loopback bind)' }),
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppExpose);
    try {
      if (!flags.yes) this.error('Re-run with --yes to expose (this recreates the container with a loopback bind).', { exit: 1 });
      const svc = (await getVopsApp()).get(VopsAppsService);
      const res = (await svc.expose(args.name, {
        domain: flags.domain,
        email: flags.email,
        tls: flags.tls,
        staging: flags.staging,
        exposeDirect: flags['expose-direct'],
        forceDns: flags['force-dns'],
        auth: authFromFlags(flags),
      })) as DeployResult;
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      const url = res.ingress ? ingressScheme(res.ingress.tls) + res.ingress.hostname : res.endpoints[0]?.url;
      this.log(chalk.green(`✓ exposed ${chalk.bold(res.app)}`) + chalk.dim(`  ${url}`));
      if (res.ingress) this.log(chalk.dim(`  ${res.ingress.note}`));
      for (const w of res.ingress?.warnings ?? []) this.log(chalk.yellow(`  ! ${w}`));
      if (res.gate) this.log(chalk.magenta('  ingress gate:') + chalk.dim(` basic-auth, user `) + chalk.cyan(res.gate.user) + (res.gate.generated ? chalk.dim(`  (pass: vops app credentials ${res.app} --show)`) : ''));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}

function ingressScheme(tls: boolean): string {
  return tls ? 'https://' : 'http://';
}
