import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupRestore extends Command {
  static readonly description = 'Restore a snapshot into a target directory (never overwrites in place)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1 --snapshot latest --target /restore',
  ];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };

  static readonly flags = {
    snapshot: Flags.string({ description: 'Snapshot id (or "latest")', default: 'latest' }),
    target: Flags.string({ description: 'Remote directory to restore into', required: true }),
    'dry-run': Flags.boolean({ description: 'Print the restore command, apply nothing', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupRestore);
    try {
      const res = await (await getVopsApp()).get(VopsBackupService).restore(args.name, {
        snapshot: flags.snapshot,
        target: flags.target,
        dryRun: flags['dry-run'],
      });
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.dryRun === true) {
        this.log(chalk.cyan('[dry-run] ') + res.command);
        return;
      }
      if (res.restored) this.log(chalk.green(`✓ Restored into ${res.target} on '${res.host}'`));
      else this.error(`Restore failed: ${res.stderr ?? 'unknown'}`, { exit: 1 });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
