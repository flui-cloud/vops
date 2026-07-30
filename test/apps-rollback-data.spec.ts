import { buildDataProbeScript, dataCreatedInRun, parseDataProbe, reusedDataNote } from '../src/apps/app-data-guard';
import { gateOrRollback, probeAppData } from '../src/apps/app-rollback';
import { removeApp } from '../src/apps/app-lifecycle';

/**
 * A first install that fails its smoke test has to take the `vops-<app>-*` volumes and secrets it
 * just created along with the units and containers. Stranding them while the install vanishes from
 * the inventory makes every retry boot a database on a datadir provisioned with the previous run's
 * credentials, failing forever with nothing naming the cause.
 *
 * So the rollback removes exactly what THAT execution created — and nothing it merely found,
 * because data a user deliberately kept through a non-purging `app remove` is worse to lose than
 * any stranded volume.
 */
const plan = {
  name: 'wb',
  primary: 'app',
  smokeTest: { type: 'http', path: '/', expectedStatus: 200, timeoutSeconds: 1 },
  components: [
    { name: 'db', container: 'vops-wb-db', image: 'mariadb:11' },
    { name: 'app', container: 'vops-wb-app', image: 'wallabag:2.6.14' },
  ],
} as any;

const hp = {
  unitDir: '/etc/containers/systemd/vops/wb',
  services: ['vops-wb-db.service', 'vops-wb-app.service'],
  prereqServices: ['vops-wb-db-data-volume.service', 'vops-wb-pod.service'],
  volumes: ['vops-wb-db-data', 'vops-wb-app-images'],
  secrets: [{ name: 'vops-wb-db-mariadb-root-password' }, { name: 'vops-wb-app-symfony-env-secret' }],
  pod: 'vops-wb',
  ports: { app: [{ host: 20000, container: 80 }] },
} as any;

const DEPLOY_OK = '@@started\nvops-wb-db.service=active\nvops-wb-app.service=active\n@@diag\n@@ok\n';

function runner(existing: string[] = []) {
  const scripts: string[] = [];
  const ssh = {
    runScript: async (_t: unknown, script: string) => {
      scripts.push(script);
      if (script.includes('@@existing')) return { stdout: ['@@existing', ...existing, '@@done'].join('\n'), stderr: '', code: 0 };
      if (script.includes('@@http')) return { stdout: '@@http\n500', stderr: '', code: 0 };
      if (script.includes('@@ps')) return { stdout: '@@ps\nvops-wb-app | Up | \n@@log\nHTTP 500', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  return { r: { ssh, target: { host: { name: 'h1' } } } as any, scripts };
}

const removeScript = (scripts: string[]) => scripts.find((s) => s.includes('@@removed')) ?? '';

describe('a failed first install takes its own volumes and secrets with it', () => {
  it('removes the volumes + secrets that run created, so the retry starts on a clean datadir', async () => {
    const { r, scripts } = runner();
    const pre = await probeAppData(r, hp);
    expect(pre).toEqual({ ran: true, volumes: [], secrets: [] });

    await expect(gateOrRollback(r, { plan, hp, prev: null, generator: '/g', preexisting: pre }, { stdout: DEPLOY_OK, stderr: '' }))
      .rejects.toThrow(/Smoke test failed/);

    const rm = removeScript(scripts);
    expect(rm).toContain(`podman volume rm 'vops-wb-db-data'`);
    expect(rm).toContain(`podman volume rm 'vops-wb-app-images'`);
    expect(rm).toContain(`podman secret rm 'vops-wb-db-mariadb-root-password'`);
    expect(rm).toContain(`podman secret rm 'vops-wb-app-symfony-env-secret'`);
  });

  it('never removes data it found on the host, and names it in the failure instead', async () => {
    const { r, scripts } = runner(['volume vops-wb-db-data', 'secret vops-wb-db-mariadb-root-password']);
    const pre = await probeAppData(r, hp);

    let message = '';
    try {
      await gateOrRollback(r, { plan, hp, prev: null, generator: '/g', preexisting: pre }, { stdout: DEPLOY_OK, stderr: '' });
    } catch (e) {
      message = (e as Error).message;
    }

    const rm = removeScript(scripts);
    expect(rm).not.toContain(`podman volume rm 'vops-wb-db-data'`);
    expect(rm).not.toContain(`podman secret rm 'vops-wb-db-mariadb-root-password'`);
    // What this run did create still goes.
    expect(rm).toContain(`podman volume rm 'vops-wb-app-images'`);

    expect(message).toContain('vops-wb-db-data');
    expect(message).toContain('podman volume rm vops-wb-db-data');
    expect(message).toContain('podman secret rm vops-wb-db-mariadb-root-password');
  });

  it('deletes nothing when the probe did not complete — unknown is not "the host was empty"', async () => {
    const { r, scripts } = runner();
    const pre = parseDataProbe('@@existing\nvolume vops-wb-db-data\n'); // no @@done: truncated
    expect(pre.ran).toBe(false);

    await expect(gateOrRollback(r, { plan, hp, prev: null, generator: '/g', preexisting: pre }, { stdout: DEPLOY_OK, stderr: '' }))
      .rejects.toThrow(/Smoke test failed/);
    const rm = removeScript(scripts);
    expect(rm).not.toContain('podman volume rm');
    expect(rm).not.toContain('podman secret rm');
  });

  it('a failed REDEPLOY still restores the previous units and touches no data', async () => {
    const { r, scripts } = runner();
    const prev = {
      name: 'wb',
      units: { 'vops-wb-app.container': '[Container]\n' },
      components: [{ name: 'app', container: 'vops-wb-app' }],
      volumes: ['vops-wb-db-data'],
      pod: 'vops-wb',
    } as any;

    await expect(gateOrRollback(r, { plan, hp, prev, generator: '/g', preexisting: { ran: true, volumes: [], secrets: [] } }, { stdout: DEPLOY_OK, stderr: '' }))
      .rejects.toThrow(/Smoke test failed/);

    expect(removeScript(scripts)).toBe('');
    expect(scripts.some((s) => s.includes('vops-wb-app.container'))).toBe(true);
    expect(scripts.join('\n')).not.toContain('podman volume rm');
  });
});

describe('non-regression — `app remove` without --purge keeps a real install\'s data', () => {
  it('tears down units and containers but no volume or secret', async () => {
    const scripts: string[] = [];
    const install = {
      name: 'wb',
      host: 'h1',
      components: [{ name: 'app', container: 'vops-wb-app' }],
      volumes: ['vops-wb-db-data'],
      secrets: ['vops-wb-db-mariadb-root-password'],
      pod: 'vops-wb',
    };
    const host = { name: 'h1', address: '1.2.3.4', userKeyName: 'k' };
    const deps = {
      hosts: { get: () => host, show: () => host },
      keys: { keyPathFor: () => '/tmp/id_ed25519' },
      store: {
        findInstalls: async () => [install],
        deleteInstall: async () => {},
        appendAudit: async () => {},
      },
      ssh: {
        runScript: async (_t: unknown, script: string) => {
          scripts.push(script);
          return { stdout: '@@removed\nkept-data', stderr: '', code: 0 };
        },
      },
    } as any;

    const res = await removeApp(deps, 'wb', {});
    expect(res).toEqual({ removed: true, purge: false, host: 'h1' });
    const rm = removeScript(scripts);
    expect(rm).toContain(`podman rm -f 'vops-wb-app'`);
    expect(rm).toContain('kept-data');
    expect(rm).not.toContain('podman volume rm');
    expect(rm).not.toContain('podman secret rm');
  });
});

describe('app data probe — pure parts', () => {
  it('probes only the app\'s own planned volumes and secrets', () => {
    const s = buildDataProbeScript(['vops-wb-db-data'], ['vops-wb-db-mariadb-root-password']);
    expect(s).toContain(`podman volume inspect 'vops-wb-db-data'`);
    expect(s).toContain(`podman secret inspect 'vops-wb-db-mariadb-root-password'`);
    expect(s).not.toContain('podman volume ls');
  });

  it('splits found from created', () => {
    const pre = parseDataProbe('@@existing\nvolume a\nsecret s1\n@@done');
    expect(pre).toEqual({ ran: true, volumes: ['a'], secrets: ['s1'] });
    expect(dataCreatedInRun({ volumes: ['a', 'b'], secrets: ['s1', 's2'] }, pre)).toEqual({ volumes: ['b'], secrets: ['s2'] });
  });

  it('says nothing when there was nothing to inherit', () => {
    expect(reusedDataNote({ ran: true, volumes: [], secrets: [] })).toBe('');
  });
});
