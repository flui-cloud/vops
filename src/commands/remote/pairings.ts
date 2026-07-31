import { Command } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { PairingService } from '../../remote/pairing.service';

export default class RemotePairings extends Command {
  static readonly description =
    'List local pairing sessions awaiting confirmation, including expiry and verified device route.';

  async run(): Promise<void> {
    const pairings = await withService(PairingService, (service) => service.list());
    this.log(JSON.stringify(pairings, null, 2));
  }
}
