import { Command } from '@oclif/core';
import * as QRCode from 'qrcode';
import { withService } from '../../agent-api/agent-nest';
import { PairingService } from '../../remote/pairing.service';

export default class RemotePair extends Command {
  static readonly description =
    'Create a ten-minute, single-use device pairing QR. Local confirmation is still required.';

  async run(): Promise<void> {
    const result = await withService(PairingService, (pairing) => pairing.create());
    this.log(await QRCode.toString(result.activationUrl, { type: 'terminal', small: true }));
    this.log(result.activationUrl);
    this.log(`pairing: ${result.pairing.id}`);
    this.log('Keep the local vOps app running, inspect with `vops remote pairings`, then confirm locally.');
  }
}
