import * as fs from 'node:fs';
import * as path from 'node:path';
import { shq } from './app-scripts';

/** Opening the user's OWN terminal on the user's OWN machine (local API is 127.0.0.1-only) —
 * the UI never gets a remote shell, it asks vops to hand the same `ssh` argv `vops app shell` runs to a terminal app. */
export interface TerminalCandidate {
  cmd: string;
  args: string[];
  label: string;
}

const LINUX_TERMINALS: Array<{ cmd: string; args: (s: string) => string[] }> = [
  { cmd: 'x-terminal-emulator', args: (s) => ['-e', 'bash', s] },
  { cmd: 'gnome-terminal', args: (s) => ['--', 'bash', s] },
  { cmd: 'konsole', args: (s) => ['-e', 'bash', s] },
  { cmd: 'xfce4-terminal', args: (s) => ['--command', `bash ${s}`] },
  { cmd: 'kitty', args: (s) => ['bash', s] },
  { cmd: 'alacritty', args: (s) => ['-e', 'bash', s] },
  { cmd: 'wezterm', args: (s) => ['start', '--', 'bash', s] },
  { cmd: 'ptyxis', args: (s) => ['--', 'bash', s] },
  { cmd: 'xterm', args: (s) => ['-e', 'bash', s] },
];

/** Terminal apps to try, best first. `override` is `$VOPS_TERMINAL` (app name on macOS, binary on Linux). */
export function terminalCandidates(platform: NodeJS.Platform, script: string, override?: string): TerminalCandidate[] {
  if (platform === 'darwin') {
    const apps = [...(override ? [override] : []), 'Terminal'];
    return apps.map((app) => ({ cmd: 'open', args: ['-a', app, script], label: app }));
  }
  if (platform === 'linux') {
    const list = [...(override ? [{ cmd: override, args: (s: string) => ['-e', 'bash', s] }] : []), ...LINUX_TERMINALS];
    return list.map((t) => ({ cmd: t.cmd, args: t.args(script), label: t.cmd }));
  }
  return [];
}

/** Absolute path of `cmd` on PATH, or null. */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (cmd.includes('/')) return executable(cmd) ? cmd : null;
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.map((d) => path.join(d, cmd)).find(executable) ?? null;
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolveTerminal(candidates: TerminalCandidate[], lookup = which): TerminalCandidate | null {
  return candidates.find((c) => lookup(c.cmd) !== null) ?? null;
}

/** The throwaway launcher the terminal executes — removes itself first (bash keeps its open fd)
 * so no ssh invocation is left in /tmp. Carries no secret, only the local key PATH. */
export function renderLauncherScript(argv: string[], title: string): string {
  return [
    '#!/bin/bash',
    'rm -f -- "$0"',
    `echo "vops · ${title.replaceAll('"', '')}"`,
    `exec ssh ${argv.map(shq).join(' ')}`,
    '',
  ].join('\n');
}

export function launcherFileName(platform: NodeJS.Platform, token: string): string {
  // Terminal.app only runs a file it recognises as a shell script (.command).
  return `vops-shell-${token}${platform === 'darwin' ? '.command' : '.sh'}`;
}
