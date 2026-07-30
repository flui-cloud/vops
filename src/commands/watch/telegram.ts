import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../lib/cloud-client';
import { failCommand } from '../../agent-api/agent-output';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default class WatchTelegram extends Command {
  static readonly description =
    'Link a Telegram chat for watch notifications (opens a one-time /start deep link)';

  static readonly flags = {
    wait: Flags.integer({ description: 'Seconds to wait for you to tap /start', default: 180 }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WatchTelegram);
    const client = new CloudClient();
    try {
      const { code, url } = await client.linkTelegram();
      this.log(`${chalk.bold('1.')} Open this link and press Start:`);
      const linkText = url ?? `send "/start ${code}" to the vops bot`;
      this.log(`   ${chalk.cyan(linkText)}`);
      this.log(`${chalk.bold('2.')} Waiting for the link to complete…`);

      const deadline = Date.now() + flags.wait * 1000;
      while (Date.now() < deadline) {
        const { linked } = await client.telegramStatus(code);
        if (linked) {
          this.log(`${chalk.green('✓')} Telegram linked.`);
          this.log(chalk.dim(`  Now create a watch: vops watch plan add <provider> <plan> --telegram-link ${code}`));
          return;
        }
        await sleep(3000);
      }
      this.log(chalk.yellow('Timed out waiting for /start.'));
      this.log(chalk.dim(`  Once you've pressed Start, use: vops watch plan add … --telegram-link ${code}`));
    } catch (err) {
      failCommand(this, err);
    }
  }
}
