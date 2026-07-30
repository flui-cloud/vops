import { AppInstallV1 } from '../src/apps/app.model';
import { removeApp } from '../src/apps/app-lifecycle';
import { redeployBaseline } from '../src/apps/install-ledger';
import { VopsAppsService } from '../src/apps/vops-apps.service';
import { VopsIngressService } from '../src/apps/vops-ingress.service';
import { VopsHost } from '../src/hosts/host.model';

/**
 * The install row is claimed as `installing` before the first host mutation and confirmed on
 * success. Written only on success, an install killed mid-flight (Ctrl-C on a slow pull, a dropped
 * connection, the runner's SIGHUP) leaves a pod, units, volumes and secrets on the host that vops
 * never recorded — `app remove --purge` answering VOPS_APP_NOT_FOUND while all of it is live, and
 * the leftovers going by hand over SSH.
 *
 * The other half of that bargain, pinned here too: a failure whose rollback DID put the host back
 * must take the row with it, so `app list` shows nothing afterwards.
 */

const host = { name: 'box', address: '203.0.113.9', opsKeyInstalled: false, userKeyName: 'k' } as VopsHost;

const PREFLIGHT = [
  '@@podman', 'podman version 5.4.2',
  '@@quadlet', '/usr/lib/systemd/system-generators/podman-system-generator',
  '@@k3s', 'inactive',
  '@@selinux', 'no',
  '@@arch', 'x86_64',
  '@@ports', '0.0.0.0:22',
  '@@diskkb', '52428800',
  '@@networks', 'podman',
].join('\n');

/** In-memory stand-in for the (host, name)-keyed install ledger. */
function fakeStore() {
  const rows = new Map<string, AppInstallV1>();
  const key = (h: string, n: string) => `${h}/${n}`;
  return {
    rows,
    row: (name = 'vaultwarden') => rows.get(key('box', name)),
    saveInstall: async (i: AppInstallV1) => void rows.set(key(i.host, i.name), JSON.parse(JSON.stringify(i))),
    getInstall: async (h: string, n: string) => rows.get(key(h, n)) ?? null,
    findInstalls: async (n: string) => [...rows.values()].filter((i) => i.name === n),
    listInstalls: async () => [...rows.values()],
    deleteInstall: async (h: string, n: string) => void rows.delete(key(h, n)),
    appendAudit: async () => undefined,
  };
}

interface SshOptions {
  /** Deploy-script outcome: `active` units + `@@ok`, or a unit that never came up. */
  deployOk?: boolean;
  /** HTTP status the smoke probe reads back. */
  smokeCode?: string;
  /** Called with a snapshot of the ledger the moment the first host-mutating script runs. */
  onFirstMutation?: (row: AppInstallV1 | undefined) => void;
}

function fakeSsh(store: ReturnType<typeof fakeStore>, o: SshOptions = {}) {
  const scripts: string[] = [];
  let mutated = false;
  const ssh = {
    runScript: async (_t: unknown, script: string) => {
      scripts.push(script);
      if (script.includes('@@podman')) return { stdout: PREFLIGHT, stderr: '', code: 0 };
      if (script.includes('@@existing')) return { stdout: '@@existing\n@@done', stderr: '', code: 0 };
      if (!mutated && (script.includes('@@pull') || script.includes('@@started'))) {
        mutated = true;
        o.onFirstMutation?.(store.row());
      }
      if (script.includes('@@pull')) return { stdout: '@@pull\npulled x\n@@done', stderr: '', code: 0 };
      if (script.includes('@@started')) {
        const units = o.deployOk === false ? 'vops-vaultwarden-app.service=activating' : 'vops-vaultwarden-app.service=active';
        return { stdout: `@@started\n${units}\n@@diag\n@@ok\n`, stderr: '', code: 0 };
      }
      if (script.includes('@@http')) return { stdout: `@@http\n${o.smokeCode ?? '200'}`, stderr: '', code: 0 };
      if (script.includes('@@ps')) return { stdout: '@@ps\nvops-vaultwarden-app | Up |\n@@log\nboom', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  return { ssh, scripts };
}

function service(store: ReturnType<typeof fakeStore>, ssh: unknown) {
  const real = new VopsIngressService(null as any, null as any, null as any, null as any, null as any, null as any);
  return new VopsAppsService(
    { show: () => host, get: () => host } as any,
    { keyPathFor: () => '/tmp/id_ed25519', list: () => [] } as any,
    { assertReady: async () => undefined } as any,
    ssh as any,
    store as any,
    {
      resolveBinding: (p: any, h: any, opt: any) => real.resolveBinding(p, h, opt),
      preflightDns: async () => null,
      discardDnsRecord: async () => undefined,
    } as any,
  );
}

const deployed = (over: Partial<AppInstallV1> = {}): AppInstallV1 => ({
  version: 1,
  name: 'vaultwarden',
  appId: 'vaultwarden',
  displayName: 'Vaultwarden',
  host: 'box',
  mode: 'rootful',
  kind: 'standalone',
  primary: 'app',
  components: [{ name: 'app', container: 'vops-vaultwarden-app', image: 'docker.io/vaultwarden/server:1.35.7', published: [{ host: 20000, container: 80, bind: '127.0.0.1' }] }],
  units: { 'vops-vaultwarden-app.container': '[Container]\nImage=old\n' },
  secrets: [],
  volumes: [],
  endpoints: [{ component: 'app', port: 20000, url: 'http://127.0.0.1:20000', reach: 'loopback' }],
  status: 'deployed',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

describe('an interrupted install is recorded, so it can be found and removed', () => {
  it('claims the row as `installing` before the first host mutation, with everything remove needs', async () => {
    const store = fakeStore();
    let claimed: AppInstallV1 | undefined;
    const { ssh } = fakeSsh(store, { onFirstMutation: (row) => { claimed = row; } });

    await service(store, ssh).deploy({ catalog: 'vaultwarden' }, 'box', {});

    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe('installing');
    expect(claimed!.host).toBe('box');
    expect(claimed!.volumes).toEqual(['vops-vaultwarden-app-data']);
    expect(claimed!.secrets.length).toBeGreaterThan(0);
    expect(Object.keys(claimed!.units)).toContain('vops-vaultwarden-app.container');
    expect(claimed!.components[0].container).toBe('vops-vaultwarden-app');
  });

  it('confirms the same row as `deployed` once the install completes', async () => {
    const store = fakeStore();
    const { ssh } = fakeSsh(store);

    const res: any = await service(store, ssh).deploy({ catalog: 'vaultwarden' }, 'box', {});

    expect(res.status).toBe('deployed');
    expect(store.rows.size).toBe(1);
    expect(store.row()!.status).toBe('deployed');
  });

  it('lets `app remove --purge` clean exactly what the interrupted run created', async () => {
    const store = fakeStore();
    let claimed: AppInstallV1 | undefined;
    const { ssh } = fakeSsh(store, { onFirstMutation: (row) => { claimed = row; } });
    await service(store, ssh).deploy({ catalog: 'vaultwarden' }, 'box', {});

    // The process is killed here: the ledger keeps exactly the row it had at that moment.
    const killed = fakeStore();
    await killed.saveInstall(claimed!);
    const scripts: string[] = [];
    const deps = {
      hosts: { get: () => host, show: () => host },
      keys: { keyPathFor: () => '/tmp/id_ed25519', list: () => [] },
      store: killed,
      ssh: { runScript: async (_t: unknown, s: string) => { scripts.push(s); return { stdout: '@@removed', stderr: '', code: 0 }; } },
    } as any;

    expect(await removeApp(deps, 'vaultwarden', { purge: true })).toEqual({ removed: true, purge: true, host: 'box' });
    const rm = scripts.join('\n');
    expect(rm).toContain(`podman rm -f 'vops-vaultwarden-app'`);
    expect(rm).toContain(`podman volume rm 'vops-vaultwarden-app-data'`);
    expect(rm).toContain(`podman secret rm '${claimed!.secrets[0]}'`);
    expect(rm).toContain('/etc/containers/systemd/vops/vaultwarden');
    expect(killed.rows.size).toBe(0);
  });
});

describe('non-regression — a rollback takes the ledger row with it', () => {
  it('leaves no row behind when a first install fails and the host is put back', async () => {
    const store = fakeStore();
    const { ssh } = fakeSsh(store, { smokeCode: '500' });

    await expect(service(store, ssh).deploy({ catalog: 'vaultwarden' }, 'box', {})).rejects.toThrow(/Smoke test failed/);
    expect(store.rows.size).toBe(0);
  });

  it('leaves no row behind when the units never come up either', async () => {
    const store = fakeStore();
    const { ssh } = fakeSsh(store, { deployOk: false });

    await expect(service(store, ssh).deploy({ catalog: 'vaultwarden' }, 'box', {})).rejects.toThrow(/Deploy failed/);
    expect(store.rows.size).toBe(0);
  });

  it('restores the previous record when a REDEPLOY fails', async () => {
    const store = fakeStore();
    await store.saveInstall(deployed());
    const { ssh } = fakeSsh(store, { smokeCode: '500' });

    await expect(service(store, ssh).deploy({ catalog: 'vaultwarden' }, 'box', {})).rejects.toThrow(/Smoke test failed/);
    expect(store.row()!.status).toBe('deployed');
    expect(store.row()!.units['vops-vaultwarden-app.container']).toContain('Image=old');
  });

  it('keeps the row when the debug hatch deliberately leaves the app running', async () => {
    const store = fakeStore();
    const { ssh } = fakeSsh(store, { smokeCode: '500' });
    process.env.VOPS_APP_NO_ROLLBACK = '1';
    try {
      await expect(service(store, ssh).deploy({ catalog: 'vaultwarden' }, 'box', {})).rejects.toThrow(/Left running/);
    } finally {
      delete process.env.VOPS_APP_NO_ROLLBACK;
    }
    expect(store.row()!.status).toBe('installing');
  });

  it('never treats a row left by an interrupted install as a redeploy baseline', async () => {
    // Restoring its units would put the failed attempt back and its volumes would go unpurged.
    expect(redeployBaseline(deployed({ status: 'installing' }))).toBeNull();
    expect(redeployBaseline(deployed())).not.toBeNull();
    expect(redeployBaseline(null)).toBeNull();

    const store = fakeStore();
    await store.saveInstall(deployed({ status: 'installing' }));
    const { ssh, scripts } = fakeSsh(store, { smokeCode: '500' });

    await expect(service(store, ssh).deploy({ catalog: 'vaultwarden' }, 'box', {})).rejects.toThrow(/Smoke test failed/);
    expect(scripts.some((s) => s.includes('@@existing'))).toBe(true);
    expect(scripts.some((s) => s.includes('@@removed'))).toBe(true);
    // The retry's own artefacts are gone, and the earlier attempt's row stays: still removable.
    expect(store.row()!.status).toBe('installing');
  });
});
