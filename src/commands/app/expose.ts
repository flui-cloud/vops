import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { approvalRequired } from '../../safety/approval-gate';
import { DeployResult, VopsAppsService } from '../../apps/vops-apps.service';
import { authFromFlags, exposeWarnings, ingressDeployFlags, installHostFlag } from '../../apps/deploy-flags';

export default class AppExpose extends Command {
  static readonly description =
    'Front an already-deployed catalog app with a domain + TLS via the vops ingress. Recreates the ' +
    'container bound to loopback and routes it through Traefik (ensures ingress is up). Without ' +
    '--domain it reuses the hostname an already-exposed app carries.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> tools --domain tools.example.com --yes',
    '<%= config.bin %> <%= command.id %> tools --yes',
    '<%= config.bin %> <%= command.id %> tools --domain auto --yes',
  ];

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    ...ingressDeployFlags,
    ...installHostFlag,
    yes: Flags.boolean({ default: false, description: 'Actually expose (recreates the container on a loopback bind)' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppExpose);
    await runAgentCommand(
      this,
      'vops app expose',
      flags.json,
      async () => {
        if (!flags.yes) {
          throw approvalRequired({
            operation: 'Expose app',
            target: args.name,
            approved: false,
            consequence: 'It recreates the container on a loopback bind and publishes it through the ingress.',
          });
        }
        const data = (await withService(VopsAppsService, (svc) =>
          svc.expose(args.name, {
            domain: flags.domain,
            email: flags.email,
            tls: flags.tls,
            staging: flags.staging,
            exposeDirect: flags['expose-direct'],
            forceDns: flags['force-dns'],
            auth: authFromFlags(flags),
          }, flags.host),
        )) as DeployResult;
        return {
          data,
          warnings: exposeWarnings(data),
          nextActions: [{ command: `vops app status ${data.app} --host ${data.host} --json`, description: 'Confirm the app is still up behind the ingress' }],
        };
      },
      (res) => this.render(res),
    );
  }

  private render(res: DeployResult): void {
    const url = res.ingress ? ingressScheme(res.ingress.tls) + res.ingress.hostname : res.endpoints[0]?.url;
    this.log(chalk.green(`✓ exposed ${chalk.bold(res.app)}`) + chalk.dim(`  ${url}`));
    if (res.ingress) this.log(chalk.dim(`  ${res.ingress.note}`));
    for (const w of [...(res.ingress?.warnings ?? []), ...(res.warnings ?? [])]) this.log(chalk.yellow(`  ! ${w}`));
    if (res.gate) this.log(chalk.magenta('  ingress gate:') + chalk.dim(' basic-auth, user ') + chalk.cyan(res.gate.user) + (res.gate.generated ? chalk.dim(`  (pass: vops app credentials ${res.app} --show)`) : ''));
  }
}

function ingressScheme(tls: boolean): string {
  return tls ? 'https://' : 'http://';
}
