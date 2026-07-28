import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { planHostDeploy } from '../src/apps/app-plan';
import { HostFacts, parseCertProbe, parseIngressInstall, parseIngressPrecheck, parseIngressStatus } from '../src/apps/app-parse';
import { AppComponentPlan, AppPlan, IngressBinding } from '../src/apps/app.model';
import {
  renderIngressContainer,
  renderRoute,
  renderTraefikStatic,
} from '../src/apps/ingress-render';
import { buildIngressStatusScript } from '../src/apps/ingress-scripts';
import { assertValidHostname, isSslip, isValidFqdn, pickZone, recordName, routedPorts, sslipHostname } from '../src/apps/ingress-hostname';
import { ensureARecord, previewARecord } from '../src/apps/ingress-dns';
import { DnsConflictError } from '../src/apps/ingress-dns-plan';

function facts(over: Partial<HostFacts> = {}): HostFacts {
  return {
    podmanVersion: '5.8.4',
    quadletGenerator: '/usr/local/lib/systemd/system-generators/podman-system-generator',
    k3s: false,
    selinux: false,
    arch: 'x86_64',
    listeningPorts: new Set([22]),
    freeKb: 10_000_000,
    networks: ['podman'],
    ...over,
  };
}

const bind = (over: Partial<IngressBinding> = {}): IngressBinding => ({
  hostname: 'tools.example.com', tls: true, exposeDirect: false,
  routes: [{ component: 'app', containerPort: 80, path: '/', stripPrefix: false }], ...over,
});

describe('ingress-render — Traefik static config', () => {
  const cfg = renderTraefikStatic({ email: 'ops@example.com' });
  it('declares web/websecure/ping entrypoints and a file provider that watches', () => {
    expect(cfg).toContain('web:\n    address: ":80"');
    expect(cfg).toContain('websecure:\n    address: ":443"');
    expect(cfg).toContain('127.0.0.1:8099');
    expect(cfg).toContain('directory: /etc/vops/ingress/dynamic');
    expect(cfg).toContain('watch: true');
  });
  it('has two ACME resolvers with SEPARATE storage and http-01 on web', () => {
    expect(cfg).toContain('le:\n    acme:');
    expect(cfg).toContain('storage: /etc/vops/ingress/acme.json');
    expect(cfg).toContain('le-staging:\n    acme:');
    expect(cfg).toContain('storage: /etc/vops/ingress/acme-staging.json');
    expect(cfg).toContain('acme-staging-v02.api.letsencrypt.org');
    expect(cfg).toContain('entryPoint: web');
  });
  it('overrides the prod resolver caServer for a private ACME (Pebble)', () => {
    const p = renderTraefikStatic({ email: 'ops@example.com', caServer: 'https://pebble:14000/dir' });
    expect(p).toContain('caServer: "https://pebble:14000/dir"');
  });
});

describe('ingress-render — route file', () => {
  const root = [{ hostPort: 20001, path: '/', stripPrefix: false }];
  it('plain-HTTP route targets the loopback backend on the web entrypoint', () => {
    const r = renderRoute({ app: 'tools', hostname: 'tools.example.com', tls: false, certResolver: 'le', routes: root });
    expect(r).toContain('Host(`tools.example.com`)');
    expect(r).toContain('entryPoints: [web]');
    expect(r).toContain('url: "http://127.0.0.1:20001"');
    expect(r).not.toContain('certResolver');
    expect(r).not.toContain('redirectScheme');
  });
  it('TLS route uses websecure + certResolver and adds an http→https redirect', () => {
    const r = renderRoute({ app: 'tools', hostname: 'tools.example.com', tls: true, certResolver: 'le', routes: root });
    expect(r).toContain('entryPoints: [websecure]');
    expect(r).toContain('certResolver: le');
    expect(r).toContain('entryPoints: [web]'); // the redirect router
    expect(r).toContain('redirectScheme');
    expect(r).toContain('scheme: https');
  });
  it('multi-route: web at / + api at /api (PathPrefix, own service, optional strip)', () => {
    const r = renderRoute({
      app: 'stack', hostname: 'app.example.com', tls: true, certResolver: 'le',
      routes: [
        { hostPort: 20001, path: '/', stripPrefix: false },
        { hostPort: 20002, path: '/api', stripPrefix: true },
      ],
    });
    expect(r).toContain('rule: "Host(`app.example.com`)"');
    expect(r).toContain('rule: "Host(`app.example.com`) && PathPrefix(`/api`)"');
    expect(r).toContain('vops-stack-api:');            // per-route router/service
    expect(r).toContain('url: "http://127.0.0.1:20002"');
    expect(r).toContain('vops-stack-api-strip:');       // stripPrefix middleware
    expect(r).toContain('prefixes: [/api]');
    expect(r).toContain('vops-https-redirect');         // one redirect for the host
  });
});

describe('ingress-render — basic-auth middleware', () => {
  const hash = '$2b$12$H.UWvAr0oXzzYyj3x.hOpeuzCdS3Xaa9ydekTKLXT/LAq483VTwHK';
  const root = [{ hostPort: 20001, path: '/', stripPrefix: false }];
  it('adds a basicAuth middleware on the app router but NOT the http→https redirect', () => {
    const r = renderRoute({ app: 'tools', hostname: 'tools.example.com', tls: true, certResolver: 'le', routes: root, auth: { user: 'admin', hash } });
    expect(r).toContain('vops-tools-auth:');
    expect(r).toContain('basicAuth:');
    expect(r).toContain(`- "admin:${hash}"`);
    expect(r).toContain('middlewares: [vops-tools-auth]');   // the app router is gated
    expect(r).toContain('middlewares: [vops-https-redirect]'); // the redirect router is not
  });
  it('composes the gate with a stripPrefix middleware on the same router', () => {
    const r = renderRoute({
      app: 'stack', hostname: 'app.example.com', tls: true, certResolver: 'le',
      routes: [{ hostPort: 20002, path: '/api', stripPrefix: true }],
      auth: { user: 'admin', hash },
    });
    expect(r).toContain('middlewares: [vops-stack-api-strip, vops-stack-auth]');
  });
  it('refuses an unsafe username / malformed hash before rendering', () => {
    expect(() => renderRoute({ app: 'x', hostname: 'h', tls: true, certResolver: 'le', routes: root, auth: { user: 'a b', hash } })).toThrow();
    expect(() => renderRoute({ app: 'x', hostname: 'h', tls: true, certResolver: 'le', routes: root, auth: { user: 'admin', hash: 'nope' } })).toThrow();
  });
});

describe('ingress-render — Traefik container unit', () => {
  it('is a host-network container mounting the config DIR, no auto-update', () => {
    const u = renderIngressContainer({ selinux: false });
    expect(u).toContain('Network=host');
    expect(u).toContain('Volume=/etc/vops/ingress:/etc/vops/ingress');
    expect(u).toContain('Exec=--configFile=/etc/vops/ingress/traefik.yml');
    expect(u).toContain('WantedBy=multi-user.target');
    expect(u).not.toContain('AutoUpdate');
  });
  it('adds :Z on SELinux and LEGO_CA env for a test CA', () => {
    const u = renderIngressContainer({ selinux: true, env: { LEGO_CA_CERTIFICATES: '/etc/vops/ingress/pebble.pem' } });
    expect(u).toContain('Volume=/etc/vops/ingress:/etc/vops/ingress:Z');
    expect(u).toContain('Environment=LEGO_CA_CERTIFICATES=/etc/vops/ingress/pebble.pem');
  });
});

describe('ingress-hostname', () => {
  it('derives an sslip.io host from an IPv4 and rejects non-IPv4', () => {
    expect(sslipHostname('203.0.113.9')).toBe('203-0-113-9.sslip.io');
    expect(() => sslipHostname('example.com')).toThrow();
    expect(isSslip('203-0-113-9.sslip.io')).toBe(true);
    expect(isSslip('app.example.com')).toBe(false);
  });
  it('prefixes with the install name so multiple apps on one host don’t collide', () => {
    expect(sslipHostname('203.0.113.9', 'bookstack')).toBe('bookstack.203-0-113-9.sslip.io');
    expect(sslipHostname('203.0.113.9', 'openclaw')).toBe('openclaw.203-0-113-9.sslip.io');
    // sanitized like every other install-derived name (lowercase, LDH-safe)
    expect(sslipHostname('203.0.113.9', 'My App!')).toBe('my-app.203-0-113-9.sslip.io');
    expect(isSslip('bookstack.203-0-113-9.sslip.io')).toBe(true);
  });
  it('validates FQDNs', () => {
    expect(isValidFqdn('app.example.com')).toBe(true);
    expect(isValidFqdn('not a domain')).toBe(false);
    expect(assertValidHostname('App.Example.COM')).toBe('app.example.com');
  });
  it('finds the routed port and matches zones by longest suffix', () => {
    const tools = normalizeManifest(getCatalogEntry('it-tools')!.manifest, 'tools');
    expect(routedPorts(tools)).toEqual([{ component: 'app', containerPort: 80, path: '/', stripPrefix: false }]);
    const zones = [{ name: 'example.com' }, { name: 'sub.example.com' }];
    expect(pickZone(zones, 'app.sub.example.com')!.name).toBe('sub.example.com');
    expect(recordName('app.sub.example.com', 'sub.example.com')).toBe('app');
    expect(recordName('example.com', 'example.com')).toBe('@');
  });
});

describe('planHostDeploy — ingress binding (loopback isolation)', () => {
  const tools = normalizeManifest(getCatalogEntry('it-tools')!.manifest, 'tools');
  it('binds the routed port to loopback, reports https, keeps it off 80/443', () => {
    const hp = planHostDeploy(tools, facts(), '203.0.113.9', bind());
    const unit = hp.units['vops-tools-app.container'];
    const port = hp.ports.app[0].host;
    expect(port).toBeGreaterThanOrEqual(20000); // forced high, never 80
    expect(unit).toContain(`PublishPort=127.0.0.1:${port}:80`);
    expect(hp.endpoints[0].url).toBe('https://tools.example.com');
  });
  it('--expose-direct keeps the routed port on 0.0.0.0', () => {
    const hp = planHostDeploy(tools, facts(), '203.0.113.9', bind({ exposeDirect: true }));
    const port = hp.ports.app[0].host;
    expect(hp.units['vops-tools-app.container']).toContain(`PublishPort=0.0.0.0:${port}:80`);
  });
  it('substitutes {{app.domain}} with the resolved hostname', () => {
    const vw = normalizeManifest(getCatalogEntry('vaultwarden')!.manifest, 'vw');
    expect(vw.needsAppDomain).toBe(true);
    const hp = planHostDeploy(vw, facts(), '203.0.113.9', bind({ hostname: 'vault.example.com' }));
    expect(hp.units['vops-vw-app.container']).toContain('Environment=DOMAIN=https://vault.example.com');
  });
});

function webApiPlan(): AppPlan {
  const comp = (name: string, container: number, route?: { path: string; stripPrefix: boolean }): AppComponentPlan => ({
    name, container: `vops-stack-${name}`, image: `docker.io/library/${name}:1`, env: [], secrets: [],
    ports: [{ name: 'http', container, expose: true, protocol: 'http', ...(route ? { route } : {}) }],
    volumes: [], dependsOn: [],
  });
  return {
    name: 'stack', appId: 'stack', displayName: 'Stack', kind: 'composed', mode: 'rootful', pod: 'vops-stack',
    components: [comp('web', 80), comp('api', 8080, { path: '/api', stripPrefix: true })],
    primary: 'web', needsAppDomain: false,
  };
}

describe('multi-route composed app (web + API)', () => {
  const plan = webApiPlan();
  it('routedPorts returns the primary root plus the API path route', () => {
    expect(routedPorts(plan)).toEqual([
      { component: 'web', containerPort: 80, path: '/', stripPrefix: false },
      { component: 'api', containerPort: 8080, path: '/api', stripPrefix: true },
    ]);
  });
  it('planHostDeploy loopback-binds BOTH routed ports and reports per-path https endpoints', () => {
    const binding: IngressBinding = {
      hostname: 'app.example.com', tls: true, exposeDirect: false,
      routes: routedPorts(plan).map((r) => ({ component: r.component, containerPort: r.containerPort, path: r.path, stripPrefix: r.stripPrefix })),
    };
    const hp = planHostDeploy(plan, facts(), '203.0.113.9', binding);
    const webPort = hp.ports.web[0].host;
    const apiPort = hp.ports.api[0].host;
    // Composed app → the pod unit owns PublishPort; both routed ports on loopback.
    const allUnits = Object.values(hp.units).join('\n');
    expect(allUnits).toContain(`PublishPort=127.0.0.1:${webPort}:80`);
    expect(allUnits).toContain(`PublishPort=127.0.0.1:${apiPort}:8080`);
    const urls = hp.endpoints.map((e) => e.url);
    expect(urls).toContain('https://app.example.com');
    expect(urls).toContain('https://app.example.com/api');
  });
  it('back-compat: a single-HTTP-port catalog app stays one root route', () => {
    const wp = normalizeManifest(getCatalogEntry('wordpress-composed')!.manifest, 'wp');
    expect(routedPorts(wp)).toEqual([{ component: 'web', containerPort: 80, path: '/', stripPrefix: false }]);
  });
});

describe('ingress parse helpers', () => {
  it('parseIngressPrecheck names the process holding :80', () => {
    const out = [
      '@@active', 'inactive',
      '@@unit', 'absent',
      '@@listen', '0.0.0.0:80\tusers:(("nginx",pid=7,fd=6))\n[::]:22\tusers:(("sshd",pid=1,fd=3))',
      '@@podman', 'podman version 5.8.4',
      '@@arch', 'x86_64',
      '@@selinux', 'no',
      '@@done',
    ].join('\n');
    const p = parseIngressPrecheck(out);
    expect(p.active).toBe(false);
    expect(p.port80).toBe('nginx');
    expect(p.port443).toBeNull();
    expect(p.podmanVersion).toBe('5.8.4');
  });
  it('parseIngressInstall is ok only when active and healthy', () => {
    expect(parseIngressInstall('@@pull\nok\n@@active\nactive\n@@health\nok\n@@diag\n@@done').ok).toBe(true);
    const bad = parseIngressInstall('@@pull\nok\n@@active\ninactive\n@@health\nfail\n@@diag\nboom\n@@done');
    expect(bad.ok).toBe(false);
    expect(bad.diag).toBe('boom');
  });
  it('parseIngressStatus lists routes and the ping code', () => {
    const s = parseIngressStatus('@@active\nactive\n@@container\nvops-ingress|Up 3m|traefik\n@@health\n200\n@@routes\ntools\nblog\n@@done');
    expect(s.active).toBe(true);
    expect(s.health).toBe(200);
    expect(s.routes).toEqual(['tools', 'blog']);
  });
  it('status script newline-terminates the health code so @@routes stays a marker', () => {
    // curl -w prints the code with no trailing newline; without the \n the next
    // `@@routes` line glues onto it (`200@@routes`) and splitSections loses routes.
    expect(buildIngressStatusScript()).toContain(String.raw`%{http_code}\n`);
  });
  it('parseCertProbe reports a stored cert and flags a hard ACME failure', () => {
    const issued = parseCertProbe('@@acme\n"main":"tools.example.com"\n@@log\nmsg="Adding certificate for domain(s) tools.example.com"\n@@done');
    expect(issued.issued).toBe(true);
    expect(issued.hardError).toBeNull();

    const rate = parseCertProbe('@@acme\n\n@@log\nUnable to obtain ACME certificate ... acme: error: 429 :: rateLimited :: too many certificates already issued\n@@done');
    expect(rate.issued).toBe(false);
    expect(rate.hardError).toContain('rateLimited');

    const pending = parseCertProbe('@@acme\n\n@@log\nStarting provider *acme.Provider\n@@done');
    expect(pending.issued).toBe(false);
    expect(pending.hardError).toBeNull();

    // Caddy/certmagic self-throttle is NOT a hard failure (it retries + succeeds).
    const throttled = parseCertProbe('@@acme\n\n@@log\n{"logger":"tls.issuance.acme","msg":"waiting on internal rate limiter"}\n@@done');
    expect(throttled.hardError).toBeNull();
  });
});

describe('ingress-dns — idempotent A-record upsert', () => {
  const A = 'A';
  function fakeFactory(zones: { name: string; zoneId: string }[], records: any[], log: any) {
    const svc = {
      listZones: async () => zones,
      listRecords: async () => records,
      createRecord: async (c: any) => { log.created.push(c); return { recordId: 'new', ...c }; },
      updateRecord: async (c: any) => { log.updated.push(c); return { recordId: c.recordId, ...c }; },
      deleteRecord: async () => { log.deleted += 1; },
    };
    return { getSupportedProviders: () => ['hetzner'], getDnsProvider: () => svc } as any;
  }

  it('creates the record when the zone owns the fqdn and none exists', async () => {
    const log = { created: [] as any[], updated: [] as any[], deleted: 0 };
    const f = fakeFactory([{ name: 'example.com', zoneId: 'z1' }], [], log);
    const rec = await ensureARecord(f, 'app.example.com', '203.0.113.9');
    expect(log.created[0]).toMatchObject({ zoneId: 'z1', name: 'app', value: '203.0.113.9' });
    expect(rec).toMatchObject({ provider: 'hetzner', zoneId: 'z1', name: 'app.example.com' });
  });
  it('reuses an existing record with the same value (no writes)', async () => {
    const log = { created: [] as any[], updated: [] as any[], deleted: 0 };
    const f = fakeFactory([{ name: 'example.com', zoneId: 'z1' }], [{ recordId: 'r9', type: A, name: 'app', value: '203.0.113.9' }], log);
    await ensureARecord(f, 'app.example.com', '203.0.113.9');
    expect(log.created).toHaveLength(0);
    expect(log.updated).toHaveLength(0);
  });
  it('REFUSES a name pointing elsewhere, and writes nothing', async () => {
    // A name serving something real would be silently destroyed, and DNS has no undo.
    const log = { created: [] as any[], updated: [] as any[], deleted: 0 };
    const f = fakeFactory([{ name: 'example.com', zoneId: 'z1' }], [{ recordId: 'r9', type: A, name: 'app', value: '9.9.9.9' }], log);
    await expect(ensureARecord(f, 'app.example.com', '203.0.113.9')).rejects.toBeInstanceOf(DnsConflictError);
    expect(log.deleted).toBe(0);
    expect(log.created).toHaveLength(0);
  });
  it('replaces a stale record only when explicitly forced (delete + create)', async () => {
    const log = { created: [] as any[], updated: [] as any[], deleted: 0 };
    const f = fakeFactory([{ name: 'example.com', zoneId: 'z1' }], [{ recordId: 'r9', type: A, name: 'app', value: '9.9.9.9' }], log);
    await ensureARecord(f, 'app.example.com', '203.0.113.9', { force: true });
    expect(log.deleted).toBe(1); // stale value removed (Hetzner encodes value in the id)
    expect(log.created[0]).toMatchObject({ name: 'app', value: '203.0.113.9' });
  });
  it('returns null when no zone matches, so a self-managed domain still deploys', async () => {
    const log = { created: [] as any[], updated: [] as any[], deleted: 0 };
    const none = fakeFactory([{ name: 'other.net', zoneId: 'z2' }], [], log);
    expect(await ensureARecord(none, 'app.example.com', '203.0.113.9')).toBeNull();
  });
  it('previews without writing anything', async () => {
    const log = { created: [] as any[], updated: [] as any[], deleted: 0 };
    const f = fakeFactory([{ name: 'example.com', zoneId: 'z1' }], [{ recordId: 'r9', type: A, name: 'app', value: '9.9.9.9' }], log);
    const { zone, plan } = await previewARecord(f, 'app.example.com', '203.0.113.9');
    expect(zone).toMatchObject({ zoneId: 'z1', name: 'app' });
    expect(plan?.action).toBe('conflict');
    expect(log.created).toHaveLength(0);
    expect(log.deleted).toBe(0);
  });
});
