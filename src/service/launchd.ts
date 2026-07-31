import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ServiceBackend, ServiceContext, ServiceStatus, serviceEnv } from './service-model';

/** launchd needs an absolute PATH: an agent inherits almost nothing. */
const AGENT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/** Absolute, never a PATH lookup: this registers something that will start on its
 * own at login, so a shadowed binary would be a persistent one. */
const LAUNCHCTL = '/bin/launchctl';

function escapeXml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function plistPath(ctx: ServiceContext): string {
  return path.join(ctx.home, 'Library', 'LaunchAgents', `${ctx.label}.plist`);
}

export function renderPlist(ctx: ServiceContext): string {
  const args = [ctx.node, ctx.binRun, 'ui', '--no-open']
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join('\n');
  const env = [['PATH', AGENT_PATH], ...serviceEnv(ctx)]
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');
  const log = escapeXml(ctx.logPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(ctx.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`;
}

export class LaunchdBackend implements ServiceBackend {
  readonly platform: NodeJS.Platform = 'darwin';

  unitPath = plistPath;
  render = renderPlist;

  logHint(ctx: ServiceContext): string {
    return `tail -f ${ctx.logPath}`;
  }

  install(ctx: ServiceContext): ServiceStatus {
    const p = plistPath(ctx);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.mkdirSync(path.dirname(ctx.logPath), { recursive: true });
    fs.writeFileSync(p, renderPlist(ctx), { mode: 0o644 });
    // Reload cleanly if a previous version is already registered — same label, so
    // this transparently upgrades an install made by an older vops.
    launchctl(['unload', p], true);
    launchctl(['load', '-w', p]);
    return this.status(ctx);
  }

  uninstall(ctx: ServiceContext): { removed: boolean; unitPath: string } {
    const p = plistPath(ctx);
    if (!fs.existsSync(p)) return { removed: false, unitPath: p };
    launchctl(['unload', '-w', p], true);
    fs.rmSync(p);
    return { removed: true, unitPath: p };
  }

  status(ctx: ServiceContext): ServiceStatus {
    const p = plistPath(ctx);
    const installed = fs.existsSync(p);
    return {
      supported: true,
      platform: 'darwin',
      installed,
      running: installed && this.isRunning(ctx),
      // A LaunchAgent starts at login, not at boot. From the user's side that is
      // still "it comes up on its own", which is what the flag means.
      bootStart: installed,
      unitPath: p,
      logHint: this.logHint(ctx),
      warnings: installed && this.isStale(p) ? [STALE_WARNING] : [],
    };
  }

  start(ctx: ServiceContext): void {
    launchctl(['load', '-w', plistPath(ctx)], true);
  }

  stop(ctx: ServiceContext): void {
    launchctl(['unload', plistPath(ctx)], true);
  }

  restart(ctx: ServiceContext): void {
    // kickstart -k replaces the running instance without unregistering the agent,
    // so KeepAlive can't race us by restarting the old one first.
    launchctl(['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${ctx.label}`], true);
  }

  private isRunning(ctx: ServiceContext): boolean {
    try {
      const line = execFileSync(LAUNCHCTL, ['list'], { encoding: 'utf8' })
        .split('\n')
        .find((l) => l.includes(ctx.label));
      const pid = line?.trim().split(/\s+/)[0];
      return pid != null && /^\d+$/.test(pid);
    } catch {
      return false;
    }
  }

  /** A plist written before the service carried profile/port env — it silently
   * serves the default profile on whatever port it lands on. */
  private isStale(p: string): boolean {
    try {
      return !fs.readFileSync(p, 'utf8').includes('VOPS_PROFILE');
    } catch {
      return false;
    }
  }
}

const STALE_WARNING =
  'This service was installed by an older vops and does not pin your profile or port. Run `vops service install` to refresh it.';

function launchctl(args: string[], ignoreErrors = false): void {
  try {
    execFileSync(LAUNCHCTL, args, { stdio: 'ignore' });
  } catch (e) {
    if (!ignoreErrors) throw e;
  }
}
