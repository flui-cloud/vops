import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsServerFirewallService, ServerFirewallView } from '../../firewall/vops-server-firewall.service';
import { FirewallService, parseServiceSpec, servicesToRules } from '../../firewall/firewall-services';

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
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostFirewall);
    try {
      const app = await getVopsApp();
      const fw = app.get(VopsServerFirewallService);

      if (flags.allow != null && flags['dry-run']) {
        const rules = servicesToRules(this.parseServices(flags.allow));
        this.log(flags.json ? JSON.stringify(rules, null, 2) : chalk.cyan('[dry-run] compiled rules\n') + JSON.stringify(rules, null, 2));
        return;
      }

      const view = await this.act(fw, args.name, flags);
      if (flags.json) {
        this.log(JSON.stringify(view, null, 2));
        return;
      }
      this.render(view);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }

  private async act(
    fw: VopsServerFirewallService,
    name: string,
    flags: { allow?: string; clear: boolean; yes: boolean },
  ): Promise<ServerFirewallView> {
    if (flags.clear) {
      if (!flags.yes) throw new Error('Refusing to clear the firewall without confirmation. Re-run with --yes.');
      await fw.clear(name);
      this.log(chalk.dim(`Firewall cleared from ${name}.`));
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
    if (view.cededToFlui) {
      this.log(chalk.yellow('⚠ flui manages this host firewall — vops management is disabled here (see below).'));
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
    const src = d.source === 'flui' ? 'flui firewall' : 'other host firewall';
    const title = chalk.bold(`Detected — ${src}`);
    this.log('');
    this.log(`${title} ${chalk.dim('(not managed by vops)')}  ${state}${d.persistent ? chalk.dim(' · persistent') : ''}`);
    if (d.source === 'other') {
      this.log(chalk.dim("Inbound is filtered by rules vops doesn't manage. Rule detail is only shown for flui firewalls."));
      return;
    }
    if (d.rulesetPath) this.log(chalk.dim(`Source: ${d.rulesetPath} (read-only)`));
    if (!d.services.length) {
      this.log(chalk.dim("No public ingress rules — only flui's base rules (SSH, ICMP, cluster) apply."));
      return;
    }
    this.log(renderTable(['SERVICE', 'PROTO/PORT', 'FROM'], this.serviceRows(d.services)));
  }

  private serviceRows(services: FirewallService[]): string[][] {
    return services.map((s) => [s.label, `${s.protocol}/${s.port}`, s.sources.length ? s.sources.join(', ') : 'anywhere']);
  }
}
