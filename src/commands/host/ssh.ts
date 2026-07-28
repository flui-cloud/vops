import { spawnSync } from 'node:child_process';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsHostShellService } from '../../host-ops/host-shell.service';

export default class HostSsh extends Command {
  static readonly description =
    'Open a login shell on a host in your inventory (resolved the same way vops itself connects: ops key first, else the assigned user key).';

  static readonly examples = ['<%= config.bin %> <%= command.id %> vmi3399032', '<%= config.bin %> <%= command.id %> vmi3399032 --print'];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    print: Flags.boolean({ description: 'Print the ssh command instead of connecting', default: false }),
    json: Flags.boolean({ description: 'Output the resolved session as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(HostSsh);
    let access;
    try {
      access = (await getVopsApp()).get(VopsHostShellService).access(args.name);
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

    this.log(chalk.dim(`Connecting to ${access.host} (${access.user}@${access.address})…`));
    const res = spawnSync('ssh', access.argv, { stdio: 'inherit' });
    if (res.error) this.error(`Failed to launch ssh: ${res.error.message}`, { exit: 1 });
    if (typeof res.status === 'number' && res.status !== 0) this.exit(res.status);
  }
}
