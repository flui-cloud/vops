import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ServiceBackend, ServiceContext, ServiceStatus, serviceEnv } from './service-model';

export const TASK_NAME = 'vops';

/** Absolute, never a PATH lookup: this registers something that will start on its
 * own at logon, so a shadowed binary would be a persistent one. */
const SCHTASKS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function unitPath(ctx: ServiceContext): string {
  return path.join(path.dirname(ctx.logPath), 'vops-task.xml');
}

/**
 * Task Scheduler has no environment block, so the settings that must survive
 * (profile, config dir, port) ride in as a `cmd /c set X=… && node …` line. The
 * alternative — a wrapper script on disk — is one more file to keep in sync.
 */
export function renderTaskXml(ctx: ServiceContext): string {
  const env = serviceEnv(ctx)
    .map(([k, v]) => `set ${k}=${v}`)
    .join(' && ');
  const command = `${env} && "${ctx.node}" "${ctx.binRun}" ui --no-open`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>vops local dashboard and metrics collector</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(ctx.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(ctx.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c ${escapeXml(command)}</Arguments>
      <WorkingDirectory>${escapeXml(os.homedir())}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * `schtasks /XML` rejects a UTF-8 file with an error that says nothing useful —
 * it demands UTF-16LE *with* a BOM. This one line is the most likely thing to
 * break on Windows, so it lives alone and is asserted by a spec.
 */
export function writeTaskXml(file: string, xml: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + xml, 'utf16le');
}

export class SchtasksBackend implements ServiceBackend {
  readonly platform: NodeJS.Platform = 'win32';

  unitPath = unitPath;
  render = renderTaskXml;

  logHint(ctx: ServiceContext): string {
    return `type "${ctx.logPath}"`;
  }

  install(ctx: ServiceContext): ServiceStatus {
    const file = unitPath(ctx);
    writeTaskXml(file, renderTaskXml(ctx));
    schtasks(['/Create', '/TN', TASK_NAME, '/XML', file, '/F']);
    schtasks(['/Run', '/TN', TASK_NAME], true);
    return {
      ...this.status(ctx),
      warnings: [
        'Windows briefly shows a console window when the task starts at logon. It closes on its own.',
      ],
    };
  }

  uninstall(ctx: ServiceContext): { removed: boolean; unitPath: string } {
    const file = unitPath(ctx);
    const existed = this.query(ctx).length > 0;
    schtasks(['/Delete', '/TN', TASK_NAME, '/F'], true);
    fs.rmSync(file, { force: true });
    return { removed: existed, unitPath: file };
  }

  status(ctx: ServiceContext): ServiceStatus {
    const out = this.query(ctx);
    return {
      supported: true,
      platform: 'win32',
      installed: out.length > 0,
      running: /Status:\s+Running/i.test(out),
      // A logon trigger, like launchd's LaunchAgent: it comes up without the user
      // doing anything. Running before logon would mean storing their password.
      bootStart: out.length > 0,
      unitPath: unitPath(ctx),
      logHint: this.logHint(ctx),
      warnings: [],
    };
  }

  start(): void {
    schtasks(['/Run', '/TN', TASK_NAME], true);
  }

  stop(): void {
    schtasks(['/End', '/TN', TASK_NAME], true);
  }

  restart(): void {
    schtasks(['/End', '/TN', TASK_NAME], true);
    schtasks(['/Run', '/TN', TASK_NAME], true);
  }

  private query(_ctx: ServiceContext): string {
    try {
      return execFileSync(SCHTASKS, ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'], {
        encoding: 'utf8',
      });
    } catch {
      return '';
    }
  }
}

function schtasks(args: string[], ignoreErrors = false): void {
  try {
    execFileSync(SCHTASKS, args, { stdio: 'ignore' });
  } catch (e) {
    if (!ignoreErrors) throw e;
  }
}
