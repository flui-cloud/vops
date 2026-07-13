import { Command, Flags } from '@oclif/core';
import { renderNftables, HostFirewallOptions } from '../../host-firewall/nftables';
import { VopsFirewallRule } from '../../dto/firewall.dto';

export default class HostFirewallRender extends Command {
  static readonly description =
    'Render a host-level nftables ruleset from portable rules. Intended for providers ' +
    'WITHOUT a native firewall (Contabo, OVH) — where one exists (Hetzner, Scaleway), ' +
    'prefer the provider firewall (`vops firewall`)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --rules \'[{"description":"web","direction":"in","protocol":"tcp","port":"80,443"}]\'',
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
    const { flags } = await this.parse(HostFirewallRender);
    try {
      this.log(renderNftables(parseRules(flags.rules), optsFrom(flags)));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
  }
}

export function parseRules(raw?: string): VopsFirewallRule[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('--rules must be a JSON array.');
  return parsed as VopsFirewallRule[];
}

export function optsFrom(flags: {
  policy: string;
  ssh: boolean;
  ping: boolean;
  outbound: boolean;
}): HostFirewallOptions {
  return {
    defaultInboundPolicy: flags.policy === 'accept' ? 'accept' : 'drop',
    keepSshOpen: flags.ssh,
    allowPing: flags.ping,
    allowOutbound: flags.outbound,
  };
}
