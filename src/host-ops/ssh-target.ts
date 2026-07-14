import { BadRequestException } from '@nestjs/common';
import { SshTarget } from '../lib/ssh-exec';
import { OPS_KEY_NAME, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHost } from '../hosts/host.model';

/**
 * The SSH key vops uses for AUTOMATED host operations: the profile ops key when it
 * is installed, otherwise the host's own user key. Throws when neither is usable —
 * every rung-2/3 op shares this resolution so behaviour stays identical.
 */
export function resolveSshTarget(host: VopsHost, keys: VopsSshKeysService): SshTarget {
  if (host.opsKeyInstalled) {
    const ops = keys.list().find((k) => k.name === OPS_KEY_NAME && k.hasPrivateKey);
    if (ops) return { host, keyPath: ops.privateKeyPath };
  }
  const userKeyPath = keys.keyPathFor(host.userKeyName);
  if (userKeyPath) return { host, keyPath: userKeyPath };
  throw new BadRequestException(
    `No usable key for host '${host.name}'. Set a user key (vops host add --key) or install the ops key first.`,
  );
}
