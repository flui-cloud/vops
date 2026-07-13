import { SshExec, SshTarget } from '../lib/ssh-exec';

/** Read the login user's crontab (empty string when none). */
export async function readCrontab(ssh: SshExec, target: SshTarget): Promise<string> {
  return (await ssh.run(target, 'crontab -l 2>/dev/null || true')).stdout;
}

/**
 * Replace the login user's crontab with `content`, staged under $HOME (per-user,
 * not world-writable) then loaded. Empty content clears the crontab.
 */
export async function writeCrontab(ssh: SshExec, target: SshTarget, content: string): Promise<void> {
  if (!content.trim()) {
    await ssh.run(target, 'crontab -r 2>/dev/null || true');
    return;
  }
  const home = (await ssh.run(target, 'printf %s "$HOME"')).stdout.trim() || '/root';
  const tmp = `${home}/.vops-crontab`;
  await ssh.putFile(target, tmp, content, '0600');
  await ssh.run(target, `crontab '${tmp}'; rm -f '${tmp}'`);
}
