import { Args, Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupStatus extends Command {
  static readonly description = 'Show backup status (snapshot count + repo stats), over SSH';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { json: Flags.boolean({ description: 'Output as JSON', default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupStatus);
    try {
      const res = await (await getVopsApp()).get(VopsBackupService).status(args.name);
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
      this.log(`${res.host}: ${res.snapshots} snapshot(s)`);
      const stats = res.stats as { total_size?: number } | null;
      if (stats?.total_size) this.log(`  repo raw data: ${(stats.total_size / 1e6).toFixed(1)} MB`);
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
