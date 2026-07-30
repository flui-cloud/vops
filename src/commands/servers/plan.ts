import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { money } from '../../lib/output';
import { writePlanFile } from '../../lib/plan-io';
import { VopsServersService } from '../../servers/vops-servers.service';
import { VopsFirewallRule } from '../../dto/firewall.dto';

function parseFwRules(raw: string): VopsFirewallRule[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('--host-firewall must be a JSON array.');
  return parsed as VopsFirewallRule[];
}

export default class ServersPlan extends Command {
  static readonly description =
    'Generate a safe server creation plan (vops.plan.v1) without creating anything';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider hetzner --plan cx23 --location fsn1',
  ];

  static readonly flags = {
    provider: Flags.string({ description: 'hetzner | scaleway | ovh | cherry', required: true }),
    plan: Flags.string({ description: 'Server type (e.g. cx23)', required: true }),
    location: Flags.string({ description: 'Location/region id', required: true }),
    image: Flags.string({ description: 'OS image (defaults to Ubuntu 24.04)' }),
    name: Flags.string({ description: 'Server name (auto-generated if omitted)' }),
    'ssh-key': Flags.string({ description: 'Existing provider SSH key id/name' }),
    'host-firewall': Flags.string({
      description:
        'Host-level nftables firewall as a JSON rules array, applied at boot via cloud-init. ' +
        'For providers WITHOUT a native firewall (Contabo, OVH); rejected on Hetzner/Scaleway — use their provider firewall instead',
    }),
    'fw-policy': Flags.string({
      description: 'Default inbound policy for --host-firewall',
      options: ['drop', 'accept'],
      default: 'drop',
    }),
    out: Flags.string({ description: 'Plan file output path', default: './vops-plan.json' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServersPlan);
    await runAgentCommand(
      this,
      'vops servers plan',
      flags.json,
      async () => {
        const hostFirewall = flags['host-firewall']
          ? {
              rules: parseFwRules(flags['host-firewall']),
              policy: flags['fw-policy'] === 'accept' ? ('accept' as const) : ('drop' as const),
            }
          : undefined;
        const plan = await withService(VopsServersService, (svc) =>
          svc.plan({
            provider: flags.provider,
            plan: flags.plan,
            location: flags.location,
            image: flags.image,
            name: flags.name,
            sshKey: flags['ssh-key'],
            hostFirewall,
          }),
        );
        writePlanFile(flags.out, plan);
        return { data: plan };
      },
      (plan) => this.renderPlan(plan, flags.out),
    );
  }

  private renderPlan(plan: Awaited<ReturnType<VopsServersService['plan']>>, out: string): void {
    const row = (k: string, v: string) => this.log(`  ${chalk.dim(k.padEnd(16))} ${v}`);
    this.log(chalk.bold(`\nPlan ${plan.name}`));
    row('Provider', plan.provider);
    row('Server type', plan.plan);
    row('Location', plan.location);
    row('Image', plan.image);
    row('SSH key', sshKeyLine(plan.sshKey));
    if (plan.hostFirewall) {
      row(
        'Host firewall',
        `nftables · ${plan.hostFirewall.rules.length} rule(s) · policy ${plan.hostFirewall.policy ?? 'drop'} (via cloud-init)`,
      );
    }
    row(
      'Est. cost',
      `${money(plan.estimatedCost.hourly)} ${plan.estimatedCost.currency}/h  ·  ${money(plan.estimatedCost.monthly, 2)}/mo`,
    );
    row('Create gate', plan.billingGate.allowed ? chalk.green('allowed') : chalk.red('blocked'));
    if (plan.billingGate.allowed) {
      this.log(chalk.dim(`\nWritten to ${out}. Create with: vops servers create --from-plan ${out} --yes`));
    } else {
      this.log(chalk.red(`\n${plan.billingGate.reason}`));
    }
  }
}

/** The plan says what it verified, so an unverified key never reads as a confirmed one. */
function sshKeyLine(k: { mode: string; id: string | null }): string {
  if (k.mode === 'none') return chalk.dim('none (no key will be authorized on the server)');
  if (k.mode === 'existing') return `${k.id} ${chalk.green('(registered at the provider)')}`;
  return `${k.id} ${chalk.yellow('(NOT verified — vops could not ask the provider)')}`;
}
