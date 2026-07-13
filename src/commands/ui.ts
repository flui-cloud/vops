import { Command, Flags } from '@oclif/core';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { startLocalApi } from '../local-api/bootstrap';

export default class Ui extends Command {
  static readonly description =
    'Start the local vops UI + API on 127.0.0.1 (localhost only, no telemetry)';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-open',
  ];

  static readonly flags = {
    open: Flags.boolean({
      description: 'Open the dashboard in your default browser',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Ui);
    const { url, port } = await startLocalApi();
    this.log(chalk.green(`\n✓ vops running at ${chalk.underline(url)}`));
    this.log(
      chalk.dim(
        `  API: http://127.0.0.1:${port}/api · session token required · Ctrl-C to stop\n`,
      ),
    );

    if (flags.open) {
      const opened = openBrowser(url);
      this.log(
        chalk.dim(
          opened
            ? '  Opening your browser… (use --no-open to skip)\n'
            : "  Couldn't open a browser automatically — open the link above.\n",
        ),
      );
    }

    // Server command: stay alive until interrupted.
    await new Promise<void>(() => {});
  }
}

/**
 * Open a URL in the OS default browser without shell interpolation (args are
 * passed as an array, never a shell string) and without failing the process on
 * a headless/SSH host — the link is always printed as a fallback.
 */
function openBrowser(url: string): boolean {
  const byPlatform: Record<string, { cmd: string; args: string[] }> = {
    darwin: { cmd: 'open', args: [url] },
    win32: { cmd: 'cmd', args: ['/c', 'start', '', url] },
  };
  const command = byPlatform[process.platform] ?? {
    cmd: 'xdg-open',
    args: [url],
  };
  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
