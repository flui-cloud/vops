import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

/** Handles two traps: a deep VOPS_CONFIG_DIR can blow the ~104-108 byte sun_path
 * limit (falls back to a hashed temp-dir path, like ssh-agent does), and Windows
 * pipe names can't contain separators. Access control is the cookie, not this path. */

/** Conservative cap: macOS allows 104 including the NUL, Linux 108. */
const SUN_PATH_MAX = 100;

export interface SocketLocation {
  /** The listen/connect path. */
  socketPath: string;
  /** Directory to create at 0700 before listening (undefined on Windows). */
  dir?: string;
}

export function keyringSocket(profileDir: string, platform: NodeJS.Platform = process.platform): SocketLocation {
  if (platform === 'win32') {
    return { socketPath: String.raw`\\.\pipe\vops-keyring-${profileTag(profileDir)}` };
  }

  const preferred = path.join(profileDir, 'keyring.sock');
  if (Buffer.byteLength(preferred) <= SUN_PATH_MAX) return { socketPath: preferred, dir: profileDir };

  const short = path.join(os.tmpdir(), `vops-${profileTag(profileDir)}`);
  return { socketPath: path.join(short, 'k.sock'), dir: short };
}

/** Short, stable, filesystem- and pipe-name-safe id for a profile directory. */
function profileTag(profileDir: string): string {
  return crypto.createHash('sha256').update(path.resolve(profileDir)).digest('hex').slice(0, 16);
}
