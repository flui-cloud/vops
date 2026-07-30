import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { PlanCreated, VopsAgentApiService } from '../../agent-api/vops-agent-api.service';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { carried, flagArg } from '../../agent-api/follow-up';
import { ingressAuthFlag, parseSet } from '../../apps/deploy-flags';

export default class DeployPlan extends Command {
  static readonly description =
    'Render an immutable deployment plan and write it to .vops/plans/<id>.json. Changes nothing. ' +
    'Summarise it for the user, then apply that exact id — the plan is re-derived at apply time and refuses to run if anything changed.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --spec flui.yaml --host web1 --image ghcr.io/me/app:abc1234 --json',
    '<%= config.bin %> <%= command.id %> --spec flui.yaml --host web1 --domain app.example.com --auth basic',
  ];

  static readonly flags = {
    spec: Flags.string({ default: 'flui.yaml', description: 'Manifest to deploy' }),
    host: Flags.string({ required: true, description: 'Target inventory host' }),
    image: Flags.string({ description: 'Image for a kind: Application manifest (from `vops build run`)' }),
    name: Flags.string({ description: 'Install name (defaults to metadata.name)' }),
    project: Flags.string({ default: '.', description: 'Project root (where .vops lives)' }),
    set: Flags.string({ multiple: true, description: 'Supply a declared env/secret value: KEY=value' }),
    domain: Flags.string({ description: 'Front the app with this hostname ("auto" for an sslip.io demo host)' }),
    tls: Flags.boolean({ default: true, allowNo: true, description: 'Request a certificate for --domain' }),
    staging: Flags.boolean({ default: false, description: "Use Let's Encrypt staging (untrusted by browsers — for testing)" }),
    ...ingressAuthFlag,
    public: Flags.boolean({ allowNo: true, description: 'Bind published ports on 0.0.0.0 (default: loopback only)' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DeployPlan);
    try {
      const svc = (await getVopsApp()).get(VopsAgentApiService);
      await runAgentCommand(
        this,
        'vops deploy plan',
        flags.json,
        async () => {
          const data = await svc.plan({
            projectDir: flags.project,
            spec: flags.spec,
            host: flags.host,
            image: flags.image,
            name: flags.name,
            set: parseSet(flags.set),
            domain: flags.domain,
            tls: flags.tls,
            staging: flags.staging,
            auth: flags.auth,
            public: flags.public,
          });
          return {
            data,
            requiresApproval: true,
            warnings: (data.plan.warnings ?? []).map((message) => ({ code: 'VOPS_PLAN_ADVISORY', message })),
            nextActions: [
              { command: `vops deploy apply --plan ${data.id}${carried(flagArg('project', flags.project, '.'))} --yes --json`, description: 'Apply this exact plan, after the user approves it' },
            ],
          };
        },
        (data) => render(this, data),
      );
    } finally {
      await closeVopsApp();
    }
  }
}

function tlsLabel(ingress: { tls: boolean; staging: boolean }): string {
  if (!ingress.tls) return 'plain HTTP';
  return ingress.staging ? 'TLS (staging)' : 'TLS';
}

function render(cmd: Command, p: PlanCreated): void {
  const v = p.plan;
  cmd.log(chalk.bold(`plan ${p.id}`) + chalk.dim(`  ${v.app} → ${v.host} · ${v.kind}${v.coexistence ? ' · k3s coexistence' : ''}`));
  cmd.log(chalk.dim(`  ${p.file}`));
  for (const c of Object.keys(v.files)) cmd.log(chalk.dim(`  unit: ${c}`));
  if (v.secrets.length) cmd.log(chalk.dim(`  secrets: ${v.secrets.join(', ')}`));
  for (const e of v.endpoints) {
    const reach = chalk.dim(`(${e.reach ?? 'public'})`);
    cmd.log(`  endpoint: ${chalk.cyan(e.url)} ${reach}`);
  }
  if (v.ingress) {
    cmd.log(chalk.magenta(`  ingress: ${v.ingress.hostname}`) + chalk.dim(` · ${tlsLabel(v.ingress)}`));
    for (const w of v.ingress.warnings) cmd.log(chalk.yellow(`  ! ${w}`));
  }
  if (v.gate) cmd.log(chalk.magenta('  gate: ') + chalk.dim(`basic-auth, user ${v.gate.user}`));
  for (const w of v.warnings ?? []) cmd.log(chalk.yellow(`  ! ${w}`));
  cmd.log(chalk.dim('\n  nothing was changed. review it with the user, then:'));
  cmd.log(chalk.cyan(`  vops deploy apply --plan ${p.id} --yes`));
}
