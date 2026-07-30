import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withService } from '../../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../../agent-api/agent-output';
import { VopsMonitorService } from '../../../monitor/vops-monitor.service';

export default class WatchHostAdd extends Command {
  static readonly description = 'Watch a host for silence — install the dead-man monitor (cron + readable script, no daemon)';

  static readonly aliases = ['host:monitor:setup'];
  static readonly deprecateAliases = true;

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --interval 5 --disk-crit 90 --dry-run',
  ];

  static readonly args = {
    name: Args.string({ description: 'Host name', required: true }),
  };

  static readonly flags = {
    interval: Flags.integer({ description: 'Heartbeat interval (minutes)', default: 5 }),
    'disk-warn': Flags.integer({ description: 'Disk warn threshold (%)', default: 85 }),
    'disk-crit': Flags.integer({ description: 'Disk critical threshold (%)', default: 95 }),
    'load-crit': Flags.string({ description: 'load1 critical threshold', default: '2.0' }),
    'ntfy-topic': Flags.string({ description: 'ntfy topic to alert on (silence/threshold)' }),
    'ntfy-server': Flags.string({ description: 'ntfy server (default https://ntfy.sh)' }),
    'webhook-url': Flags.string({ description: 'HTTPS webhook URL for alerts' }),
    'webhook-secret': Flags.string({ description: 'Shared secret for the webhook HMAC' }),
    'telegram-chat': Flags.string({ description: 'Telegram chat id' }),
    'telegram-link': Flags.string({ description: 'Link code from `vops watch telegram`' }),
    'dry-run': Flags.boolean({ description: 'Print the files/cron, apply nothing', default: false }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchHostAdd);
    const channels = [
      ...(flags['ntfy-topic'] ? [{ type: 'ntfy' as const, topic: flags['ntfy-topic'], server: flags['ntfy-server'] }] : []),
      ...(flags['webhook-url'] ? [{ type: 'webhook' as const, url: flags['webhook-url'], secret: flags['webhook-secret'] }] : []),
      ...(flags['telegram-chat'] ? [{ type: 'telegram' as const, chatId: flags['telegram-chat'] }] : []),
      ...(flags['telegram-link'] ? [{ type: 'telegram' as const, linkCode: flags['telegram-link'] }] : []),
    ];
    await runAgentCommand(
      this,
      'vops watch host add',
      flags.json,
      async () => {
        // `watch plan add` already refuses a channel-less watch; the dead-man monitor
        // needs the guard even more, since speaking up when the host stops is its only
        // job. A dry run is exempt — it applies nothing.
        if (!channels.length && !flags['dry-run']) {
          throw new Error(
            'A monitor needs at least one delivery channel — otherwise a silent host alerts nobody.\n' +
              'Add one of: --ntfy-topic, --telegram-link (from `vops watch telegram`), --telegram-chat, --webhook-url',
          );
        }
        return {
          data: await withService(VopsMonitorService, (svc) =>
            svc.setup(args.name, {
              intervalMin: flags.interval,
              thresholds: { diskWarn: flags['disk-warn'], diskCrit: flags['disk-crit'], loadCrit: Number(flags['load-crit']) },
              channels,
              dryRun: flags['dry-run'],
            }),
          ),
        };
      },
      (res) => {
        if (res.dryRun === true) {
          for (const [path, body] of Object.entries(res.files)) {
            this.log(chalk.cyan(`[dry-run] ${path}`));
            this.log(chalk.dim(body.split('\n').map((l) => '  ' + l).join('\n')));
          }
          this.log(chalk.cyan('[dry-run] crontab: ') + res.cron.join(' '));
          return;
        }
        this.log(chalk.green(`✓ Monitor installed on '${res.host}' (every ${res.interval}min)`));
        this.log(chalk.dim(`  relay host id ${res.hostId} · alerts on silence (dead-man switch)`));
      },
    );
  }
}
