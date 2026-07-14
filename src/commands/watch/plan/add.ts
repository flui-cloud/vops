import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient, ChannelInput, EventKind } from '../../../lib/cloud-client';

export default class WatchPlanAdd extends Command {
  static readonly description =
    'Watch a plan and get pushed when it comes back in stock (or changes price)';

  static readonly aliases = ['watch:add'];
  static readonly deprecateAliases = true;

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner cx53 --location fsn1 --ntfy-topic my-vops-alerts',
    '<%= config.bin %> <%= command.id %> ovh b2-7 --kind availability --kind price --webhook-url https://example.com/hook',
    '<%= config.bin %> <%= command.id %> hetzner cx23 --telegram-link <code-from-watch-telegram>',
  ];

  static readonly args = {
    provider: Args.string({ description: 'Provider id (hetzner|scaleway|contabo|ovh)', required: true }),
    serverType: Args.string({ description: 'Plan / server-type id (e.g. cx53, b2-7)', required: true }),
  };

  static readonly flags = {
    location: Flags.string({ description: 'Restrict to one location/region (default: any)' }),
    kind: Flags.string({ description: 'What to watch', options: ['availability', 'price'], multiple: true }),
    'ntfy-topic': Flags.string({ description: 'ntfy topic to publish to (your own)' }),
    'ntfy-server': Flags.string({ description: 'ntfy server (default https://ntfy.sh)' }),
    'webhook-url': Flags.string({ description: 'HTTPS webhook URL (HMAC-signed if --webhook-secret given)' }),
    'webhook-secret': Flags.string({ description: 'Shared secret for the webhook HMAC signature' }),
    'telegram-chat': Flags.string({ description: 'Telegram chat id (if you already know it)' }),
    'telegram-link': Flags.string({ description: 'Link code from `vops watch telegram`' }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WatchPlanAdd);

    const channels: ChannelInput[] = [
      ...(flags['ntfy-topic'] ? [{ type: 'ntfy' as const, topic: flags['ntfy-topic'], server: flags['ntfy-server'] }] : []),
      ...(flags['webhook-url'] ? [{ type: 'webhook' as const, url: flags['webhook-url'], secret: flags['webhook-secret'] }] : []),
      ...(flags['telegram-chat'] ? [{ type: 'telegram' as const, chatId: flags['telegram-chat'] }] : []),
      ...(flags['telegram-link'] ? [{ type: 'telegram' as const, linkCode: flags['telegram-link'] }] : []),
    ];
    if (!channels.length) {
      this.error('Provide at least one channel: --ntfy-topic, --webhook-url, --telegram-chat or --telegram-link', { exit: 1 });
    }

    try {
      const watch = await new CloudClient().createWatch({
        provider: args.provider,
        serverType: args.serverType,
        location: flags.location,
        kinds: flags.kind as EventKind[] | undefined,
        channels,
      });
      if (flags.json) {
        this.log(JSON.stringify(watch, null, 2));
        return;
      }
      const label = `${watch.provider} ${watch.serverType}`;
      const locationSuffix = watch.location ? ` @ ${watch.location}` : ' (any location)';
      this.log(
        `${chalk.green('✓')} Watching ${chalk.bold(label)}` +
          `${locationSuffix} · ${watch.kinds.join(', ')} → ${watch.channels.join(', ')}`,
      );
      this.log(chalk.dim(`  id ${watch.id}`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
  }
}
