import { BadRequestException } from '@nestjs/common';
import { SshExec, SshTarget } from '../lib/ssh-exec';

export interface RemoteAkState {
  home: string;
  akPath: string;
  content: string;
}

/**
 * Read a host's authorized_keys over one session, resolving the login user's home
 * from `$HOME` (so it works for root and non-root), and ensure ~/.ssh exists with
 * strict perms. The file content is returned verbatim for the pure transforms.
 */
export async function readAuthorizedKeys(ssh: SshExec, target: SshTarget): Promise<RemoteAkState> {
  const home = await ssh.run(target, 'printf %s "$HOME"');
  if (home.code !== 0 || !home.stdout.trim()) {
    throw new BadRequestException(
      `Cannot reach ${target.host.name}: ${home.stderr.trim() || 'connection failed'}`,
    );
  }
  const h = home.stdout.trim();
  const akPath = `${h}/.ssh/authorized_keys`;
  const read = await ssh.run(
    target,
    `mkdir -p '${h}/.ssh'; chmod 700 '${h}/.ssh'; cat '${akPath}' 2>/dev/null || true`,
  );
  return { home: h, akPath, content: read.stdout };
}

/** First candidate key that opens a working session, or null if none authenticate. */
export async function pickWorkingTarget(
  ssh: SshExec,
  host: SshTarget['host'],
  keyPaths: string[],
): Promise<SshTarget | null> {
  for (const keyPath of keyPaths) {
    const target: SshTarget = { host, keyPath };
    const res = await ssh.run(target, 'true');
    if (res.code === 0) return target;
  }
  return null;
}
