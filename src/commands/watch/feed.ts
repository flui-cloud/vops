import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CloudClient, FeedEvent } from '../../lib/cloud-client';

function colorState(state: string): string {
  if (state === 'up') return chalk.green(state);
  if (state === 'down') return chalk.red(state);
  return state;
}

const arrow = (e: FeedEvent) => `${e.fromState ?? '?'} ${chalk.dim('→')} ${colorState(e.toState)}`;

const line = (e: FeedEvent) => {
  const label = `${e.provider} ${e.serverType}`;
  return `${chalk.dim(new Date(e.at).toLocaleString())}  ${chalk.bold(label)} @ ${e.location}  ${chalk.dim(e.kind)}  ${arrow(e)}`;
};

export default class WatchFeed extends Command {
  static readonly description = 'Show transitions matching your watches (history + optional live follow)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --follow',
    '<%= config.bin %> <%= command.id %> --since 2026-07-08T00:00:00Z --limit 100',
  ];

  static readonly flags = {
    since: Flags.string({ description: 'Only events after this ISO timestamp' }),
    limit: Flags.integer({ description: 'Max events (history)', default: 50 }),
    follow: Flags.boolean({ char: 'f', description: 'Stream new transitions live (Ctrl-C to stop)', default: false }),
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WatchFeed);
    const client = new CloudClient();
    try {
      const events = await client.feed(flags.since, flags.limit);
      if (flags.json && !flags.follow) {
        this.log(JSON.stringify({ events }, null, 2));
        return;
      }
      if (!events.length) this.log(chalk.dim('No matching transitions yet.'));
      for (const e of events) this.log(line(e));

      if (flags.follow) {
        this.log(chalk.dim('— following (Ctrl-C to stop) —'));
        await client.streamFeed((e) => this.log(flags.json ? JSON.stringify(e) : line(e)));
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    }
  }
}
