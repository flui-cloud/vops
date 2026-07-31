import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ServiceBackend, ServiceContext, ServiceStatus, serviceEnv } from './service-model';

export const UNIT_NAME = 'vops.service';

export function unitPath(ctx: ServiceContext): string {
  return path.join(ctx.home, '.config', 'systemd', 'user', UNIT_NAME);
}

const ESCAPED_BACKSLASH = String.raw`\\`;
const ESCAPED_QUOTE = String.raw`\"`;
const BACKSLASH = ESCAPED_BACKSLASH[0];

/** systemd reads the value verbatim up to the newline; quoting keeps a path with
 * spaces in one piece. */
function quote(v: string): string {
  const escaped = v.replaceAll(BACKSLASH, ESCAPED_BACKSLASH).replaceAll('"', ESCAPED_QUOTE);
  return `"${escaped}"`;
}

export function renderUnit(ctx: ServiceContext): string {
  const env = serviceEnv(ctx)
    .map(([k, v]) => `Environment=${k}=${quote(v)}`)
    .join('\n');
  return `[Unit]
Description=vops local dashboard and metrics collector
Documentation=https://vops.flui.cloud
After=network-online.target

[Service]
Type=simple
ExecStart=${quote(ctx.node)} ${quote(ctx.binRun)} ui --no-open
Restart=always
RestartSec=3
${env}

[Install]
WantedBy=default.target
`;
}

export class SystemdUserBackend implements ServiceBackend {
  readonly platform: NodeJS.Platform = 'linux';

  unitPath = unitPath;
  render = renderUnit;

  logHint(): string {
    return `journalctl --user -u ${UNIT_NAME} -f`;
  }

  install(ctx: ServiceContext): ServiceStatus {
    const p = unitPath(ctx);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, renderUnit(ctx), { mode: 0o644 });
    systemctl(['daemon-reload']);
    systemctl(['enable', '--now', UNIT_NAME]);

    // Lingering is what turns "starts at login" into "starts at boot", and it is
    // the one step that can legitimately fail (no polkit, no D-Bus session, a
    // container). Failing the whole install over it would be worse than saying so.
    // Run it before reading the status, or bootStart reports the old value.
    const lingered = enableLinger(ctx.user);
    const status = this.status(ctx);
    if (lingered) return status;
    return {
      ...status,
      warnings: [
        ...status.warnings,
        `Could not enable lingering, so vops will start when you log in rather than at boot. ` +
          `To fix: loginctl enable-linger ${ctx.user}`,
      ],
    };
  }

  uninstall(ctx: ServiceContext): { removed: boolean; unitPath: string } {
    const p = unitPath(ctx);
    if (!fs.existsSync(p)) return { removed: false, unitPath: p };
    systemctl(['disable', '--now', UNIT_NAME], true);
    fs.rmSync(p);
    systemctl(['daemon-reload'], true);
    return { removed: true, unitPath: p };
  }

  status(ctx: ServiceContext): ServiceStatus {
    const p = unitPath(ctx);
    const installed = fs.existsSync(p);
    return {
      supported: true,
      platform: 'linux',
      installed,
      running: installed && systemctlOut(['is-active', UNIT_NAME]) === 'active',
      bootStart: installed && lingers(ctx.user),
      unitPath: p,
      logHint: this.logHint(),
      warnings: [],
    };
  }

  start(): void {
    systemctl(['start', UNIT_NAME], true);
  }

  stop(): void {
    systemctl(['stop', UNIT_NAME], true);
  }

  restart(): void {
    systemctl(['restart', UNIT_NAME], true);
  }
}

/** Absolute paths, never PATH lookup: this runs while installing a unit that will
 * start on its own at boot, so a shadowed binary would be a persistent one. */
function bin(name: string): string {
  const candidates = [`/usr/bin/${name}`, `/bin/${name}`];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function systemctl(args: string[], ignoreErrors = false): void {
  try {
    execFileSync(bin('systemctl'), ['--user', ...args], { stdio: 'ignore' });
  } catch (e) {
    if (!ignoreErrors) throw e;
  }
}

function systemctlOut(args: string[]): string {
  try {
    return execFileSync(bin('systemctl'), ['--user', ...args], { encoding: 'utf8' }).trim();
  } catch (e) {
    // `is-active` exits non-zero for an inactive unit and still prints the state.
    const out = (e as { stdout?: string }).stdout;
    return typeof out === 'string' ? out.trim() : '';
  }
}

function enableLinger(user: string): boolean {
  try {
    execFileSync(bin('loginctl'), ['enable-linger', user], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function lingers(user: string): boolean {
  try {
    return execFileSync(bin('loginctl'), ['show-user', user, '-p', 'Linger'], { encoding: 'utf8' })
      .trim()
      .endsWith('=yes');
  } catch {
    return false;
  }
}
