import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { renderDeploy } from '../src/apps/quadlet-render';
import { allocatePort, parsePorts, parsePreflight, supportsPod } from '../src/apps/app-parse';

describe('quadlet render — standalone', () => {
  const plan = normalizeManifest(getCatalogEntry('it-tools')!.manifest);
  const out = renderDeploy(plan, { selinux: false, ports: { app: [{ host: 8080, container: 80, bind: '0.0.0.0' }] } });
  const unit = out.units['vops-it-tools-app.container'];

  it('emits a .container unit with the expected keys', () => {
    expect(unit).toContain('ContainerName=vops-it-tools-app');
    expect(unit).toContain('Image=docker.io/corentinth/it-tools:2024.10.22-7ca5933');
    expect(unit).toContain('PublishPort=0.0.0.0:8080:80');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('PodmanArgs=--memory=128m --cpus=0.3');
  });

  it('has no pod unit for a single component', () => {
    expect(out.pod).toBeUndefined();
    expect(Object.keys(out.units)).toEqual(['vops-it-tools-app.container']);
  });
});

describe('quadlet render — composed (.pod)', () => {
  const plan = normalizeManifest(getCatalogEntry('wordpress-composed')!.manifest);
  const out = renderDeploy(plan, {
    selinux: true,
    ports: { web: [{ host: 8081, container: 80, bind: '0.0.0.0' }] },
  });

  it('emits a .pod unit that owns the published port', () => {
    const pod = out.units['vops-wordpress-composed.pod'];
    expect(pod).toContain('PodName=vops-wordpress-composed');
    expect(pod).toContain('PublishPort=0.0.0.0:8081:80');
  });

  it('members join the pod, publish nothing, and reach peers on loopback', () => {
    const web = out.units['vops-wordpress-composed-web.container'];
    expect(web).toContain('Pod=vops-wordpress-composed.pod');
    expect(web).not.toContain('PublishPort='); // the pod owns ports
    expect(web).not.toContain('--add-host'); // localhost, no static-IP hack
    expect(web).toContain('After=vops-wordpress-composed-db.service');
    expect(web).toContain('Environment=WORDPRESS_DB_HOST=127.0.0.1:3306');
    expect(web).toContain(':Z'); // selinux relabel present
    expect(web).toContain('Secret=source=vops-wordpress-composed-db-mariadb-password,type=env,target=WORDPRESS_DB_PASSWORD');
    const db = out.units['vops-wordpress-composed-db.container'];
    expect(db).toContain('Volume=vops-wordpress-composed-db-data.volume:/var/lib/mysql:Z');
  });

  it('collects all secrets to ensure on the host', () => {
    const names = out.secrets.map((s) => s.name);
    expect(names).toContain('vops-wordpress-composed-db-mariadb-password');
    expect(names).toContain('vops-wordpress-composed-db-mariadb-root-password');
  });
});

describe('quadlet render — shell startCommand overrides the entrypoint', () => {
  const plan = normalizeManifest(getCatalogEntry('pgweb')!.manifest, 'pgweb');
  const out = renderDeploy(plan, { selinux: false, ports: { app: [{ host: 18081, container: 8081, bind: '0.0.0.0' }] } });
  const unit = out.units['vops-pgweb-app.container'];

  it('sets Entrypoint=sh and passes the folded script as one quoted Exec line', () => {
    expect(unit).toContain('Entrypoint=sh');
    const exec = unit.split('\n').find((l) => l.startsWith('Exec='))!;
    expect(exec).toMatch(/^Exec=-c '.*'$/); // single -c '<script>' arg
    expect(exec).toContain('exec /usr/bin/pgweb');
    // the folded multi-line startCommand must collapse to ONE physical line, else
    // Quadlet reads `export DATABASE_URL=…` as a bogus unit key and refuses.
    expect(unit).not.toMatch(/^\s*export DATABASE_URL=/m);
  });
});

describe('preflight parse + port allocation', () => {
  const stdout = [
    '@@podman', 'podman version 5.4.2',
    '@@quadlet', '/usr/lib/systemd/system-generators/podman-system-generator',
    '@@k3s', 'active',
    '@@selinux', 'no',
    '@@arch', 'x86_64',
    '@@ports', '0.0.0.0:22\n[::]:80\n127.0.0.1:6443\n0.0.0.0:8080',
    '@@diskkb', '52428800',
    '@@networks', 'podman\nvops-foo',
  ].join('\n');
  const facts = parsePreflight(stdout);

  it('parses versions, coexistence and ports', () => {
    expect(facts.podmanVersion).toBe('5.4.2');
    expect(supportsPod(facts.podmanVersion)).toBe(true); // 5.4.2
    expect(supportsPod('4.9.3')).toBe(false); // below the .pod floor
    expect(facts.k3s).toBe(true);
    expect(facts.listeningPorts.has(6443)).toBe(true);
    expect(facts.freeKb).toBe(52428800);
  });

  it('avoids used and privileged ports in coexistence mode', () => {
    const used = new Set(facts.listeningPorts);
    // container port 80 is privileged → coexistence forces a high port
    const p1 = allocatePort(80, used, true);
    expect(p1).toBeGreaterThanOrEqual(20000);
    // 8080 is in use → next allocation skips it
    const p2 = allocatePort(8080, used, true);
    expect(p2).not.toBe(8080);
  });

  it('reuses the container port when free and not in coexistence', () => {
    expect(allocatePort(3001, new Set(), false)).toBe(3001);
  });

  it('parsePorts handles ipv6 and ipv4 forms', () => {
    expect([...parsePorts('0.0.0.0:22\n[::]:443')].sort()).toEqual([22, 443]);
  });
});
