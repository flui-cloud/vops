import { Command } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { DeviceRegistry } from '../../remote/device-registry';

export default class RemoteDevices extends Command {
  static readonly description = 'List locally authoritative paired-device roles and state.';

  async run(): Promise<void> {
    const devices = await withService(DeviceRegistry, (registry) => registry.list());
    this.log(JSON.stringify(devices, null, 2));
  }
}
