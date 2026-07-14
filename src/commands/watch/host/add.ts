import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../../lib/nest';
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
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchHostAdd);
    const channels = [
      ...(flags['ntfy-topic'] ? [{ type: 'ntfy' as const, topic: flags['ntfy-topic'], server: flags['ntfy-server'] }] : []),
      ...(flags['webhook-url'] ? [{ type: 'webhook' as const, url: flags['webhook-url'], secret: flags['webhook-secret'] }] : []),
      ...(flags['telegram-chat'] ? [{ type: 'telegram' as const, chatId: flags['telegram-chat'] }] : []),
      ...(flags['telegram-link'] ? [{ type: 'telegram' as const, linkCode: flags['telegram-link'] }] : []),
    ];
    try {
      const res = await (await getVopsApp()).get(VopsMonitorService).setup(args.name, {
        intervalMin: flags.interval,
        thresholds: { diskWarn: flags['disk-warn'], diskCrit: flags['disk-crit'], loadCrit: Number(flags['load-crit']) },
        channels,
        dryRun: flags['dry-run'],
      });
      if (flags.json) {
        this.log(JSON.stringify(res, null, 2));
        return;
      }
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
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
