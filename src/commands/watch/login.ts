import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../lib/cloud-client';

export default class WatchLogin extends Command {
  static readonly description =
    'Connect to (or switch) the vops-landing API for watches/notifications. ' +
    'The endpoint is health-checked before it is saved; an unreachable URL is refused. ' +
    'Stores an opaque client token locally.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --api-url http://localhost:7799 --show',
    '<%= config.bin %> <%= command.id %> --token tok_… # reuse a token on another device',
  ];

  static readonly flags = {
    'api-url': Flags.string({ description: 'Hosted API base URL', env: 'VOPS_CLOUD_API' }),
    token: Flags.string({ description: 'Reuse an existing client token (sync a second device / the web dashboard)' }),
    show: Flags.boolean({ description: 'Reveal the token (you need it to reuse this identity elsewhere)', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WatchLogin);
    const client = new CloudClient();
    let cfg: { apiUrl: string; token: string };
    try {
      cfg = await client.setEndpoint(flags['api-url'], flags.token);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
    this.log(`${chalk.green('✓')} Connected to ${chalk.cyan(cfg.apiUrl)}`);
    if (flags.show || flags.token) {
      this.log(`  ${chalk.dim('token')} ${cfg.token}`);
      this.log(chalk.dim('  Keep it private — it is your identity for watches on this service.'));
    } else {
      this.log(chalk.dim('  A client token was generated and stored locally (AES-256-GCM).'));
      this.log(chalk.dim('  Re-run with --show to reveal it (needed to sync another device or the web dashboard).'));
    }
  }
}
