import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
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

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersCapabilities);
    try {
      const app = await getVopsApp();
      const caps = app.get(VopsProvidersService).capabilities(args.provider);

      if (flags.json) {
        this.log(JSON.stringify(caps, null, 2));
        return;
      }

      const row = (k: string, v: string) =>
        this.log(`  ${chalk.dim(k.padEnd(18))} ${v}`);
      this.log(chalk.bold(`\n${caps.displayName}`));
      row('Billing', caps.billingModel);
      row('Create (write)', yesNo(caps.writeEnabled));
      row('Credential type', caps.credentialType);
      row('Currency', caps.currency);
      row('Firewall', `${yesNo(caps.features.firewall)} (${caps.firewallBackend})`);
      row('DNS', yesNo(caps.features.dns));
      row('Private network', yesNo(caps.features.privateNetwork));
      row('Snapshots', yesNo(caps.features.snapshots));
      if (!caps.writeEnabled) {
        this.log(chalk.dim(`\n${caps.writeDisabledReason}`));
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), {
        exit: 1,
      });
    } finally {
      await closeVopsApp();
    }
  }
}
