import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { DeviceRegistry } from '../../remote/device-registry';
import { RemoteDeviceRole } from '../../remote/remote-model';

export default class RemoteDeviceCommand extends Command {
  static readonly description = 'Show, suspend, resume, revoke, or change a paired device role.';
  static readonly args = {
    action: Args.string({
      required: true,
      options: ['show', 'suspend', 'resume', 'revoke', 'role'],
    }),
    id: Args.string({ required: true }),
  };
  static readonly flags = {
    role: Flags.string({ options: ['viewer', 'approver', 'admin'] }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RemoteDeviceCommand);
    const result = await withService(DeviceRegistry, async (registry) => {
      if (args.action === 'show') return registry.get(args.id);
      if (args.action === 'suspend') return registry.suspend(args.id);
      if (args.action === 'resume') return registry.resume(args.id);
      if (args.action === 'revoke') return registry.revoke(args.id);
      if (!flags.role) throw new Error('role requires --role viewer|approver|admin');
      return registry.setRole(args.id, flags.role as RemoteDeviceRole);
    });
    this.log(JSON.stringify(result, null, 2));
  }
}
