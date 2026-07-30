import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { EnvelopeOptions, agentError } from '../../agent-api/agent-envelope';
import { approvalPending } from '../../safety/approval-gate';
import { RestoreTargetState } from '../../backup/backup-render';
import { BackupRestoreView, VopsBackupService } from '../../backup/vops-backup.service';

export default class BackupRestore extends Command {
  static readonly description = 'Restore a snapshot into a target directory (never overwrites in place; requires --yes)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1 --snapshot latest --target /restore',
    '<%= config.bin %> <%= command.id %> web1 --snapshot latest --target /restore --yes',
  ];

  static readonly args = { name: Args.string({ description: 'Host name', required: true }) };

  static readonly flags = {
    snapshot: Flags.string({ description: 'Snapshot id (or "latest")', default: 'latest' }),
    target: Flags.string({ description: 'Remote directory to restore into', required: true }),
    yes: Flags.boolean({ description: 'Confirm the restore (without it, vops prints the plan and stops)', default: false }),
    'dry-run': Flags.boolean({ description: 'Print the restore command, apply nothing', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupRestore);
    await runAgentCommand(
      this,
      'vops backup restore',
      flags.json,
      async (): Promise<{ data: BackupRestoreView } & EnvelopeOptions> => {
        const data = await withService(VopsBackupService, (svc) =>
          svc.restore(args.name, {
            snapshot: flags.snapshot,
            target: flags.target,
            dryRun: flags['dry-run'],
            approved: flags.yes,
          }),
        );
        if (data.dryRun === true) {
          if (flags['dry-run']) return { data };
          return {
            data,
            ...approvalPending({
              operation: 'Restore backup',
              target: `${data.snapshot} → ${data.target} on ${data.host}`,
              consequence: restoreConsequence(data.target, data.targetState),
            }),
            nextActions: [
              {
                command: restoreInvocation(args.name, flags),
                description: 'Restore once the user has approved this snapshot and target',
              },
            ],
          };
        }
        return {
          data,
          errors: data.restored
            ? []
            : [
                agentError('VOPS_OPERATION_FAILED', 'operational', `Restore failed: ${data.stderr ?? 'unknown'}`, {
                  suggestedAction: 'Read data.stderr, then re-run once the snapshot and target directory are valid.',
                }),
              ],
        };
      },
      (res) => {
        if (res.dryRun === true) {
          this.log(chalk.cyan('[plan] ') + res.command);
          this.log(chalk.dim(`       target ${res.target} on '${res.host}': ${TARGET_STATE_LABEL[res.targetState]}`));
          return;
        }
        if (res.restored) this.log(chalk.green(`✓ Restored into ${res.target} on '${res.host}'`));
      },
    );
  }
}

/** The approved re-run: the snapshot and the target are what the user actually said yes to, so
 * both are carried — a follow-up that dropped either would restore something else. */
export function restoreInvocation(host: string, flags: { snapshot: string; target: string }): string {
  return [
    `vops backup restore ${host}`,
    `--snapshot ${flags.snapshot}`,
    `--target ${flags.target}`,
    '--yes --json',
  ].join(' ');
}

const TARGET_STATE_LABEL: Record<RestoreTargetState, string> = {
  missing: 'does not exist yet (restic creates it)',
  empty: 'exists and is empty',
  'not-empty': 'ALREADY HAS CONTENT — restored files land alongside it, same-named ones are overwritten',
  unknown: 'could not be inspected',
};

function restoreConsequence(target: string, state: RestoreTargetState): string {
  if (state === 'not-empty') {
    return `${target} already has content on the host; restic writes the snapshot into it and overwrites same-named files.`;
  }
  return `It writes the whole snapshot into ${target} on the host.`;
}
