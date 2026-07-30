import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { agentError } from '../../agent-api/agent-envelope';
import { VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupRun extends Command {
  static readonly description = 'Trigger one backup now (over SSH)';

  static readonly examples = ['<%= config.bin %> <%= command.id %> web1'];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };
  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupRun);
    await runAgentCommand(
      this,
      'vops backup run',
      flags.json,
      async () => {
        const data = await withService(VopsBackupService, (svc) => svc.run(args.name));
        return {
          data,
          errors: data.ok
            ? []
            : [
                agentError('VOPS_OPERATION_FAILED', 'operational', `Backup failed on '${data.host}': ${data.stderr ?? 'unknown'}`, {
                  suggestedAction: 'Read data.stderr, then re-run once the repository and its credentials are reachable.',
                }),
              ],
        };
      },
      (res) => {
        if (res.ok) this.log(chalk.green(`✓ Backup ran on '${res.host}'`));
      },
    );
  }
}
