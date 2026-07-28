import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { planHostDeploy } from '../src/apps/app-plan';
import { HostFacts, parseDeployOutput, parseHttpSmoke } from '../src/apps/app-parse';

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
});
