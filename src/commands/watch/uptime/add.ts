import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient } from '../../../lib/cloud-client';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';

export default class WatchUptimeAdd extends Command {
  static readonly description = 'Add an external uptime monitor (the hosted relay probes it from outside)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web --target https://example.com --check http:https://example.com',
    '<%= config.bin %> <%= command.id %> db --target 203.0.113.10 --check tcp:5432 --interval 30',
    '<%= config.bin %> <%= command.id %> gw --target 203.0.113.1 --check ping',
  ];

  static readonly args = {
    name: Args.string({ description: 'Monitor name', required: true }),
  };

  static readonly flags = {
    target: Flags.string({ description: 'Host or URL to probe', required: true }),
    check: Flags.string({ description: 'tcp:<port> | http:<url> | https:<url> | ping', default: 'ping' }),
    interval: Flags.integer({ description: 'Seconds between probes', default: 60 }),
    'expect-status': Flags.string({ description: 'Expected HTTP status range (e.g. 200-399)' }),
    'ntfy-topic': Flags.string({ description: 'ntfy topic to alert on transitions' }),
    'ntfy-server': Flags.string({ description: 'ntfy server (default https://ntfy.sh)' }),
    'webhook-url': Flags.string({ description: 'HTTPS webhook URL for transitions' }),
    'webhook-secret': Flags.string({ description: 'Shared secret for the webhook HMAC' }),
    'telegram-chat': Flags.string({ description: 'Telegram chat id' }),
    'telegram-link': Flags.string({ description: 'Link code from `vops watch telegram`' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchUptimeAdd);
    const channels = [
      ...(flags['ntfy-topic'] ? [{ type: 'ntfy' as const, topic: flags['ntfy-topic'], server: flags['ntfy-server'] }] : []),
      ...(flags['webhook-url'] ? [{ type: 'webhook' as const, url: flags['webhook-url'], secret: flags['webhook-secret'] }] : []),
      ...(flags['telegram-chat'] ? [{ type: 'telegram' as const, chatId: flags['telegram-chat'] }] : []),
      ...(flags['telegram-link'] ? [{ type: 'telegram' as const, linkCode: flags['telegram-link'] }] : []),
    ];
    await runAgentCommand(
      this,
      'vops watch uptime add',
      flags.json,
      async () => ({
        data: await new CloudClient().createUptime({
          name: args.name,
          target: flags.target,
          check: flags.check,
          interval: flags.interval,
          expectStatus: flags['expect-status'],
          channels,
        }),
      }),
      (monitor) => {
        this.log(`${chalk.green('✓')} Monitoring ${chalk.bold(monitor.name)} (${monitor.check} → ${monitor.target}) every ${monitor.interval}s`);
        this.log(chalk.dim(`  id ${monitor.id} · alerts flow into your feed/channels`));
      },
    );
  }
}
