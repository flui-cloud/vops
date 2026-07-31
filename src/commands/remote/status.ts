import { Command } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { RelayClient } from '../../remote/relay-client';

export default class RemoteStatus extends Command {
  static readonly description = 'Show outbound relay presence and transport diagnostics (never message content).';

  async run(): Promise<void> {
    const status = await withService(RelayClient, (relay) => relay.status());
    this.log(JSON.stringify(status, null, 2));
  }
}
