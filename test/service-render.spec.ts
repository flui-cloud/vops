import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderPlist, plistPath } from '../src/service/launchd';
import { renderUnit, unitPath as systemdPath } from '../src/service/systemd-user';
import { renderTaskXml, writeTaskXml, unitPath as taskPath } from '../src/service/schtasks';
import { pickBackend } from '../src/service/index';
import { ServiceContext } from '../src/service/service-model';

const ctx: ServiceContext = {
  node: '/usr/local/bin/node',
  binRun: '/opt/vops/bin/run',
  profile: 'work',
  configDir: '/home/dawit/.config/vops',
  port: 7788,
  label: 'cloud.flui.vops.ui',
  logPath: '/home/dawit/.config/vops/logs/ui.log',
  user: 'dawit',
  home: '/home/dawit',
};

/** Every unit must pin these, or a service started at boot silently serves the
 * default profile on whatever port it happens to get. */
function carriesTheEnvironment(unit: string): void {
  expect(unit).toContain('VOPS_PORT');
  expect(unit).toContain('7788');
  expect(unit).toContain('VOPS_PROFILE');
  expect(unit).toContain('work');
  expect(unit).toContain('VOPS_CONFIG_DIR');
  expect(unit).toContain('/home/dawit/.config/vops');
}

describe('launchd agent', () => {
  it('runs vops with no browser and restarts it', () => {
    const plist = renderPlist(ctx);
    expect(plist).toContain('<string>cloud.flui.vops.ui</string>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/opt/vops/bin/run</string>');
    expect(plist).toContain('<string>--no-open</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    carriesTheEnvironment(plist);
  });

  it('omits VOPS_CONFIG_DIR when the user never set one', () => {
    expect(renderPlist({ ...ctx, configDir: null })).not.toContain('VOPS_CONFIG_DIR');
  });

  it('escapes a path that would otherwise break the XML', () => {
    const plist = renderPlist({ ...ctx, binRun: '/opt/a&b/<run>' });
    expect(plist).toContain('/opt/a&amp;b/&lt;run&gt;');
    expect(plist).not.toContain('<run>');
  });

  it('lives in the user LaunchAgents folder', () => {
    expect(plistPath(ctx)).toBe('/home/dawit/Library/LaunchAgents/cloud.flui.vops.ui.plist');
  });
});

describe('systemd --user unit', () => {
  it('restarts always and installs into the default target', () => {
    const unit = renderUnit(ctx);
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/vops/bin/run" ui --no-open');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    carriesTheEnvironment(unit);
  });

  it('quotes values so a path with spaces survives', () => {
    expect(renderUnit({ ...ctx, binRun: '/opt/my vops/bin/run' })).toContain('"/opt/my vops/bin/run"');
  });

  it('lives under ~/.config/systemd/user', () => {
    expect(systemdPath(ctx)).toBe('/home/dawit/.config/systemd/user/vops.service');
  });
});

describe('Windows scheduled task', () => {
  it('triggers at logon, stays hidden and never expires', () => {
    const xml = renderTaskXml(ctx);
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Hidden>true</Hidden>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<RestartOnFailure>');
    // InteractiveToken: running before logon would mean storing the user's password.
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    carriesTheEnvironment(xml);
  });

  it('declares UTF-16 and is written as UTF-16LE with a BOM', () => {
    // schtasks /XML rejects a UTF-8 file with an error that explains nothing.
    const xml = renderTaskXml(ctx);
    expect(xml).toContain('encoding="UTF-16"');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-task-'));
    const file = path.join(dir, 'task.xml');
    writeTaskXml(file, xml);
    const raw = fs.readFileSync(file);
    expect(raw[0]).toBe(0xff);
    expect(raw[1]).toBe(0xfe);
    expect(raw.toString('utf16le').slice(1)).toBe(xml);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('escapes the quoted command it hands to cmd.exe', () => {
    const xml = renderTaskXml({ ...ctx, binRun: 'C:\\Program Files\\vops\\bin\\run' });
    expect(xml).toContain('&quot;C:\\Program Files\\vops\\bin\\run&quot;');
  });

  it('names the task file next to the logs', () => {
    expect(taskPath(ctx)).toBe(path.join('/home/dawit/.config/vops/logs', 'vops-task.xml'));
  });
});

describe('backend selection', () => {
  it('picks one per platform and nothing for the rest', () => {
    expect(pickBackend('darwin')?.platform).toBe('darwin');
    expect(pickBackend('linux')?.platform).toBe('linux');
    expect(pickBackend('win32')?.platform).toBe('win32');
    expect(pickBackend('freebsd')).toBeNull();
  });
});
