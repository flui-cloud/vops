import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { INestApplicationContext } from '@nestjs/common';
import { withApp } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { agentError } from '../../agent-api/agent-envelope';
import { renderTable } from '../../lib/output';
import { VopsHostUpdateService, HostUpdateResult } from '../../host-ops/vops-host-update.service';
import { VopsHostStatusService } from '../../host-ops/vops-host-status.service';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

type PendingUpdates = Awaited<ReturnType<VopsHostStatusService['pendingUpdates']>>;
type UpdateView = HostUpdateResult[] | PendingUpdates | PendingUpdates[];

export default class HostUpdate extends Command {
  static readonly description = 'Apply OS package updates over SSH (sequential across a fleet)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --list',
    '<%= config.bin %> <%= command.id %> --tag prod --security-only',
    '<%= config.bin %> <%= command.id %> web1 --reboot',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name (or use --tag)' }),
  };

  static readonly flags = {
    tag: Flags.string({ description: 'Update all hosts with this tag' }),
    list: Flags.boolean({ description: 'List pending packages (read-only, applies nothing)', default: false }),
    'security-only': Flags.boolean({ description: 'Security updates only', default: false }),
    reboot: Flags.boolean({ description: 'Reboot if required, then wait for SSH', default: false }),
    'dry-run': Flags.boolean({ description: 'Print the update command, apply nothing', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostUpdate);
    await runAgentCommand<UpdateView>(
      this,
      'vops host update',
      flags.json,
      async () =>
        withApp(async (app) => {
          const names = this.resolveNames(app, args.name, flags.tag);
          if (flags.list) return { data: await this.pending(app, names) };

          const data = await app.get(VopsHostUpdateService).update(names, {
            securityOnly: flags['security-only'],
            reboot: flags.reboot,
            dryRun: flags['dry-run'],
          });
          const failed = data.filter((r) => !r.applied);
          return {
            data,
            errors: failed.length
              ? [
                  agentError('VOPS_OPERATION_FAILED', 'operational', `Updates failed on ${failed.map((r) => r.host).join(', ')}.`, {
                    suggestedAction: 'Read data[].summary for the host that failed, then re-run once its package manager is usable.',
                  }),
                ]
              : [],
          };
        }),
      (data) => {
        if (flags.list) this.renderPending(data as PendingUpdates | PendingUpdates[]);
        else this.renderUpdates(data as HostUpdateResult[], flags['dry-run']);
      },
    );
  }

  private renderUpdates(results: HostUpdateResult[], dryRun: boolean): void {
    if (dryRun) {
      for (const r of results) this.log(chalk.cyan(`[dry-run] ${r.host}\n`) + chalk.dim(r.detail));
      return;
    }
    this.log(
      renderTable(
        ['HOST', 'RESULT', 'REBOOT'],
        results.map((r) => [r.host, r.applied ? chalk.green(r.summary) : chalk.red(r.summary), this.rebootCell(r)]),
      ),
    );
  }

  private rebootCell(r: HostUpdateResult): string {
    if (!r.rebootRequired) return chalk.dim('no');
    return r.rebooted ? chalk.green('rebooted') : chalk.yellow('required');
  }

  private async pending(app: INestApplicationContext, names: string[]): Promise<PendingUpdates | PendingUpdates[]> {
    const svc = app.get(VopsHostStatusService);
    const results = await Promise.all(names.map((n) => svc.pendingUpdates(n)));
    return results.length === 1 ? results[0] : results;
  }

  private renderPending(data: PendingUpdates | PendingUpdates[]): void {
    for (const r of Array.isArray(data) ? data : [data]) {
      const security = r.packages.filter((p) => p.security).length;
      const more = r.truncated ? chalk.yellow(`  +${r.total - r.packages.length} more`) : '';
      this.log(chalk.bold(r.host) + '  ' + chalk.dim(`${r.total} pending (${security} security)`) + more);
      if (!r.packages.length) {
        this.log(chalk.dim('  up to date'));
        continue;
      }
      this.log(
        renderTable(
          ['SEC', 'PACKAGE', 'CURRENT → CANDIDATE'],
          r.packages.map((p) => [
            p.security ? chalk.red('●') : '',
            p.name,
            p.current ? `${p.current} → ${p.candidate ?? ''}` : (p.candidate ?? ''),
          ]),
        ),
      );
    }
  }

  private resolveNames(app: INestApplicationContext, name?: string, tag?: string): string[] {
    if (name) return [name];
    if (tag) {
      const names = app.get(VopsHostsService).list().filter((h) => h.tags.includes(tag)).map((h) => h.name);
      if (!names.length) throw new Error(`No hosts with tag '${tag}'.`);
      return names;
    }
    throw new Error('Specify a host name or --tag.');
  }
}
