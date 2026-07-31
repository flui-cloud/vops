import * as crypto from 'node:crypto';
import { profileId } from '../lib/profile';

/**
 * What the running server knows about itself, published to `/healthz`.
 *
 * `/healthz` is unauthenticated by design — it sits outside `/api`, so anything
 * on this machine can read it. That is what makes it useful (a second `vops ui`
 * can ask "is the thing on 7788 mine?" before falling back to another port) and
 * it is also why the fields are deliberately dull: no host names, no counts, no
 * vault state, no paths.
 */
export interface RuntimeInfo {
  version: string;
  port: number;
  startedAt: string;
  /** A hash of the profile id, never the id itself: that value tags this install's
   * line in the authorized_keys of every server it manages. */
  profile: string;
}

let info: RuntimeInfo | null = null;

export function setRuntimeInfo(port: number): RuntimeInfo {
  info = {
    version: packageVersion(),
    port,
    startedAt: new Date().toISOString(),
    profile: profileFingerprint(),
  };
  return info;
}

export function runtimeInfo(): RuntimeInfo | null {
  return info;
}

export function profileFingerprint(): string {
  return crypto.createHash('sha256').update(profileId()).digest('hex').slice(0, 12);
}

function packageVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
