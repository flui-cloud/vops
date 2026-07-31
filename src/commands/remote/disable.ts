import { Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { RelayClient } from '../../remote/relay-client';

export default class RemoteDisable extends Command {
  static readonly description = 'Disable the outbound remote transport without deleting local device authority.';

  async run(): Promise<void> {
    await withService(RelayClient, (relay) => relay.disable());
    this.log(`${chalk.green('✓')} Remote transport disabled`);
  }
}
