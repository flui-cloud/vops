import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Profile-scoped paths and identity. The vops config layout is
 * ~/.config/vops/profiles/<profile>/ (overridable via VOPS_CONFIG_DIR /
 * VOPS_PROFILE, as the rest of the codebase already does).
 */
export function configBase(): string {
  return process.env.VOPS_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'vops');
}

export function profileDir(): string {
  const profile = process.env.VOPS_PROFILE ?? 'default';
  return path.join(configBase(), 'profiles', profile);
}

/**
 * A short, stable, random id minted once per profile. It tags the vops ops key
 * line in a server's authorized_keys so vops can find *its own* line without
 * parsing key material — and so two vops installs sharing a host stay distinct.
 */
export function profileId(): string {
  const dir = profileDir();
  const idPath = path.join(dir, 'profile-id');
  if (fs.existsSync(idPath)) {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing) return existing;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(idPath, id + '\n', { mode: 0o600 });
  return id;
}
