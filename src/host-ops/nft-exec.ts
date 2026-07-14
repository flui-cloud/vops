import { SshExec, SshTarget } from '../lib/ssh-exec';
import { VopsHost } from '../hosts/host.model';

/** Non-root login users need sudo for nft/systemctl; root (or missing user) does not. */
export function sudoPrefix(host: VopsHost): string {
  return host.user && host.user !== 'root' ? 'sudo -n ' : '';
}

/**
 * Absolute path to `nft`, or '' if absent. `command -v nft` misses /usr/sbin on a
 * non-root PATH, so the sbin locations are probed explicitly.
 */
export async function resolveNftBin(ssh: SshExec, target: SshTarget): Promise<string> {
  const res = await ssh.run(
    target,
    'command -v nft 2>/dev/null || (test -x /usr/sbin/nft && echo /usr/sbin/nft) || (test -x /sbin/nft && echo /sbin/nft) || true',
  );
  return res.stdout.trim().split('\n')[0].trim();
}
