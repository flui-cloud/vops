import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsHostUpdateService, HostUpdateResult } from '../../host-ops/vops-host-update.service';
import { VopsHostStatusService } from '../../host-ops/vops-host-status.service';
import { VopsHostsService } from '../../hosts/vops-hosts.service';

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
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostUpdate);
    try {
      const app = await getVopsApp();
      const names = this.resolveNames(app, args.name, flags.tag);
      if (flags.list) {
        await this.listPending(app, names, flags.json);
        return;
      }
      const results = await app.get(VopsHostUpdateService).update(names, {
        securityOnly: flags['security-only'],
        reboot: flags.reboot,
        dryRun: flags['dry-run'],
      });
      if (flags.json) {
        this.log(JSON.stringify(results, null, 2));
        return;
      }
      if (flags['dry-run']) {
        for (const r of results) this.log(chalk.cyan(`[dry-run] ${r.host}\n`) + chalk.dim(r.detail));
        return;
      }
      this.log(
        renderTable(
          ['HOST', 'RESULT', 'REBOOT'],
          results.map((r) => [
            r.host,
            r.applied ? chalk.green(r.summary) : chalk.red(r.summary),
            this.rebootCell(r),
          ]),
        ),
      );
      if (results.some((r) => !r.applied)) this.exit(1);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }

  private rebootCell(r: HostUpdateResult): string {
    if (!r.rebootRequired) return chalk.dim('no');
    return r.rebooted ? chalk.green('rebooted') : chalk.yellow('required');
  }

  private async listPending(
    app: Awaited<ReturnType<typeof getVopsApp>>,
    names: string[],
    json: boolean,
  ): Promise<void> {
    const svc = app.get(VopsHostStatusService);
    const results = await Promise.all(names.map((n) => svc.pendingUpdates(n)));
    if (json) {
      this.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
      return;
    }
    for (const r of results) {
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

  private resolveNames(app: Awaited<ReturnType<typeof getVopsApp>>, name?: string, tag?: string): string[] {
    if (name) return [name];
    if (tag) {
      const names = app.get(VopsHostsService).list().filter((h) => h.tags.includes(tag)).map((h) => h.name);
      if (!names.length) throw new Error(`No hosts with tag '${tag}'.`);
      return names;
    }
    throw new Error('Specify a host name or --tag.');
  }
}
