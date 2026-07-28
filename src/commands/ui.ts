import { Command, Flags } from '@oclif/core';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import chalk from 'chalk';
import { DEFAULT_UI_PORT, startLocalApi } from '../local-api/bootstrap';
import { isInteractive } from '../lib/keyring/prompt';
import { ensureVaultUnlocked } from '../lib/keyring/unlock';
import {
  installUiService,
  uninstallUiService,
  uiServiceStatus,
  uiServiceSupported,
} from '../local-api/ui-service';

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
      description: 'Install a login-time background service so the UI is always running (macOS)',
      default: false,
    }),
    uninstall: Flags.boolean({
      description: 'Remove the background service',
      default: false,
    }),
    status: Flags.boolean({
      description: 'Show whether the background service is installed and running',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Ui);
    if (flags.status) return this.serviceStatus();
    if ((flags.install || flags.uninstall) && !uiServiceSupported()) {
      this.log(chalk.yellow('The background service is macOS-only for now.'));
      this.log(chalk.dim('On Linux, add a systemd --user unit running `vops ui --no-open`.'));
      return;
    }
    if (flags.uninstall) return this.serviceUninstall();
    if (flags.install) return this.serviceInstall();
    await this.unlockVault();
    const { url, port, onDefaultPort } = await startLocalApi();
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

    if (!onDefaultPort) {
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

  private serviceInstall(): void {
    const ctx = { node: process.execPath, binRun: path.join(this.config.root, 'bin', 'run') };
    const { plist, log } = installUiService(ctx);
    this.log(chalk.green('\n✓ Background service installed and started.'));
    this.log(
      chalk.dim(
        `  vops keeps the dashboard running at login now, so the installed app opens\n` +
          `  straight to your fleet — no need to start it by hand.\n` +
          `  plist: ${plist}\n` +
          `  logs:  ${log}\n` +
          `  Remove it any time: vops ui --uninstall\n`,
      ),
    );
  }

  private serviceUninstall(): void {
    const { removed } = uninstallUiService();
    this.log(
      removed
        ? chalk.green('\n✓ Background service removed.\n')
        : chalk.dim('\nNo background service was installed.\n'),
    );
  }

  private serviceStatus(): void {
    const s = uiServiceStatus();
    if (!s.supported) {
      this.log(chalk.yellow('Background service: not supported on this platform (macOS only).'));
      return;
    }
    const installed = s.installed ? chalk.green('installed') : chalk.dim('not installed');
    const running = s.running ? chalk.green('running') : chalk.dim('stopped');
    this.log(`Background service: ${installed} · ${running}`);
    if (s.installed) this.log(chalk.dim(`  plist: ${s.plist}`));
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
