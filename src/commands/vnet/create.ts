import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsVnetService } from '../../vnet/vops-vnet.service';

export default class VnetCreate extends Command {
  static readonly description =
    'Create a private network (--dry-run to preview, --yes to apply)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider hetzner --name core --ip-range 10.0.0.0/16 --dry-run',
    '<%= config.bin %> <%= command.id %> --provider hetzner --name core --ip-range 10.0.0.0/16 --zone eu-central --yes',
  ];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway', required: true }),
    name: Flags.string({ description: 'Network name', required: true }),
    'ip-range': Flags.string({ description: 'CIDR (RFC1918, min /24)', required: true }),
    zone: Flags.string({ description: 'Network zone for an initial subnet' }),
    'subnet-range': Flags.string({ description: 'CIDR of the initial subnet' }),
    'dry-run': Flags.boolean({ description: 'Preview without creating', default: false }),
    yes: Flags.boolean({ description: 'Confirm creation', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VnetCreate);
    const subnets =
      flags.zone && flags['subnet-range']
        ? [{ networkZone: flags.zone, ipRange: flags['subnet-range'] }]
        : undefined;
    await runAgentCommand(
      this,
      'vops vnet create',
      flags.json,
      async () => ({
        data: await withService(VopsVnetService, (svc) =>
          svc.create(
            { provider: flags.provider, name: flags.name, ipRange: flags['ip-range'], subnets },
            { dryRun: flags['dry-run'], yes: flags.yes },
          ),
        ),
      }),
      (outcome) => {
        if (outcome.dryRun) {
          this.log(chalk.yellow(`DRY RUN: would create network '${flags.name}' (${flags['ip-range']}) on ${flags.provider}. Nothing changed.`));
          return;
        }
        this.log(chalk.green(`✓ Network created: ${outcome.vnet?.id}`));
      },
    );
  }
}
