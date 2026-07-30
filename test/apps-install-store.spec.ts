import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStore } from '../src/lib/store/local-store';
import { resolveInstall } from '../src/apps/app-resolve';
import { AppInstallV1 } from '../src/apps/app.model';

// Keyed by name alone, deploying an app on a second host overwrites the first host's record
// (silent inventory loss) and hands the new install the other host's ports and ingress hostname.

const V4_SCHEMA = `CREATE TABLE app_installs (
   name TEXT PRIMARY KEY,
   host TEXT NOT NULL,
   app_id TEXT NOT NULL,
   status TEXT NOT NULL,
   updated_at TEXT NOT NULL,
   record TEXT NOT NULL
 )`;

function install(host: string, name: string, port: number): AppInstallV1 {
  return {
    name,
    host,
    appId: name,
    kind: 'App',
    mode: 'podman',
    status: 'deployed',
    updatedAt: '2026-07-29T00:00:00.000Z',
    components: [{ name: 'app', image: 'x:1', container: `vops-${name}-app`, published: [{ host: port, container: 3000, bind: '127.0.0.1' }] }],
    endpoints: [{ component: 'app', port, url: `http://127.0.0.1:${port}`, reach: 'loopback' }],
    secrets: [],
    volumes: [],
    units: {},
  } as unknown as AppInstallV1;
}

describe('app install store — keyed by (host, name)', () => {
  let dir: string;
  let store: LocalStore;
  const prevEnv = process.env.VOPS_CONFIG_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-f39-'));
    process.env.VOPS_CONFIG_DIR = dir;
    store = new LocalStore();
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    if (prevEnv === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps both installs when the same app name is deployed on two hosts', async () => {
    await store.saveInstall(install('hostA', 'gitea', 20002));
    await store.saveInstall(install('hostB', 'gitea', 20000));

    expect((await store.getInstall('hostA', 'gitea'))?.endpoints[0].port).toBe(20002);
    expect((await store.getInstall('hostB', 'gitea'))?.endpoints[0].port).toBe(20000);
    expect((await store.listInstalls()).map((i) => i.host).sort()).toEqual(['hostA', 'hostB']);
  });

  it('has no previous install to inherit ports from on a host that never ran the app', async () => {
    await store.saveInstall(install('hostA', 'gitea', 20002));
    expect(await store.getInstall('hostB', 'gitea')).toBeNull();
  });

  it('removes only the install on the named host', async () => {
    await store.saveInstall(install('hostA', 'gitea', 20002));
    await store.saveInstall(install('hostB', 'gitea', 20000));

    await store.deleteInstall('hostB', 'gitea');
    expect(await store.getInstall('hostA', 'gitea')).not.toBeNull();
    expect(await store.getInstall('hostB', 'gitea')).toBeNull();
  });

  it('resolves a bare name when one host holds it and refuses when several do', async () => {
    await store.saveInstall(install('hostA', 'gitea', 20002));
    expect((await resolveInstall(store, 'gitea')).host).toBe('hostA');

    await store.saveInstall(install('hostB', 'gitea', 20000));
    await expect(resolveInstall(store, 'gitea')).rejects.toThrow(/installed on 2 hosts \(hostA, hostB\)/);
    await expect(resolveInstall(store, 'nope')).rejects.toThrow(/No app install named 'nope'/);
  });

  it('migrates a v4 name-keyed table without losing a row', async () => {
    fs.mkdirSync(path.join(dir, 'profiles', 'default'), { recursive: true });
    const legacy = createClient({ url: `file:${path.join(dir, 'profiles', 'default', 'vops.db')}` });
    await legacy.execute(V4_SCHEMA);
    const rows = [install('hostA', 'gitea', 20002), install('vmi', 'firefly-iii', 20003), install('vmi', 'wordpress', 20004)];
    for (const r of rows) {
      await legacy.execute({
        sql: 'INSERT INTO app_installs (name, host, app_id, status, updated_at, record) VALUES (?, ?, ?, ?, ?, ?)',
        args: [r.name, r.host, r.appId, r.status, r.updatedAt, JSON.stringify(r)],
      });
    }
    await legacy.execute('PRAGMA user_version = 4');
    legacy.close();

    const summaries = await store.listInstalls();
    expect(summaries.map((s) => `${s.host}/${s.name}`).sort()).toEqual(['hostA/gitea', 'vmi/firefly-iii', 'vmi/wordpress']);
    expect((await store.getInstall('hostA', 'gitea'))?.endpoints[0].port).toBe(20002);

    // and the rebuilt table now admits the same name on a second host
    await store.saveInstall(install('hostB', 'gitea', 20000));
    expect(await store.listInstalls()).toHaveLength(4);
  });

  it('is idempotent — a second open of an already-migrated store keeps every row', async () => {
    await store.saveInstall(install('hostA', 'gitea', 20002));
    await store.saveInstall(install('hostB', 'gitea', 20000));
    await store.onModuleDestroy();

    const again = new LocalStore();
    try {
      expect(await again.listInstalls()).toHaveLength(2);
    } finally {
      await again.onModuleDestroy();
    }
  });
});
