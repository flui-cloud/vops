import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { planHostDeploy } from '../src/apps/app-plan';
import { HostFacts, parseDeployOutput, parseHttpSmoke } from '../src/apps/app-parse';
import { runSmoke } from '../src/apps/app-deploy-runner';

function facts(over: Partial<HostFacts> = {}): HostFacts {
  return {
    podmanVersion: '4.9.3',
    quadletGenerator: '/usr/lib/systemd/system-generators/podman-system-generator',
    k3s: true,
    selinux: false,
    arch: 'x86_64',
    listeningPorts: new Set([22, 20000]),
    freeKb: 10_000_000,
    networks: ['podman'],
    ...over,
  };
}

describe('planHostDeploy — composed (wordpress) as a .pod on a k3s host', () => {
  const plan = normalizeManifest(getCatalogEntry('wordpress-composed')!.manifest, 'wp');
  const hp = planHostDeploy(plan, facts(), '203.0.113.5');

  it('renders a pod (localhost networking, no subnet/static-IP/add-host)', () => {
    expect(hp.pod).toBe('vops-wp');
    const pod = hp.units['vops-wp.pod'];
    expect(pod).toContain('PodName=vops-wp');
    const web = hp.units['vops-wp-web.container'];
    expect(web).toContain('Pod=vops-wp.pod');
    expect(web).not.toContain('--add-host');
    expect(web).not.toContain('--ip=');
    expect(Object.keys(hp.units)).not.toContain('vops-wp.network');
  });

  it('starts volume + pod services before the containers', () => {
    expect(hp.prereqServices).toContain('vops-wp-db-data-volume.service');
    expect(hp.prereqServices).toContain('vops-wp-pod.service');
    // db (a dependency of web) is ordered before web
    expect(hp.services.indexOf('vops-wp-db.service')).toBeLessThan(hp.services.indexOf('vops-wp-web.service'));
  });

  it('allocates a high host port for the exposed web (coexistence, 20000 taken)', () => {
    const webPort = hp.ports.web[0].host;
    expect(webPort).toBeGreaterThanOrEqual(20001);
  });

  it('binds a bare deploy on loopback and advertises the honest 127.0.0.1 URL', () => {
    const webPort = hp.ports.web[0].host;
    expect(hp.ports.web[0].bind).toBe('127.0.0.1');
    expect(hp.endpoints[0].reach).toBe('loopback');
    expect(hp.endpoints[0].url).toBe(`http://127.0.0.1:${webPort}`);
  });

  it('binds on 0.0.0.0 and advertises the host address only when publish=public', () => {
    const pub = planHostDeploy(plan, facts(), '203.0.113.5', undefined, 'public');
    const webPort = pub.ports.web[0].host;
    expect(pub.ports.web[0].bind).toBe('0.0.0.0');
    expect(pub.endpoints[0].reach).toBe('public');
    expect(pub.endpoints[0].url).toBe(`http://203.0.113.5:${webPort}`);
  });
});

describe('planHostDeploy — an app owns its host ports until it is removed', () => {
  const tools = () => normalizeManifest(getCatalogEntry('it-tools')!.manifest, 'it-tools');
  const binding = () => ({
    hostname: 'ittools-val.fluicloud.eu',
    tls: true,
    exposeDirect: false,
    routes: [{ component: 'app', containerPort: 80, path: '/', stripPrefix: false }],
  });
  const held = (host: number) => ({ app: [{ host, container: 80, bind: '127.0.0.1' }] });

  it('keeps its own port on redeploy, even though the running app is listening on it', () => {
    const hp = planHostDeploy(tools(), facts({ k3s: false, listeningPorts: new Set([22, 20000]) }), '203.0.113.5', binding(), 'loopback', {
      own: held(20000),
      others: [],
    });
    expect(hp.ports.app[0].host).toBe(20000);
    expect(hp.units['vops-it-tools-app.container']).toContain('PublishPort=127.0.0.1:20000:80');
  });

  it('never takes a port another install holds, even while that app is stopped', () => {
    const hp = planHostDeploy(tools(), facts({ k3s: false, listeningPorts: new Set([22]) }), '203.0.113.5', binding(), 'loopback', {
      own: {},
      others: [20000],
    });
    expect(hp.ports.app[0].host).toBe(20001);
  });

  it('drops a kept port the ingress needs back (80/443)', () => {
    const hp = planHostDeploy(tools(), facts({ k3s: false, listeningPorts: new Set([22]) }), '203.0.113.5', binding(), 'loopback', {
      own: held(80),
      others: [],
    });
    expect(hp.ports.app[0].host).toBe(20000);
  });

  it('allocates from scratch on a first install (no reservations)', () => {
    const hp = planHostDeploy(tools(), facts({ k3s: false, listeningPorts: new Set([22]) }), '203.0.113.5');
    expect(hp.ports.app[0].host).toBe(80);
  });
});

describe('parseDeployOutput', () => {
  it('flags a service that is not active and surfaces the diagnostics', () => {
    const out = parseDeployOutput('@@started\na.service=active\nb.service=failed\n@@diag\n### b.service\nboom\n@@ok', ['a.service', 'b.service']);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('b.service');
    expect(out.error).toContain('boom');
  });

  it('passes when all services are active', () => {
    const out = parseDeployOutput('@@started\na.service=active\n@@diag\n@@ok', ['a.service']);
    expect(out.ok).toBe(true);
  });
});

describe('parseHttpSmoke — app-serving semantics', () => {
  it('accepts the expected status and any 2xx/3xx (fresh app redirect)', () => {
    expect(parseHttpSmoke('@@http\n200', 200).ok).toBe(true);
    expect(parseHttpSmoke('@@http\n302', 200).ok).toBe(true); // WP redirect to installer
  });
  it('rejects no-response and server errors', () => {
    expect(parseHttpSmoke('@@http\n000', 200).ok).toBe(false);
    expect(parseHttpSmoke('@@http\n500', 200).ok).toBe(false);
  });

  it('names the port it probed, so a 000 can be compared with what the container binds', () => {
    expect(parseHttpSmoke('@@http\n000', 200, 20001).detail).toContain('127.0.0.1:20001');
  });
});

// A manifest may extend the first-start window; it must never shorten it. Taken as the WHOLE
// budget, `smokeTest.retries: 3` is attempts × the probe's fixed 5s spacing — 15s, which rolls
// back apps that are merely slow on a cold box. `smokeTest.timeoutSeconds`, declared by 40+
// manifests, is the wall-clock deadline: a loop that counts attempts gives seconds nowhere to land.
describe('runSmoke — the manifest can lengthen the startup window, never shorten it', () => {
  type Smoke = { retries?: number; timeoutSeconds?: number };
  const plan = (st: Smoke) => ({
    name: 'kuma', primary: 'app',
    components: [{ name: 'app', container: 'vops-kuma-app', ports: [{ container: 3001, expose: true, protocol: 'http' }] }],
    smokeTest: { type: 'http' as const, path: '/', expectedStatus: 200, ...st },
  });
  const hp = { ports: { app: [{ host: 20001, container: 3001, bind: '127.0.0.1' }] } };

  function windowOf(script: string): number {
    return Number.parseInt(/date \+%s\) \+ (\d+) \)\)/.exec(script)?.[1] ?? '0', 10);
  }
  async function capture(st: Smoke = {}): Promise<{ window: number; timeoutMs: number; script: string }> {
    let seen = '';
    let opts: { timeoutMs?: number } = {};
    const ssh = {
      runScript: async (_t: unknown, s: string, o: { timeoutMs?: number }) => {
        seen = s; opts = o;
        return { stdout: '@@http\n200', stderr: '', code: 0 };
      },
    };
    await runSmoke({ ssh, target: {} } as never, plan(st) as never, hp as never);
    return { window: windowOf(seen), timeoutMs: opts.timeoutMs ?? 0, script: seen };
  }

  it('floors a too-short manifest budget at the default (uptime-kuma asked for 3 ≈ 15s)', async () => {
    expect((await capture({ retries: 3 })).window).toBe(120);
  });

  it('keeps the default when the manifest says nothing', async () => {
    expect((await capture()).window).toBe(120);
  });

  it('honours a manifest that asks for MORE attempts', async () => {
    expect((await capture({ retries: 60 })).window).toBe(300);
  });

  it('honours smokeTest.timeoutSeconds when it asks for more (authentik: 200s)', async () => {
    expect((await capture({ timeoutSeconds: 200 })).window).toBe(200);
  });

  it('never lets timeoutSeconds shorten the window (uptime-kuma: 15s)', async () => {
    expect((await capture({ timeoutSeconds: 15, retries: 3 })).window).toBe(120);
  });

  it('caps an absurd budget instead of hanging the deploy on it', async () => {
    expect((await capture({ timeoutSeconds: 99_999 })).window).toBe(600);
  });

  it('gives the SSH round-trip more time than the window it is running', async () => {
    const r = await capture({ timeoutSeconds: 200 });
    expect(r.timeoutMs).toBeGreaterThan(200_000);
    expect(r.script).toContain('while :; do');
    expect(r.script).not.toContain('seq 1');
  });
});
