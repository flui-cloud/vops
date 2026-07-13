import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupRemove extends Command {
  static readonly description = 'Remove restic binary + env + backup.sh + cron (repo untouched unless --purge-repo)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --purge-repo',
  ];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };

  static readonly flags = {
    'purge-repo': Flags.boolean({ description: 'Also delete all snapshots in the repo (destructive)', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupRemove);
    try {
      const res = await (await getVopsApp()).get(VopsBackupService).remove(args.name, { purgeRepo: flags['purge-repo'] });
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      this.log(chalk.green(`✓ Backup removed from '${res.host}'` + (res.repoPurged ? ' (repo purged)' : ' (repo kept)')));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
