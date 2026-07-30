import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { yesNo } from '../../lib/output';
import { VopsProvidersService } from '../../providers/vops-providers.service';

export default class ProvidersCapabilities extends Command {
  static readonly description =
    'Show a provider capabilities and billing model (static, no credentials)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner',
    '<%= config.bin %> <%= command.id %> scaleway --json',
  ];

  static readonly args = {
    provider: Args.string({
      description: 'Provider name (hetzner, scaleway)',
      required: true,
    }),
  };

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersCapabilities);
    await runAgentCommand(
      this,
      'vops providers capabilities',
      flags.json,
      async () => ({ data: await withService(VopsProvidersService, (svc) => svc.capabilities(args.provider)) }),
      (caps) => {
        const row = (k: string, v: string) => this.log(`  ${chalk.dim(k.padEnd(18))} ${v}`);
        this.log(chalk.bold(`\n${caps.displayName}`));
        row('Billing', caps.billingModel);
        row('Create (write)', yesNo(caps.writeEnabled));
        row('Credential type', caps.credentialType);
        row('Currency', caps.currency);
        row('Firewall', `${yesNo(caps.features.firewall)} (${caps.firewallBackend})`);
        row('DNS', yesNo(caps.features.dns));
        row('Private network', yesNo(caps.features.privateNetwork));
        row('Snapshots', yesNo(caps.features.snapshots));
        if (!caps.writeEnabled) this.log(chalk.dim(`\n${caps.writeDisabledReason}`));
      },
    );
  }
}
