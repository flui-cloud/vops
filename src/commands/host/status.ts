import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { INestApplicationContext } from '@nestjs/common';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { AgentWarning } from '../../agent-api/agent-envelope';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { severityBadge, renderTable } from '../../lib/output';
import { reportExitCode, worseOf, Severity } from '../../lib/report';
import { VopsHostStatusService, HostStatusResult } from '../../host-ops/vops-host-status.service';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

export default class HostStatus extends Command {
  static readonly description = 'SSH health check: one session, a battery of read-only probes';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> --tag prod --strict',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name (omit for all hosts)' }),
  };

  static readonly flags = {
    tag: Flags.string({ description: 'Restrict to hosts with this tag' }),
    strict: Flags.boolean({ description: 'Exit non-zero on warnings too (human output only)', default: false }),
    ...agentJsonFlag,
  };

  /** Human output exits non-zero on a `fail` finding (shell-gateable); `--json` never does —
   * to an agent a probe that found a sick host still succeeded, so severity travels as warnings instead. */
  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostStatus);
    let severityExit = 0;

    await runAgentCommand(
      this,
      'vops host status',
      flags.json,
      async () => {
        const rows = await this.collect(args.name, flags.tag);
        const worst = rows.reduce<Severity>((w, r) => worseOf(w, r.report.worst), 'ok');
        severityExit = reportExitCode(worst, flags.strict);
        return { data: { worst, hosts: rows }, warnings: findingWarnings(rows) };
      },
      ({ hosts }) => (args.name ? this.renderSingle(hosts[0]) : this.renderFleet(hosts)),
    );

    if (!flags.json && severityExit !== 0) this.exit(severityExit);
  }

  private async collect(name?: string, tag?: string): Promise<HostStatusResult[]> {
    try {
      const app = await getVopsApp();
      const svc = app.get(VopsHostStatusService);
      if (name) return [await svc.status(name)];
      if (tag) return svc.fleet(taggedHosts(app, tag));
      return svc.fleet();
    } finally {
      await closeVopsApp();
    }
  }

  private renderSingle(r: HostStatusResult): void {
    this.log(chalk.bold(r.host) + chalk.dim(`  ${r.latencyMs}ms`));
    for (const f of r.report.findings) {
      const val = f.value === undefined ? '' : chalk.dim(` (${f.value})`);
      this.log(`  ${severityBadge(f.severity)}  ${chalk.dim(f.id.padEnd(14))} ${f.summary}${val}`);
      if (f.detail) this.log(chalk.dim(`         ${f.detail}`));
    }
    this.log('');
    this.log(`worst: ${severityBadge(r.report.worst)}`);
  }

  private renderFleet(rows: HostStatusResult[]): void {
    if (!rows.length) {
      this.log('No hosts. Add one with: vops host add <name> --address <ip|fqdn>');
      return;
    }
    this.log(
      renderTable(
        ['HOST', 'WORST', 'TOP FINDING', 'LATENCY'],
        rows.map((r) => {
          const top = [...r.report.findings].sort((a, b) => rank(b.severity) - rank(a.severity))[0];
          return [
            r.host,
            severityBadge(r.report.worst),
            top && top.severity !== 'ok' ? top.summary : chalk.dim('all clear'),
            `${r.latencyMs}ms`,
          ];
        }),
      ),
    );
  }
}

function taggedHosts(app: INestApplicationContext, tag: string): string[] {
  const names = app
    .get(VopsHostsService)
    .list()
    .filter((h) => h.tags.includes(tag))
    .map((h) => h.name);
  if (!names.length) throw new Error(`No hosts with tag '${tag}'.`);
  return names;
}

/** Every non-ok finding, so an agent reading only the envelope still sees them. */
function findingWarnings(rows: HostStatusResult[]): AgentWarning[] {
  return rows.flatMap((r) =>
    r.report.findings
      .filter((f) => f.severity === 'warn' || f.severity === 'fail')
      .map((f) => ({ code: `HOST_${f.id.toUpperCase().replaceAll('.', '_')}`, message: `${r.host}: ${f.summary}`, path: r.host })),
  );
}

const rank = (s: Severity): number => ({ ok: 0, info: 1, warn: 2, fail: 3 })[s];
