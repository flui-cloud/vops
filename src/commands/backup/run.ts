import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupRun extends Command {
  static readonly description = 'Trigger one backup now (over SSH)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { json: Flags.boolean({ description: 'Output as JSON', default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupRun);
    try {
      const res = await (await getVopsApp()).get(VopsBackupService).run(args.name);
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.ok) this.log(chalk.green(`✓ Backup ran on '${res.host}'`));
      else this.error(`Backup failed on '${res.host}': ${res.stderr ?? 'unknown'}`, { exit: 1 });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
