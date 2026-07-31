import { LaunchdBackend } from './launchd';
import { SchtasksBackend } from './schtasks';
import { SystemdUserBackend } from './systemd-user';
import { ServiceBackend, ServiceContext, ServiceStatus, unsupportedStatus } from './service-model';

export { SERVICE_LABEL, resolveContext } from './service-context';
export type { ServiceContext, ServiceStatus } from './service-model';

/** Platform is a parameter, not a global read, so all three units can be rendered
 * and asserted from any machine — the same trick `keyringSocket` uses. */
export function pickBackend(platform: NodeJS.Platform = process.platform): ServiceBackend | null {
  if (platform === 'darwin') return new LaunchdBackend();
  if (platform === 'linux') return new SystemdUserBackend();
  if (platform === 'win32') return new SchtasksBackend();
  return null;
}

export function serviceStatus(ctx: ServiceContext, platform: NodeJS.Platform = process.platform): ServiceStatus {
  return pickBackend(platform)?.status(ctx) ?? unsupportedStatus(platform);
}

export function requireBackend(platform: NodeJS.Platform = process.platform): ServiceBackend {
  const backend = pickBackend(platform);
  if (!backend) throw new Error(`vops has no background service for ${platform} yet.`);
  return backend;
}
