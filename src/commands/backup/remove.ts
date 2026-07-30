import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
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
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupRemove);
    await runAgentCommand(
      this,
      'vops backup remove',
      flags.json,
      async () => ({
        data: await withService(VopsBackupService, (svc) => svc.remove(args.name, { purgeRepo: flags['purge-repo'] })),
      }),
      (res) => this.log(chalk.green(`✓ Backup removed from '${res.host}'` + (res.repoPurged ? ' (repo purged)' : ' (repo kept)'))),
    );
  }
}
