import { Command, Flags } from '@oclif/core';
import { renderCloudInit } from '../../host-firewall/nftables';
import { parseRules, optsFrom } from './render';

export default class HostFirewallCloudInit extends Command {
  static readonly description =
    'Render a #cloud-config that applies a host-level nftables firewall at first boot. ' +
    'Intended for providers WITHOUT a native firewall (Contabo, OVH)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --rules \'[{"description":"web","direction":"in","protocol":"tcp","port":"443"}]\'',
  ];

  static readonly flags = {
    rules: Flags.string({ description: 'Inbound rules as a JSON array', required: true }),
    policy: Flags.string({
      description: 'Default inbound policy',
      options: ['drop', 'accept'],
      default: 'drop',
    }),
    ssh: Flags.boolean({
      description: 'Keep SSH (22) open to avoid lock-out',
      default: true,
      allowNo: true,
    }),
    ping: Flags.boolean({ description: 'Allow inbound ICMP', default: true, allowNo: true }),
    outbound: Flags.boolean({ description: 'Allow all outbound', default: true, allowNo: true }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(HostFirewallCloudInit);
    try {
      this.log(renderCloudInit(parseRules(flags.rules), optsFrom(flags)));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
  }
}
