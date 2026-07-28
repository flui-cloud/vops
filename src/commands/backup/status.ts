import { Args, Command } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupStatus extends Command {
  static readonly description = 'Show backup status (snapshot count + repo stats), over SSH';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupStatus);
    await runAgentCommand(
      this,
      'vops backup status',
      flags.json,
      async () => {
        const res = await withService(VopsBackupService, (svc) => svc.status(args.name));
        return {
          data: res,
          warnings: res.snapshots
            ? []
            : [{ code: 'BACKUP_NO_SNAPSHOTS', message: `${res.host} has a repository but no snapshots yet`, path: res.host }],
        };
      },
      (res) => {
        this.log(`${res.host}: ${res.snapshots} snapshot(s)`);
        const stats = res.stats as { total_size?: number } | null;
        if (stats?.total_size) this.log(`  repo raw data: ${(stats.total_size / 1e6).toFixed(1)} MB`);
      },
    );
  }
}
