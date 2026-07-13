import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupSnapshots extends Command {
  static readonly description = 'List restic snapshots for a host';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { json: Flags.boolean({ description: 'Output as JSON', default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupSnapshots);
    try {
      const snaps = (await (await getVopsApp()).get(VopsBackupService).snapshots(args.name)) as Array<{
        short_id?: string;
        time?: string;
        paths?: string[];
      }>;
      if (flags.json) {
        this.log(JSON.stringify(snaps, null, 2));
        return;
      }
      if (!snaps.length) {
        this.log(chalk.dim('No snapshots yet.'));
        return;
      }
      this.log(
        renderTable(
          ['ID', 'TIME', 'PATHS'],
          snaps.map((s) => [s.short_id ?? '?', s.time ?? '?', (s.paths ?? []).join(', ')]),
        ),
      );
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
