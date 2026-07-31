import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { PairingService } from '../../remote/pairing.service';
import { RemoteDeviceRole } from '../../remote/remote-model';

export default class RemoteConfirm extends Command {
  static readonly description =
    'Locally confirm a verified pairing request and assign its initial device role.';
  static readonly args = {
    id: Args.string({ required: true }),
  };
  static readonly flags = {
    label: Flags.string({ required: true }),
    role: Flags.string({
      required: true,
      options: ['viewer', 'approver', 'admin'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RemoteConfirm);
    const result = await withService(PairingService, (service) =>
      service.confirm(args.id, {
        label: flags.label,
        role: flags.role as RemoteDeviceRole,
      }),
    );
    this.log(JSON.stringify(result, null, 2));
  }
}
