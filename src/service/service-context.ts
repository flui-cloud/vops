import * as os from 'node:os';
import * as path from 'node:path';
import { configBase } from '../lib/profile';
import { DEFAULT_UI_PORT } from '../local-api/bootstrap';
import { ServiceContext } from './service-model';

/**
 * The launchd label from the first macOS-only version. Deliberately unchanged:
 * renaming it would orphan every agent already installed — it would keep running
 * forever with no way for the new code to find, stop or replace it.
 */
export const SERVICE_LABEL = 'cloud.flui.vops.ui';

export interface ContextOverrides {
  node?: string;
  binRun: string;
  port?: number;
  profile?: string;
}

export function resolveContext(o: ContextOverrides): ServiceContext {
  const explicitPort = Number(process.env.VOPS_PORT?.trim());
  return {
    node: o.node ?? process.execPath,
    binRun: o.binRun,
    profile: o.profile ?? process.env.VOPS_PROFILE ?? 'default',
    configDir: process.env.VOPS_CONFIG_DIR ?? null,
    port: o.port ?? (Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : DEFAULT_UI_PORT),
    label: SERVICE_LABEL,
    logPath: path.join(configBase(), 'logs', 'ui.log'),
    user: os.userInfo().username,
    home: os.homedir(),
  };
}
