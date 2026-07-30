import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { planHostDeploy } from '../src/apps/app-plan';
import { HostFacts } from '../src/apps/app-parse';
import { VopsIngressService } from '../src/apps/vops-ingress.service';
import { VopsHost } from '../src/hosts/host.model';

function facts(): HostFacts {
  return {
    podmanVersion: '5.8.4',
    quadletGenerator: '/usr/local/lib/systemd/system-generators/podman-system-generator',
    k3s: false,
    selinux: false,
    arch: 'x86_64',
    listeningPorts: new Set([22]),
    freeKb: 10_000_000,
    networks: ['podman'],
  };
}

const host = { name: 'box', address: '203.0.113.9' } as VopsHost;
const ingress = new VopsIngressService(null as any, null as any, null as any, null as any, null as any, null as any);
const plan = (app: string, name: string) => normalizeManifest(getCatalogEntry(app)!.manifest, name);

describe('a manifest that templates {{app.domain}} installs without --domain', () => {
  it('does NOT pull an ingress binding (no hostname, no TLS, no ACME email) when none was asked for', () => {
    const vw = plan('vaultwarden', 'vw');
    expect(vw.needsAppDomain).toBe(true);
    expect(ingress.resolveBinding(vw, host, {})).toBeNull();
    expect(ingress.resolveBinding(plan('nextcloud', 'nc'), host, {})).toBeNull();
  });

  it('resolves the token to the loopback origin the install actually answers on', () => {
    const vw = plan('vaultwarden', 'vw');
    const hp = planHostDeploy(vw, facts(), host.address);
    const port = hp.ports.app.find((p) => p.container === 80)!.host;
    const unit = hp.units['vops-vw-app.container'];
    expect(unit).toContain(`PublishPort=127.0.0.1:${port}:80`);
    // `https://{{app.domain}}` → the scheme goes with it: a bare install serves plain HTTP.
    expect(unit).toContain(`Environment=DOMAIN=http://127.0.0.1:${port}`);
    expect(unit).not.toContain('{{app.domain}}');
    expect(unit).not.toContain('https://127.0.0.1');
  });

  it('keeps a scheme-less reference host:port (trusted-domain / Host-header style values)', () => {
    const nc = plan('nextcloud', 'nc');
    const hp = planHostDeploy(nc, facts(), host.address);
    const port = hp.ports.app.find((p) => p.container === 80)!.host;
    const unit = hp.units['vops-nc-app.container'];
    expect(unit).toContain(`Environment=NEXTCLOUD_TRUSTED_DOMAINS=127.0.0.1:${port}`);
    expect(unit).toContain(`Environment=OVERWRITEHOST=127.0.0.1:${port}`);
    expect(unit).toContain(`Environment=OVERWRITECLIURL=http://127.0.0.1:${port}`);
  });

  it('resolves a scheme-only env to http, so nextcloud does not redirect to a dead TLS origin', () => {
    const nc = plan('nextcloud', 'nc');
    const hp = planHostDeploy(nc, facts(), host.address);
    const unit = hp.units['vops-nc-app.container'];
    expect(unit).toContain('Environment=OVERWRITEPROTOCOL=http');
    expect(unit).not.toContain('Environment=OVERWRITEPROTOCOL=https');
    expect(unit).not.toContain('{{app.scheme}}');
  });

  it('says so: the plan warns the install is loopback-only and names `app expose`', () => {
    const wb = plan('wallabag', 'wb');
    planHostDeploy(wb, facts(), host.address);
    expect(wb.warnings?.join(' ')).toContain('vops app expose wb --domain');
  });

  // Homepage's guard is an EXACT Host-header match (port included) applied to /api/* only,
  // so the loopback authority is both what a tunnelled browser sends and harmless to the smoke
  // test, which curls `/`.
  it('pins homepage\'s host guard to the loopback authority, not a wildcard', () => {
    const hpg = plan('homepage', 'hpg');
    const hp = planHostDeploy(hpg, facts(), host.address);
    const port = hp.ports.app.find((p) => p.container === 3000)!.host;
    const unit = hp.units['vops-hpg-app.container'];
    expect(unit).toContain(`Environment=HOMEPAGE_ALLOWED_HOSTS=127.0.0.1:${port}`);
    expect(unit).not.toContain('HOMEPAGE_ALLOWED_HOSTS=*');
  });

  it('leaves apps with no {{app.domain}} untouched (no warning, no rewrite)', () => {
    const tools = plan('it-tools', 'tools');
    planHostDeploy(tools, facts(), host.address);
    expect(tools.warnings ?? []).toEqual([]);
  });
});

describe('--domain keeps the ingress path exactly as it was', () => {
  it('binds the given hostname with TLS and routes the primary HTTP port', () => {
    const vw = plan('vaultwarden', 'vw');
    const res = ingress.resolveBinding(vw, host, { domain: 'vault.example.com' })!;
    expect(res.binding).toMatchObject({ hostname: 'vault.example.com', tls: true, exposeDirect: false });
    expect(res.binding.routes).toEqual([{ component: 'app', containerPort: 80, path: '/', stripPrefix: false }]);
    expect(res.sslip).toBe(false);
  });

  it('--domain auto still derives the sslip.io demo host', () => {
    const res = ingress.resolveBinding(plan('vaultwarden', 'vw'), host, { domain: 'auto' })!;
    expect(res.binding.hostname).toBe('vw.203-0-113-9.sslip.io');
    expect(res.sslip).toBe(true);
  });

  it('substitutes the routed hostname, keeping the manifest scheme', () => {
    const vw = plan('vaultwarden', 'vw');
    const res = ingress.resolveBinding(vw, host, { domain: 'vault.example.com' })!;
    const hp = planHostDeploy(vw, facts(), host.address, res.binding);
    expect(hp.units['vops-vw-app.container']).toContain('Environment=DOMAIN=https://vault.example.com');
    expect(vw.warnings ?? []).toEqual([]);
  });

  it('validates homepage against the routed hostname once it has one', () => {
    const hpg = plan('homepage', 'hpg');
    const res = ingress.resolveBinding(hpg, host, { domain: 'home.example.com' })!;
    const hp = planHostDeploy(hpg, facts(), host.address, res.binding);
    expect(hp.units['vops-hpg-app.container']).toContain('Environment=HOMEPAGE_ALLOWED_HOSTS=home.example.com');
  });

  // Five manifests write `https://{{app.domain}}`. Behind `--no-tls` nothing serves TLS on
  // that hostname, so keeping the written scheme hands the app a URL claiming an origin that does
  // not exist — baserow builds every link from it, wallabag/bookstack store it in the database.
  it('--no-tls resolves the written-in scheme to http, not the https the manifest asked for', () => {
    const br = plan('baserow', 'br');
    const res = ingress.resolveBinding(br, host, { domain: 'db.example.com', tls: false })!;
    expect(res.binding.tls).toBe(false);
    const hp = planHostDeploy(br, facts(), host.address, res.binding);
    const unit = hp.units['vops-br-app.container'];
    expect(unit).toContain('Environment=BASEROW_PUBLIC_URL=http://db.example.com');
    expect(unit).not.toContain('https://db.example.com');
  });

  it('--no-tls carries through a composed app and a scheme-only env (wallabag, nextcloud)', () => {
    const wb = plan('wallabag', 'wb');
    const wres = ingress.resolveBinding(wb, host, { domain: 'read.example.com', tls: false })!;
    const wunit = planHostDeploy(wb, facts(), host.address, wres.binding).units['vops-wb-app.container'];
    expect(wunit).toContain('Environment=SYMFONY__ENV__DOMAIN_NAME=http://read.example.com');

    const nc = plan('nextcloud', 'nc');
    const nres = ingress.resolveBinding(nc, host, { domain: 'cloud.example.com', tls: false })!;
    const nunit = planHostDeploy(nc, facts(), host.address, nres.binding).units['vops-nc-app.container'];
    expect(nunit).toContain('Environment=OVERWRITEHOST=cloud.example.com');
    expect(nunit).toContain('Environment=OVERWRITEPROTOCOL=http');
    expect(nunit).toContain('Environment=OVERWRITECLIURL=http://cloud.example.com');
    expect(nunit).not.toContain('https://cloud.example.com');
  });

  it('with TLS the same env is https — the scheme follows the binding, not the manifest text', () => {
    const br = plan('baserow', 'br');
    const res = ingress.resolveBinding(br, host, { domain: 'db.example.com' })!;
    expect(res.binding.tls).toBe(true);
    const hp = planHostDeploy(br, facts(), host.address, res.binding);
    expect(hp.units['vops-br-app.container']).toContain('Environment=BASEROW_PUBLIC_URL=https://db.example.com');
  });

  it('keeps nextcloud on https: hostname, protocol and cli URL all TLS as before', () => {
    const nc = plan('nextcloud', 'nc');
    const res = ingress.resolveBinding(nc, host, { domain: 'cloud.example.com' })!;
    const hp = planHostDeploy(nc, facts(), host.address, res.binding);
    const unit = hp.units['vops-nc-app.container'];
    expect(unit).toContain('Environment=NEXTCLOUD_TRUSTED_DOMAINS=cloud.example.com');
    expect(unit).toContain('Environment=OVERWRITEHOST=cloud.example.com');
    expect(unit).toContain('Environment=OVERWRITEPROTOCOL=https');
    expect(unit).toContain('Environment=OVERWRITECLIURL=https://cloud.example.com');
  });
});
