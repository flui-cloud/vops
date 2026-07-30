// chalk 5 is ESM and the command modules below import it for their human rendering, which this
// suite never reaches — it only reads their flag definitions.
jest.mock('chalk', () => new Proxy({}, { get: () => (s: string) => s }));

import { pickInstall } from '../src/apps/app-resolve';
import { VopsAppsService } from '../src/apps/vops-apps.service';
import type { AppInstallV1 } from '../src/apps/app.model';
import type { AgentError } from '../src/agent-api/agent-envelope';
import type { AgentBadRequest } from '../src/agent-api/agent-http-errors';
import AppCredentials from '../src/commands/app/credentials';
import AppExpose from '../src/commands/app/expose';
import AppLogs from '../src/commands/app/logs';
import AppRemove from '../src/commands/app/remove';
import AppRestart from '../src/commands/app/restart';
import AppShell from '../src/commands/app/shell';
import AppShow from '../src/commands/app/show';
import AppStatus from '../src/commands/app/status';
import AppUnexpose from '../src/commands/app/unexpose';

/**
 * Installs are keyed by `(host, name)`, so deploying the same catalog app on two hosts under its
 * default name (the app id) makes every name-only command ambiguous — and, before `--host`, there
 * was no way to say which one was meant: not `remove`, so the state could not even be undone
 * except by hand over SSH plus a DELETE against vops.db.
 *
 * `--host` matches the host RECORDED on the install, never the inventory: an install whose server
 * is gone must stay addressable, or the dead end just moves.
 */

const install = (name: string, host: string): AppInstallV1 => ({ name, host, appId: name }) as AppInstallV1;

const refusalOf = (fn: () => unknown): AgentError => {
  try {
    fn();
  } catch (e) {
    return (e as AgentBadRequest).agent;
  }
  throw new Error('expected a refusal');
};

/** Every command that identifies an install by bare name must be able to disambiguate it —
 * one of them without `--host` is a dead end for the whole family, since the collision is
 * created by `install` and can only be undone by `remove`. */
describe('every name-taking app command takes --host', () => {
  const commands: Array<[string, { flags: Record<string, unknown> }]> = [
    ['credentials', AppCredentials],
    ['expose', AppExpose],
    ['logs', AppLogs],
    ['remove', AppRemove],
    ['restart', AppRestart],
    ['shell', AppShell],
    ['show', AppShow],
    ['status', AppStatus],
    ['unexpose', AppUnexpose],
  ];

  it.each(commands)('app %s', (id, cmd) => {
    expect({ id, host: 'host' in cmd.flags }).toEqual({ id, host: true });
  });
});

describe('pickInstall — which install a name means', () => {
  const two = [install('it-tools', 'vops-sw-5'), install('it-tools', 'web1')];

  it('takes the only match when the name is unique, with no --host', () => {
    expect(pickInstall('it-tools', undefined, [install('it-tools', 'web1')]).host).toBe('web1');
  });

  it('refuses to guess between two hosts and points at --host', () => {
    const err = refusalOf(() => pickInstall('it-tools', undefined, two));
    expect(err.code).toBe('VOPS_APP_AMBIGUOUS');
    expect(err.message).toContain('(vops-sw-5, web1)');
    // The old advice ("give distinct --names when deploying") only helped BEFORE the collision.
    expect(err.suggestedAction).toContain('--host');
    expect(err.suggestedAction).toContain('vops-sw-5');
    expect(err.suggestedAction).not.toContain('--name');
    // An agent can now fix this from its own inputs, which is what `recoverable` means.
    expect(err.recoverable).toBe(true);
  });

  it('picks the named host out of a collision', () => {
    expect(pickInstall('it-tools', 'web1', two).host).toBe('web1');
    expect(pickInstall('it-tools', 'vops-sw-5', two).host).toBe('vops-sw-5');
  });

  it('addresses an install whose host is gone — the ledger row is what is matched', () => {
    expect(pickInstall('it-tools', 'vops-sw-5', [install('it-tools', 'vops-sw-5')]).host).toBe('vops-sw-5');
  });

  it('names the hosts that do carry it when --host names one that does not', () => {
    const err = refusalOf(() => pickInstall('it-tools', 'typo', two));
    expect(err.code).toBe('VOPS_APP_NOT_FOUND');
    expect(err.message).toContain("host 'typo'");
    expect(err.suggestedAction).toContain('vops-sw-5, web1');
  });

  it('still reports an unknown name as not found', () => {
    expect(() => pickInstall('nope', 'web1', [])).toThrow(/No app install named 'nope'/);
  });

  it('treats an empty --host as none given rather than as a host called ""', () => {
    expect(pickInstall('it-tools', '', [install('it-tools', 'web1')]).host).toBe('web1');
  });
});

describe('app remove --host — the way out of a collision', () => {
  function svc(store: unknown, inventory: string[]): VopsAppsService {
    const hosts = { get: (n: string) => (inventory.includes(n) ? { name: n } : undefined) };
    return new VopsAppsService(hosts as never, {} as never, {} as never, {} as never, store as never, {} as never);
  }

  const collided = [install('it-tools', 'vops-sw-5'), install('it-tools', 'web1')];

  it('refuses a bare name that two hosts carry', async () => {
    const store = { findInstalls: async () => collided };
    await expect(svc(store, ['web1']).remove('it-tools', { purge: true })).rejects.toThrow(/installed on 2 hosts/);
  });

  it('forgets exactly the collided install whose host is gone, leaving the other', async () => {
    const deleted: string[] = [];
    const store = {
      findInstalls: async () => collided,
      deleteInstall: async (h: string, n: string) => {
        deleted.push(`${n}@${h}`);
      },
      appendAudit: async () => {},
    };

    const res = await svc(store, ['web1']).remove('it-tools', { purge: true }, 'vops-sw-5');
    expect(res).toEqual({ removed: true, purge: false, host: 'vops-sw-5', orphaned: true });
    expect(deleted).toEqual(['it-tools@vops-sw-5']);
  });
});
