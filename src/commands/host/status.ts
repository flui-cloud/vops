import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
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
    strict: Flags.boolean({ description: 'Exit non-zero on warnings too', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostStatus);
    try {
      const app = await getVopsApp();
      const svc = app.get(VopsHostStatusService);
      const rows = await this.collect(app, svc, args.name, flags.tag);

      if (flags.json) {
        this.log(JSON.stringify(rows, null, 2));
      } else if (args.name) {
        this.renderSingle(rows[0]);
      } else {
        this.renderFleet(rows);
      }

      const worst = rows.reduce<Severity>((w, r) => worseOf(w, r.report.worst), 'ok');
      const code = reportExitCode(worst, flags.strict);
      if (code !== 0) this.exit(code);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }

  private async collect(
    app: Awaited<ReturnType<typeof getVopsApp>>,
    svc: VopsHostStatusService,
    name?: string,
    tag?: string,
  ): Promise<HostStatusResult[]> {
    if (name) return [await svc.status(name)];
    if (tag) {
      const names = app
        .get(VopsHostsService)
        .list()
        .filter((h) => h.tags.includes(tag))
        .map((h) => h.name);
      if (!names.length) throw new Error(`No hosts with tag '${tag}'.`);
      return svc.fleet(names);
    }
    return svc.fleet();
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

const rank = (s: Severity): number => ({ ok: 0, info: 1, warn: 2, fail: 3 })[s];
