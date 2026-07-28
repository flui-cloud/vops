import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsBackupService } from '../../backup/vops-backup.service';

interface Snapshot {
  short_id?: string;
  time?: string;
  paths?: string[];
}

export default class BackupSnapshots extends Command {
  static readonly description = 'List restic snapshots for a host';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupSnapshots);
    await runAgentCommand(
      this,
      'vops backup snapshots',
      flags.json,
      async () => ({
        data: (await withService(VopsBackupService, (svc) => svc.snapshots(args.name))) as Snapshot[],
      }),
      (snaps) => {
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
      },
    );
  }
}
