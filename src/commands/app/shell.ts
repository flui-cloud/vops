import { spawnSync } from 'node:child_process';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsAppShellService, ShellAccess } from '../../apps/app-shell.service';

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
    component: Flags.string({ char: 'c', description: 'Component to enter (default: the app’s primary)' }),
    shell: Flags.string({ description: 'Shell binary inside the container (default: bash, else sh)' }),
    print: Flags.boolean({ description: 'Print the ssh command instead of connecting', default: false }),
    json: Flags.boolean({ description: 'Output the resolved session as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, argv, flags } = await this.parse(AppShell);
    const command = (argv as string[]).slice(1);

    let access: ShellAccess;
    try {
      access = await (await getVopsApp())
        .get(VopsAppShellService)
        .access(args.name, { component: flags.component, shell: flags.shell, command });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
      return;
    } finally {
      await closeVopsApp();
    }

    if (flags.json) {
      this.log(JSON.stringify(access, null, 2));
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
