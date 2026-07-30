import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException, Injectable } from '@nestjs/common';
import { buildInteractiveSshArgv, displaySshCommand, knownHostsPath } from '../lib/ssh-exec';
import { LocalStore } from '../lib/store/local-store';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { resolveSshTarget } from '../host-ops/ssh-target';
import { ShellComponent, buildExecCommand, pickShellComponent, shellComponents } from './app-shell';
import { resolveInstall } from './app-resolve';
import { launcherFileName, renderLauncherScript, resolveTerminal, terminalCandidates } from './terminal-launch';

export interface ShellOptions {
  component?: string;
  shell?: string;
  /** argv run inside the container instead of an interactive shell. */
  command?: string[];
}
export interface ShellAccess {
  app: string;
  host: string;
  component: string;
  container: string;
  components: ShellComponent[];
  /** ssh argv (without the `ssh` binary) — spawned as-is by the CLI. */
  argv: string[];
  /** The same invocation as a copy-pasteable line. */
  command: string;
  /** The vops equivalent, for users who'd rather type it. */
  cli: string;
  interactive: boolean;
}
export interface ShellLaunch extends ShellAccess {
  launched: boolean;
  terminal?: string;
  /** Why no terminal was opened (unsupported platform / none installed). */
  reason?: string;
}

/** Shell access into a deployed app's container, resolved once and shared by the CLI (spawns
 * the argv on the TTY) and the local UI (opens a terminal on it) — vops never proxies the session itself. */
@Injectable()
export class VopsAppShellService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly store: LocalStore,
  ) {}

  async access(name: string, opts: ShellOptions = {}, onHost?: string): Promise<ShellAccess> {
    const install = await resolveInstall(this.store, name, onHost);
    const host = this.hosts.show(install.host);
    const target = resolveSshTarget(host, this.keys);

    let comp: ShellComponent;
    try {
      comp = pickShellComponent(install, opts.component);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
    const interactive = !opts.command?.length;
    const remote = buildExecCommand({
      container: comp.container,
      interactive,
      shell: opts.shell,
      command: opts.command,
      sudo: host.user !== 'root',
    });
    const argv = buildInteractiveSshArgv(target, { tty: interactive, remote, knownHosts: knownHostsPath() });
    return {
      app: install.name,
      host: host.name,
      component: comp.name,
      container: comp.container,
      components: shellComponents(install),
      argv,
      command: displaySshCommand(argv),
      cli:
        `vops app shell ${install.name}` +
        (onHost ? ` --host ${install.host}` : '') +
        (comp.primary ? '' : ` --component ${comp.name}`),
      interactive,
    };
  }

  /** Open the user's terminal app on the resolved session (UI "Open shell" button). */
  async launch(name: string, opts: ShellOptions = {}, onHost?: string): Promise<ShellLaunch> {
    const access = await this.access(name, { ...opts, command: undefined }, onHost);
    const script = path.join(os.tmpdir(), launcherFileName(process.platform, crypto.randomBytes(6).toString('hex')));
    fs.writeFileSync(script, renderLauncherScript(access.argv, `${access.container} · ${access.host}`), { mode: 0o700 });

    const term = resolveTerminal(terminalCandidates(process.platform, script, process.env.VOPS_TERMINAL));
    if (!term) {
      fs.rmSync(script, { force: true });
      return { ...access, launched: false, reason: noTerminalReason() };
    }
    const child = spawn(term.cmd, term.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => fs.rmSync(script, { force: true }));
    child.unref();
    await this.store.appendAudit('app.shell', { app: access.app, host: access.host, container: access.container, terminal: term.label });
    return { ...access, launched: true, terminal: term.label };
  }
}

function noTerminalReason(): string {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return 'No terminal app found — set VOPS_TERMINAL, or copy the command below.';
  }
  return `Opening a terminal is not supported on ${process.platform} — copy the command below.`;
}
