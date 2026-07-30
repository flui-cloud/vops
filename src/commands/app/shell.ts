import { spawnSync } from 'node:child_process';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { agentJsonFlag, emitEnvelope, failCommand } from '../../agent-api/agent-output';
import { VopsAppShellService, ShellAccess } from '../../apps/app-shell.service';
import { installHostFlag } from '../../apps/deploy-flags';

export default class AppShell extends Command {
  static readonly description =
    'Open a shell inside a deployed app’s container (ssh + podman exec). Pass a command after `--` to run it once.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> nextcloud',
    '<%= config.bin %> <%= command.id %> wordpress --component db',
    '<%= config.bin %> <%= command.id %> nextcloud -- php occ status',
    '<%= config.bin %> <%= command.id %> nextcloud --print',
  ];

  /** Everything after the install name is the in-container command. */
  static readonly strict = false;

  static readonly args = {
    name: Args.string({ description: 'Install name', required: true }),
  };

  static readonly flags = {
    ...installHostFlag,
    component: Flags.string({ char: 'c', description: 'Component to enter (default: the app’s primary)' }),
    shell: Flags.string({ description: 'Shell binary inside the container (default: bash, else sh)' }),
    print: Flags.boolean({ description: 'Print the ssh command instead of connecting', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, argv, flags } = await this.parse(AppShell);
    const command = (argv as string[]).slice(1);

    let access: ShellAccess;
    try {
      access = await (await getVopsApp())
        .get(VopsAppShellService)
        .access(args.name, { component: flags.component, shell: flags.shell, command }, flags.host);
    } catch (err) {
      failCommand(this, err, flags.json);
    } finally {
      await closeVopsApp();
    }

    if (flags.json) {
      emitEnvelope(this, 'vops app shell', access);
      return;
    }
    if (flags.print) {
      this.log(access.command);
      return;
    }

    if (access.interactive) {
      this.log(chalk.dim(`Entering ${access.container} on ${access.host} — exit to come back.`));
    }
    const res = spawnSync('ssh', access.argv, { stdio: 'inherit' });
    if (res.error) this.error(`Failed to launch ssh: ${res.error.message}`, { exit: 1 });
    if (typeof res.status === 'number' && res.status !== 0) this.exit(res.status);
  }
}
