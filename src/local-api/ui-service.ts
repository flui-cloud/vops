import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Optional login-time background service keeping `vops ui` running, so the installed PWA
 * always finds the local API up (macOS launchd today; opt-in and reversible). */
const LABEL = 'cloud.flui.vops.ui';

export interface UiServiceContext {
  /** Node executable to run vops with (absolute — the agent has no PATH of ours). */
  node: string;
  /** Absolute path to the vops `bin/run` entrypoint. */
  binRun: string;
}

export interface UiServiceStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  plist: string;
}

export function uiServiceSupported(): boolean {
  return process.platform === 'darwin';
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function logPath(): string {
  return path.join(os.homedir(), '.config', 'vops', 'logs', 'ui.log');
}

function assertSupported(): void {
  if (!uiServiceSupported()) {
    throw new Error(
      `The background service is macOS-only for now (this is ${process.platform}). ` +
        `On Linux, add a systemd --user unit running 'vops ui --no-open'.`,
    );
  }
}

function escapeXml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderPlist(ctx: UiServiceContext): string {
  const args = [ctx.node, ctx.binRun, 'ui', '--no-open'];
  const argXml = args.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n');
  const log = escapeXml(logPath());
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
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
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

export function installUiService(ctx: UiServiceContext): { plist: string; log: string } {
  assertSupported();
  const p = plistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  fs.writeFileSync(p, renderPlist(ctx), { mode: 0o644 });
  // Reload cleanly if a previous version is already registered.
  try {
    execFileSync('launchctl', ['unload', p], { stdio: 'ignore' });
  } catch {
    /* not loaded yet */
  }
  execFileSync('launchctl', ['load', '-w', p]);
  return { plist: p, log: logPath() };
}

export function uninstallUiService(): { removed: boolean; plist: string } {
  assertSupported();
  const p = plistPath();
  if (!fs.existsSync(p)) return { removed: false, plist: p };
  try {
    execFileSync('launchctl', ['unload', '-w', p], { stdio: 'ignore' });
  } catch {
    /* already unloaded */
  }
  fs.rmSync(p);
  return { removed: true, plist: p };
}

export function uiServiceStatus(): UiServiceStatus {
  const p = plistPath();
  if (!uiServiceSupported()) return { supported: false, installed: false, running: false, plist: p };
  const installed = fs.existsSync(p);
  let running = false;
  try {
    const line = execFileSync('launchctl', ['list'], { encoding: 'utf8' })
      .split('\n')
      .find((l) => l.includes(LABEL));
    const pid = line?.trim().split(/\s+/)[0];
    running = pid != null && /^\d+$/.test(pid);
  } catch {
    /* launchctl unavailable */
  }
  return { supported: true, installed, running, plist: p };
}
