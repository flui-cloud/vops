import { spawnSync } from 'node:child_process';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../lib/nest';
import { agentJsonFlag, emitEnvelope, failCommand } from '../agent-api/agent-output';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';

export default class Ssh extends Command {
  static readonly description = 'SSH into a server using a local private key (never uploaded)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> ovh vops-d2-2-abc',
    '<%= config.bin %> <%= command.id %> hetzner my-server --user ubuntu --key laptop',
    '<%= config.bin %> <%= command.id %> ovh my-server --print',
  ];

  static readonly args = {
    provider: Args.string({ description: 'hetzner | scaleway | contabo | ovh', required: true }),
    server: Args.string({ description: 'Server id or name', required: true }),
  };

  static readonly flags = {
    user: Flags.string({ description: 'SSH user (default: root; ovh: ubuntu)' }),
    key: Flags.string({ description: 'Local key name to use (default: the only usable key)' }),
    print: Flags.boolean({ description: 'Print the ssh command instead of connecting', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Ssh);
    let info;
    try {
      info = await (await getVopsApp())
        .get(VopsSshKeysService)
        .connectInfo(args.provider, args.server, { user: flags.user, keyName: flags.key });
    } catch (err) {
      failCommand(this, err, flags.json);
    } finally {
      await closeVopsApp();
    }

    if (flags.json) {
      emitEnvelope(this, 'vops ssh', info);
      return;
    }
    if (flags.print) {
      this.log(info.command);
      return;
    }

    this.log(chalk.dim(`Connecting to ${info.serverName} (${info.user}@${info.host}) with key '${info.keyName}'…`));
    const res = spawnSync(
      'ssh',
      ['-i', info.privateKeyPath, `${info.user}@${info.host}`],
      { stdio: 'inherit' },
    );
    if (res.error) {
      this.error(`Failed to launch ssh: ${res.error.message}`, { exit: 1 });
    }
    if (typeof res.status === 'number' && res.status !== 0) {
      this.exit(res.status);
    }
  }
}
