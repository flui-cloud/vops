import * as path from 'node:path';
import { configBase } from './profile';

export const DEFAULT_PROFILE = 'default';

export function activeProfile(): string {
  return process.env.VOPS_PROFILE?.trim() || DEFAULT_PROFILE;
}

export interface EnvFileOptions {
  /** Working directory whose `.env` is a dev convenience on the default profile. */
  cwd?: string;
  /** Package-relative `.env` shipped beside the install (default profile only). */
  packageEnv?: string;
}

/**
 * The `.env` files a vops process may read, in precedence order — first wins, which
 * is how both dotenv and Nest's ConfigModule resolve a list.
 *
 * A **named profile reads only its own file**. Env-based providers (Contabo, OVH's
 * OS_*, Cherry) take their credentials from `process.env`, so a shared `.env` loaded
 * regardless of profile meant `VOPS_PROFILE=<throwaway>` isolated the encrypted store
 * and nothing else: a scratch profile still held the user's real tokens and could
 * spend real money. The default profile keeps the exact list it always loaded.
 */
export function vopsEnvFiles(opts: EnvFileOptions = {}): string[] {
  const base = configBase();
  const profile = activeProfile();
  const profileEnv = path.join(base, 'profiles', profile, '.env');
  if (profile !== DEFAULT_PROFILE) return [profileEnv];
  return [
    ...(opts.packageEnv ? [opts.packageEnv] : []),
    path.join(base, '.env'),
    ...(opts.cwd ? [path.join(opts.cwd, '.env')] : []),
  ];
}
