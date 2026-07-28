import { Injectable } from '@nestjs/common';
import { buildInteractiveSshArgv, displaySshCommand, knownHostsPath } from '../lib/ssh-exec';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { resolveSshTarget } from './ssh-target';

export interface HostShellAccess {
  host: string;
  user: string;
  address: string;
  /** ssh argv (without the `ssh` binary) — spawned as-is by the CLI. */
  argv: string[];
  /** The same invocation as a copy-pasteable line. */
  command: string;
  /** The vops equivalent, for users who'd rather type it. */
  cli: string;
}

/** Login shell into a HOST itself (not a container), resolved via `resolveSshTarget` (ops key
 * first) like every other host-inventory op — deliberately not `vops ssh <provider> <server>`,
 * which is for an arbitrary provider server not yet in inventory. */
@Injectable()
export class VopsHostShellService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
  ) {}

  access(name: string): HostShellAccess {
    const host = this.hosts.show(name);
    const target = resolveSshTarget(host, this.keys);
    const argv = buildInteractiveSshArgv(target, { tty: true, knownHosts: knownHostsPath() });
    return {
      host: host.name,
      user: host.user,
      address: host.address,
      argv,
      command: displaySshCommand(argv),
      cli: `vops host ssh ${host.name}`,
    };
  }
}
