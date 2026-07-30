import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupSetup extends Command {
  static readonly description = 'Set up restic backups over SSH (verified binary + cron, no daemon)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1 --paths /etc,/var/www --to s3:https://s3.example.com/bucket',
    '<%= config.bin %> <%= command.id %> web1 --paths /data --to s3:... --schedule "0 3 * * *" --keep 7d4w6m --dry-run',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    paths: Flags.string({ description: 'Comma-separated paths to back up', required: true }),
    to: Flags.string({ description: 'S3-compatible repository URL (restic form)', required: true }),
    schedule: Flags.string({ description: 'Cron schedule', default: '0 3 * * *' }),
    keep: Flags.string({ description: 'Retention policy, e.g. 7d4w6m', default: '7d4w6m' }),
    's3-access-key': Flags.string({ description: 'S3 access key id' }),
    's3-secret-key': Flags.string({ description: 'S3 secret access key' }),
    'dry-run': Flags.boolean({ description: 'Print files/commands, apply nothing', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupSetup);
    await runAgentCommand(
      this,
      'vops backup setup',
      flags.json,
      async () => ({
        data: await withService(VopsBackupService, (svc) =>
          svc.setup(args.name, {
            paths: flags.paths.split(',').map((p) => p.trim()).filter(Boolean),
            to: flags.to,
            schedule: flags.schedule,
            keep: flags.keep,
            s3AccessKey: flags['s3-access-key'],
            s3SecretKey: flags['s3-secret-key'],
            dryRun: flags['dry-run'],
          }),
        ),
      }),
      (res) => {
        if (res.dryRun === true) {
          for (const [p, body] of Object.entries(res.files)) {
            this.log(chalk.cyan(`[dry-run] ${p}`));
            this.log(chalk.dim(body.split('\n').map((l) => '  ' + l).join('\n')));
          }
          this.log(chalk.cyan('[dry-run] crontab: ') + res.cron.join(' '));
          return;
        }
        this.log(chalk.green(`✓ Backups configured on '${res.host}' → ${res.repository}`));
        this.log(chalk.yellow('  ⚠ Save this repository password (also stored in your vops profile):'));
        this.log('    ' + chalk.bold(String(res.password)));
        this.log(chalk.dim(`  sanity dry-run: ${res.sanityOk ? 'ok' : 'check credentials'}`));
      },
    );
  }
}
