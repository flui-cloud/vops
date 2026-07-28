import { getCatalogEntry, loadCatalog } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';

describe('catalog', () => {
  it('loads the bundled catalog', () => {
    const ids = loadCatalog().map((e) => e.id);
    expect(ids).toContain('it-tools');
    expect(ids).toContain('wordpress-composed');
  });
});

describe('normalize standalone (it-tools)', () => {
  const plan = normalizeManifest(getCatalogEntry('it-tools')!.manifest);

  it('is a single-component rootful plan with no pod', () => {
    expect(plan.kind).toBe('standalone');
    expect(plan.mode).toBe('rootful');
    expect(plan.pod).toBeUndefined();
    expect(plan.components).toHaveLength(1);
    expect(plan.primary).toBe('app');
  });

  it('maps image, exposed port and cpu/memory limits', () => {
    const c = plan.components[0];
    expect(c.container).toBe('vops-it-tools-app');
    expect(c.image).toBe('docker.io/corentinth/it-tools:2024.10.22-7ca5933');
    expect(c.ports[0]).toMatchObject({ container: 80, expose: true, protocol: 'http' });
    expect(c.memory).toBe('128m'); // 128Mi
    expect(c.cpu).toBe('0.3'); // 300m
  });
});

describe('normalize standalone with a volume (uptime-kuma)', () => {
  const plan = normalizeManifest(getCatalogEntry('uptime-kuma')!.manifest);

  it('namespaces the volume and keeps the plain env', () => {
    const c = plan.components[0];
    expect(c.volumes[0]).toMatchObject({ volume: 'vops-uptime-kuma-app-data', mountPath: '/app/data' });
    expect(c.env).toEqual([{ name: 'TZ', value: 'UTC' }]);
    expect(c.secrets).toEqual([]);
  });
});

describe('normalize composed (wordpress) — templating + generated secrets', () => {
  const plan = normalizeManifest(getCatalogEntry('wordpress-composed')!.manifest);

  it('builds a pod and two components with dependency order', () => {
    expect(plan.kind).toBe('composed');
    expect(plan.pod).toBe('vops-wordpress-composed');
    expect(plan.components.map((c) => c.name).sort()).toEqual(['db', 'web']);
    const web = plan.components.find((c) => c.name === 'web')!;
    expect(web.dependsOn).toContain('db');
    expect(plan.primary).toBe('web'); // the http-exposed one
  });

  it('generates the DB password as a host-side secret on db', () => {
    const db = plan.components.find((c) => c.name === 'db')!;
    const pw = db.secrets.find((s) => s.target === 'MARIADB_PASSWORD');
    expect(pw).toBeDefined();
    expect(pw!.generate).toMatchObject({ length: 32 });
    expect(pw!.name).toBe('vops-wordpress-composed-db-mariadb-password');
  });

  it('resolves {{components.db.host}} to loopback (pod shares the netns)', () => {
    const web = plan.components.find((c) => c.name === 'web')!;
    const dbHost = web.env.find((e) => e.name === 'WORDPRESS_DB_HOST');
    expect(dbHost!.value).toBe('127.0.0.1:3306');
  });

  it('injects db’s generated secret into web instead of a plain env', () => {
    const web = plan.components.find((c) => c.name === 'web')!;
    // WORDPRESS_DB_PASSWORD references {{components.db.env.MARIADB_PASSWORD}} (a secret)
    expect(web.env.find((e) => e.name === 'WORDPRESS_DB_PASSWORD')).toBeUndefined();
    const injected = web.secrets.find((s) => s.target === 'WORDPRESS_DB_PASSWORD');
    expect(injected).toBeDefined();
    expect(injected!.name).toBe('vops-wordpress-composed-db-mariadb-password');
    // plain-value template resolves literally
    expect(web.env.find((e) => e.name === 'WORDPRESS_DB_NAME')!.value).toBe('wordpress');
  });
});
