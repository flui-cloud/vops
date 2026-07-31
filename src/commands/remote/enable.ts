import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { RelayClient } from '../../remote/relay-client';

export default class RemoteEnable extends Command {
  static readonly description =
    'Enable the outbound-only remote transport with a dedicated relay credential.';
  static readonly flags = {
    relay: Flags.string({
      description: 'Relay API base URL (HTTPS, or loopback HTTP for development)',
      env: 'VOPS_REMOTE_RELAY',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RemoteEnable);
    const status = await withService(RelayClient, (relay) => relay.enable(flags.relay));
    this.log(`${chalk.green('✓')} Remote transport ${status.state}`);
    this.log(chalk.dim(`  node ${status.nodeId}`));
    this.log(chalk.dim(`  relay ${status.relayUrl}`));
    this.log(chalk.dim('  The relay credential routes ciphertext only; it cannot authorize an operation.'));
  }
}
