import { Command, Flags } from '@oclif/core';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import chalk from 'chalk';
import { DEFAULT_UI_PORT, startLocalApi } from '../local-api/bootstrap';
import { isInteractive } from '../lib/keyring/prompt';
import { ensureVaultUnlocked } from '../lib/keyring/unlock';
import { resolveContext, serviceStatus } from '../service/index';
import { statusLines } from '../service/service-report';

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
    install: Flags.boolean({
      description: 'Alias for `vops service install`',
      default: false,
    }),
    uninstall: Flags.boolean({
      description: 'Alias for `vops service uninstall`',
      default: false,
    }),
    status: Flags.boolean({
      description: 'Alias for `vops service status`',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Ui);
    if (flags.status) return this.serviceStatus();
    if (flags.uninstall) return this.delegate('uninstall');
    if (flags.install) return this.delegate('install');
    await this.unlockVault();
    // No terminal means we are the supervised service: it must wait its turn
    // rather than hand over and exit, or the supervisor respawns it forever.
    const { url, port, onDefaultPort, adopted } = await startLocalApi({
      standBy: !isInteractive(),
      onStandBy: (p) => this.log(chalk.dim(`  Another vops for this profile holds ${p} — standing by until it stops.`)),
    });

    // Someone — almost always the background service — is already serving this
    // profile. A second server would be a second origin for the installed app
    // and a second set of background probes, so hand over and get out of the way.
    if (adopted) {
      this.log(chalk.green(`\n✓ vops is already running at ${chalk.underline(url)}`));
      if (flags.open) openBrowser(url);
      this.log(chalk.dim('  Started by the background service. Stop it with: vops service stop\n'));
      return;
    }

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

    // The dashboard is installable as a desktop app, but a browser tab does
    // little to advertise that — and this terminal is where the user is looking.
    this.log(
      chalk.dim(
        `  Want it as a desktop app? Open the link in Chrome or Edge and use the\n` +
          `  install button in the address bar. vops then gets its own window and\n` +
          `  icon, and launches from your dock or Start menu.\n`,
      ),
    );

    // Only when we actually fell back. A port the user pinned is not a surprise
    // that needs explaining.
    if (!onDefaultPort && !process.env.VOPS_PORT?.trim()) {
      this.log(
        chalk.yellow(`  ! Port ${DEFAULT_UI_PORT} was busy, so this run uses ${port}.`) +
          chalk.dim(
            `\n    An installed app is tied to the default port and won't reach this\n` +
              `    one. Stop the other instance before launching the desktop app.\n`,
          ),
      );
    }

    // Server command: stay alive until interrupted.
    await new Promise<void>(() => {});
  }

  /** Prompt here, in the terminal, since a browser request can't prompt for a
   * passphrase. No-ops without a terminal (the background service); pages then show locked instead of refusing to boot. */
  private async unlockVault(): Promise<void> {
    if (!isInteractive()) return;
    try {
      await ensureVaultUnlocked();
    } catch (e) {
      this.log(chalk.yellow(`  ! Vault stayed locked: ${e instanceof Error ? e.message : String(e)}`));
      this.log(chalk.dim('    Credential pages will ask you to run `vops keyring unlock`.\n'));
    }
  }

  /** The service flags moved to their own topic. They stay as aliases because the
   * old spelling is printed in docs, in the dashboard and in people's notes. */
  private async delegate(command: string): Promise<void> {
    this.log(chalk.dim(`  (moved to \`vops service ${command}\` — running it for you)`));
    await this.config.runCommand(`service:${command}`, []);
  }

  private serviceStatus(): void {
    const ctx = resolveContext({ binRun: path.join(this.config.root, 'bin', 'run') });
    this.log('');
    for (const line of statusLines(serviceStatus(ctx))) this.log(line);
    this.log(chalk.dim('\n  Full control: vops service status | start | stop | restart | logs\n'));
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
