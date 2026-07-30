import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { approvalRequired } from '../../safety/approval-gate';
import { renderTable } from '../../lib/output';
import { VopsServerFirewallService, ServerFirewallView, DetectedFirewallView } from '../../firewall/vops-server-firewall.service';
import { FirewallService, parseServiceSpec, servicesToRules } from '../../firewall/firewall-services';
import { VopsFirewallRule } from '../../dto/firewall.dto';

type FirewallOutput = VopsFirewallRule[] | ServerFirewallView;

function detectedLabel(d: DetectedFirewallView): string {
  if (d.source === 'flui') return 'flui firewall';
  if (d.source === 'provider') return d.name ? `provider firewall · ${d.name}` : 'provider firewall';
  return 'other host firewall';
}

export default class HostFirewall extends Command {
  static readonly description =
    'Show or set a server firewall (unified: provider-native where available, else vops nftables). ' +
    'SSH is always kept open in the nftables engine.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --allow ssh,http,https',
    '<%= config.bin %> <%= command.id %> web1 --allow "https,8080/tcp,51820/udp@203.0.113.0/24"',
    '<%= config.bin %> <%= command.id %> web1 --allow https --dry-run',
    '<%= config.bin %> <%= command.id %> web1 --clear',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    allow: Flags.string({ description: 'Comma list of allowed services (ssh,http,https,<port>[/proto][@cidr])' }),
    clear: Flags.boolean({ description: 'Remove the vops firewall from this host', default: false }),
    yes: Flags.boolean({ description: 'Confirm a destructive action (required with --clear)', default: false }),
    'dry-run': Flags.boolean({ description: 'With --allow, print the compiled rules; change nothing', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostFirewall);
    await runAgentCommand<FirewallOutput>(
      this,
      'vops host firewall',
      flags.json,
      async () => {
        if (flags.allow != null && flags['dry-run']) {
          return { data: servicesToRules(this.parseServices(flags.allow)) };
        }
        return { data: await withService(VopsServerFirewallService, (fw) => this.act(fw, args.name, flags)) };
      },
      (data) => {
        if (Array.isArray(data)) {
          this.log(chalk.cyan('[dry-run] compiled rules\n') + JSON.stringify(data, null, 2));
          return;
        }
        if (flags.clear) this.log(chalk.dim(`Firewall cleared from ${args.name}.`));
        this.render(data);
      },
    );
  }

  private async act(
    fw: VopsServerFirewallService,
    name: string,
    flags: { allow?: string; clear: boolean; yes: boolean },
  ): Promise<ServerFirewallView> {
    if (flags.clear) {
      if (!flags.yes) {
        throw approvalRequired({
          operation: 'Clear firewall',
          target: name,
          approved: false,
          consequence: 'The host is left with no vops-managed ruleset.',
        });
      }
      await fw.clear(name);
      return fw.get(name);
    }
    if (flags.allow != null) return fw.set(name, this.parseServices(flags.allow));
    return fw.get(name);
  }

  private parseServices(allow: string): ReturnType<typeof parseServiceSpec>[] {
    return allow.split(',').map((t) => t.trim()).filter(Boolean).map(parseServiceSpec);
  }

  private render(view: ServerFirewallView): void {
    this.renderManaged(view);
    this.renderDetected(view);
  }

  private renderManaged(view: ServerFirewallView): void {
    const engine = view.engine === 'none' ? chalk.dim('none') : chalk.cyan(view.engine);
    this.log(`${chalk.bold(view.host)}  engine: ${engine}  ${view.active ? chalk.green('active') : chalk.dim('inactive')}`);
    if (view.cededTo) {
      const owner = view.cededTo === 'provider'
        ? `'${view.detected?.name ?? 'a provider firewall'}' guards this server at the provider`
        : 'flui manages this host firewall';
      this.log(chalk.yellow(`⚠ ${owner} — vops management is disabled here (see below).`));
      return;
    }
    if (view.active && !view.persistent) this.log(chalk.yellow("⚠ won't survive a reboot — no boot-time unit installed (non-systemd host?)."));
    if (view.engine === 'nftables') this.log(chalk.dim('SSH is always kept open (cannot be locked out).'));
    if (view.engine === 'none') {
      this.log(chalk.dim('No firewall engine: no native firewall and no SSH management to run nftables.'));
      return;
    }
    if (!view.services.length) {
      this.log(chalk.dim('No rules set — nothing is explicitly allowed yet.'));
      return;
    }
    this.log(renderTable(['SERVICE', 'PROTO/PORT', 'FROM'], this.serviceRows(view.services)));
  }

  private renderDetected(view: ServerFirewallView): void {
    const d = view.detected;
    if (!d) return;
    const state = d.active ? chalk.green('active') : chalk.dim('configured, not active');
    const title = chalk.bold(`Detected — ${detectedLabel(d)}`);
    this.log('');
    this.log(`${title} ${chalk.dim('(not managed by vops)')}  ${state}${d.persistent ? chalk.dim(' · persistent') : ''}`);
    if (d.source === 'other') {
      this.log(chalk.dim("Inbound is filtered by rules vops doesn't manage, and this firewall exposes no readable rules."));
      return;
    }
    if (d.rulesetPath) this.log(chalk.dim(`Source: ${d.rulesetPath} (read-only)`));
    if (!d.services.length) {
      const empty = d.source === 'flui'
        ? "No public ingress rules — only flui's base rules (SSH, ICMP, cluster) apply."
        : 'No inbound service rules — nothing is explicitly allowed.';
      this.log(chalk.dim(empty));
      return;
    }
    this.log(renderTable(['SERVICE', 'PROTO/PORT', 'FROM'], this.serviceRows(d.services)));
  }

  private serviceRows(services: FirewallService[]): string[][] {
    return services.map((s) => [s.label, `${s.protocol}/${s.port}`, s.sources.length ? s.sources.join(', ') : 'anywhere']);
  }
}
