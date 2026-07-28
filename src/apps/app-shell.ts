import { AppInstallV1 } from './app.model';
import { shq } from './app-scripts';

/** Pure builders for the rootful `podman exec` argv run over the shared interactive-ssh path —
 * nothing here runs a process, so the CLI (TTY) and local API (terminal app) stay byte-identical. */
export interface ShellComponent {
  name: string;
  container: string;
  primary: boolean;
}

export interface ShellSpec {
  container: string;
  /** Interactive session (TTY + a shell) vs a one-shot command. */
  interactive: boolean;
  /** Explicit shell binary; undefined = detect bash, fall back to sh. */
  shell?: string;
  /** argv run inside the container instead of a shell (one-shot). */
  command?: string[];
  /** The SSH login user is not root — deploys are rootful, so podman needs sudo. */
  sudo: boolean;
}

const AUTODETECT_SHELL = 'command -v bash >/dev/null 2>&1 && exec bash || exec sh';

export function shellComponents(install: AppInstallV1): ShellComponent[] {
  return install.components.map((c) => ({
    name: c.name,
    container: c.container,
    primary: c.name === install.primary,
  }));
}

export function pickShellComponent(install: AppInstallV1, name?: string): ShellComponent {
  const all = shellComponents(install);
  if (!all.length) throw new Error(`'${install.name}' has no container to open a shell in.`);
  if (!name) return all.find((c) => c.primary) ?? all[0];
  const found = all.find((c) => c.name === name || c.container === name);
  if (found) return found;
  throw new Error(`'${name}' is not a component of '${install.name}' (have: ${all.map((c) => c.name).join(', ')}).`);
}

/** The `podman exec` line as the remote shell will parse it. */
export function buildExecCommand(spec: ShellSpec): string {
  const sudo = spec.sudo ? ['sudo', ...(spec.interactive ? [] : ['-n'])] : [];
  return [...sudo, 'podman', 'exec', spec.interactive ? '-it' : '-i', shq(spec.container), ...execTail(spec)].join(' ');
}

function execTail(spec: ShellSpec): string[] {
  if (spec.command?.length) return spec.command.map(shq);
  if (spec.shell) return [shq(spec.shell)];
  return ['sh', '-c', shq(AUTODETECT_SHELL)];
}
