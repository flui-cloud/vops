import { BadRequestException } from '@nestjs/common';
import { VopsHost } from '../hosts/host.model';

/**
 * Host analogue of the provider write-gate. Every rung-2/3 write to a server
 * (harden, monitor/backup setup, key installs) passes here first. Two rules:
 *   • honour a global read-only switch (`VOPS_READONLY=1`);
 *   • only ever mutate a host that is in the inventory — never an ad-hoc address.
 */
export function assertHostWritable(host: VopsHost | null | undefined): asserts host is VopsHost {
  if (!host) {
    throw new BadRequestException(
      'Unknown host. Add it first: vops host add <name> --address <ip|fqdn>',
    );
  }
  if (process.env.VOPS_READONLY === '1') {
    throw new BadRequestException(
      `Refusing to modify '${host.name}': VOPS_READONLY=1 is set (read-only mode).`,
    );
  }
}
