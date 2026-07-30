import { KnownHostTarget, pruneKnownHostsFile } from '../lib/known-hosts';
import { VopsHost } from './host.model';

/** The machine a provider just destroyed, as the provider described it before the delete. */
export interface DestroyedServer {
  provider: string;
  serverId: string;
  address?: string | null;
}

/**
 * Inventory entries describing a machine that no longer exists. Matched by provider server id or
 * by address — never by name alone: host names are unique only inside the local inventory, so a
 * name match could forget an unrelated machine that happens to share it.
 */
export function staleHostsFor(hosts: VopsHost[], server: DestroyedServer): VopsHost[] {
  const address = server.address?.trim();
  return hosts.filter(
    (h) =>
      (!!h.providerServerId &&
        h.providerServerId === server.serverId &&
        h.provider === server.provider) ||
      (!!address && h.address === address),
  );
}

/** Addresses whose host key is now stale: the destroyed server's own, plus every forgotten
 * host's (a host may have been recorded on a non-default port). */
export function knownHostTargets(stale: VopsHost[], server: DestroyedServer): KnownHostTarget[] {
  const address = server.address?.trim();
  return [
    ...stale.map((h) => ({ address: h.address, port: h.port })),
    ...(address ? [{ address, port: 22 }] : []),
  ];
}

/** The inventory operations this needs — a structural type so the cleanup is testable without DI. */
export interface HostInventory {
  list(): VopsHost[];
  remove(name: string): void;
}

export interface ForgetDeps {
  hosts: HostInventory;
  knownHostsFile: string;
  audit: (action: string, detail: unknown) => Promise<void>;
}

export interface ForgetOutcome {
  forgotten: string[];
  knownHostsPruned: number;
  warning?: string;
}

/**
 * Drop every local trace of a destroyed server. Called after the provider delete succeeded, so it
 * never throws: an inventory entry left behind keeps reporting its last probe (`ready`) for an
 * address the provider has taken back, but the machine is already gone and reporting failure here
 * would only invite a retry that cannot help.
 */
export async function forgetDestroyedServer(
  deps: ForgetDeps,
  server: DestroyedServer,
): Promise<ForgetOutcome> {
  const forgotten: string[] = [];
  let knownHostsPruned = 0;
  try {
    const stale = staleHostsFor(deps.hosts.list(), server);
    const targets = knownHostTargets(stale, server);
    for (const host of stale) {
      deps.hosts.remove(host.name);
      forgotten.push(host.name);
    }
    knownHostsPruned = pruneKnownHostsFile(deps.knownHostsFile, targets);
    await deps.audit('server.delete.forget', { ...server, forgotten, knownHostsPruned });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      forgotten,
      knownHostsPruned,
      warning: `Server deleted, but the local records were not fully cleaned up: ${reason}`,
    };
  }
  return { forgotten, knownHostsPruned };
}
