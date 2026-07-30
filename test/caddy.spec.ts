import { renderCaddyfile, renderCaddyRoute, renderCaddyContainer } from '../src/apps/caddy-render';
import {
  buildCaddyInstallScript,
  buildCaddyRouteWriteScript,
  buildCaddyStatusScript,
} from '../src/apps/caddy-scripts';
import { DEFAULT_PROXY, ingressProxy, isProxyKind, parseProxyKind } from '../src/apps/ingress-proxy';

const rootOnly = [{ hostPort: 20000, path: '/', stripPrefix: false }];

describe('caddy-render — Caddyfile', () => {
  it('sets email, loopback admin, and the fragment import', () => {
    const c = renderCaddyfile({ email: 'ops@example.com' });
    expect(c).toContain('email ops@example.com');
    expect(c).toContain('admin 127.0.0.1:2019');
    expect(c).toContain('import /etc/vops/ingress/caddy/*.caddy');
    expect(c).not.toContain('acme_ca');
  });
  it('adds acme_ca + acme_ca_root for a private ACME (Pebble)', () => {
    const c = renderCaddyfile({ email: 'x@y.z', caServer: 'https://pebble:14000/dir', caRootPath: '/etc/vops/ingress/pebble.pem' });
    expect(c).toContain('acme_ca https://pebble:14000/dir');
    expect(c).toContain('acme_ca_root /etc/vops/ingress/pebble.pem');
  });
});

describe('caddy-render — route fragment', () => {
  it('plain route uses the http:// scheme (no auto-HTTPS) for the reachability probe', () => {
    const r = renderCaddyRoute({ app: 'tools', hostname: 't.example.com', tls: false, staging: false, routes: rootOnly });
    expect(r).toContain('http://t.example.com {');
    expect(r).toContain('reverse_proxy 127.0.0.1:20000');
    expect(r).not.toContain('tls {');
  });
  it('TLS route is a bare site (auto-HTTPS); staging pins the staging CA', () => {
    const prod = renderCaddyRoute({ app: 'tools', hostname: 't.example.com', tls: true, staging: false, routes: rootOnly });
    expect(prod).toContain('t.example.com {');
    expect(prod).not.toContain('http://');
    expect(prod).not.toContain('tls {');
    const staging = renderCaddyRoute({ app: 'tools', hostname: 't.example.com', tls: true, staging: true, routes: rootOnly });
    expect(staging).toContain('tls {');
    expect(staging).toContain('ca https://acme-staging-v02.api.letsencrypt.org/directory');
  });
  it('multi-route: web at / + api at /api (handle_path strips, root handle last)', () => {
    const r = renderCaddyRoute({
      app: 'stack', hostname: 'app.example.com', tls: true, staging: false,
      routes: [
        { hostPort: 20001, path: '/', stripPrefix: false },
        { hostPort: 20002, path: '/api', stripPrefix: true },
      ],
    });
    expect(r).toContain('app.example.com {');
    expect(r).toContain('handle_path /api/* {');
    expect(r).toContain('reverse_proxy 127.0.0.1:20002');
    expect(r).toContain('handle {');
    expect(r).toContain('reverse_proxy 127.0.0.1:20001');
    // the API handle must precede the catch-all root handle (Caddy takes the first match)
    expect(r.indexOf('handle_path /api/*')).toBeLessThan(r.indexOf('handle {'));
  });
});

describe('caddy-render — basic-auth gate', () => {
  const hash = '$2b$12$H.UWvAr0oXzzYyj3x.hOpeuzCdS3Xaa9ydekTKLXT/LAq483VTwHK';
  it('injects basic_auth ahead of the handles so it gates the whole site', () => {
    const r = renderCaddyRoute({
      app: 'tools', hostname: 't.example.com', tls: true, staging: false,
      routes: [{ hostPort: 20000, path: '/', stripPrefix: false }],
      auth: { user: 'admin', hash },
    });
    expect(r).toContain('basic_auth {');
    expect(r).toContain(`        admin ${hash}`);
    expect(r.indexOf('basic_auth {')).toBeLessThan(r.indexOf('handle {'));
  });
  it('refuses a username or hash that could break out of the Caddyfile', () => {
    const base = { app: 'x', hostname: 'h', tls: true, staging: false, routes: [{ hostPort: 1, path: '/', stripPrefix: false }] };
    expect(() => renderCaddyRoute({ ...base, auth: { user: 'a\nb', hash } })).toThrow();
    expect(() => renderCaddyRoute({ ...base, auth: { user: 'admin', hash: 'not-a-bcrypt-hash' } })).toThrow();
  });
});

describe('caddy-render — container unit', () => {
  it('is host-network, persists certs via XDG_DATA_HOME, runs the Caddyfile', () => {
    const u = renderCaddyContainer({ selinux: false });
    expect(u).toContain('Network=host');
    expect(u).toContain('Environment=XDG_DATA_HOME=/etc/vops/ingress/caddy-data');
    expect(u).toContain('Exec=caddy run --config /etc/vops/ingress/Caddyfile --adapter caddyfile');
    expect(renderCaddyContainer({ selinux: true })).toContain(':Z');
  });
});

describe('caddy-scripts', () => {
  it('install records the caddy marker + gates on the admin API', () => {
    const s = buildCaddyInstallScript({ staticConfig: 'cfg', unit: 'unit', image: 'img' });
    expect(s).toContain('echo caddy >');
    expect(s).toContain('127.0.0.1:2019/config/');
  });
  it('route write validates then reloads (no dir-watch)', () => {
    const s = buildCaddyRouteWriteScript('tools', 'fragment');
    expect(s).toContain('caddy validate');
    expect(s).toContain('caddy reload');
  });
  it('route write ends on exactly one marker and keeps Caddy\'s own complaint', () => {
    const s = buildCaddyRouteWriteScript('tools', 'fragment');
    expect(s).toContain("echo '@@invalid'");
    expect(s).toContain("echo '@@failed'");
    expect(s).toContain("echo '@@wrote'");
    // the validate/reload output is captured, not sent to /dev/null, so a failure can be quoted
    expect(s).not.toContain('>/dev/null 2>&1');
    expect(s).toContain('err=$(podman exec');
    // the fragment path is echoed into the @@wrote section — a bare path would be EXECUTED
    // (permission denied, non-zero exit, stderr noise on every route write)
    expect(s).toContain("echo '/etc/vops/ingress/caddy/tools.caddy'");
  });
  it('status newline-terminates the health code before @@routes', () => {
    expect(buildCaddyStatusScript()).toContain(String.raw`%{http_code}\n`);
  });
});

describe('ingress-proxy adapter', () => {
  const routeInput = { app: 'a', hostname: 'a.example.com', tls: true, staging: false, certResolver: 'le', routes: rootOnly };
  it('default backend is caddy', () => {
    expect(DEFAULT_PROXY).toBe('caddy');
  });
  it('selects the backend renderer + route file extension', () => {
    const caddy = ingressProxy('caddy');
    expect(caddy.kind).toBe('caddy');
    expect(caddy.routeFile('tools')).toBe('/etc/vops/ingress/caddy/tools.caddy');
    expect(caddy.renderRoute(routeInput)).toContain('reverse_proxy 127.0.0.1:20000');
    const traefik = ingressProxy('traefik');
    expect(traefik.routeFile('tools')).toBe('/etc/vops/ingress/dynamic/tools.yml');
    expect(traefik.renderRoute(routeInput)).toContain('certResolver: le');
  });
  it('reads the host proxy marker', () => {
    expect(parseProxyKind('@@proxy\ncaddy\n@@done')).toBe('caddy');
    expect(parseProxyKind('@@proxy\ntraefik\n@@done')).toBe('traefik');
    expect(parseProxyKind('@@proxy\n\n@@done')).toBeNull();
    expect(isProxyKind('caddy')).toBe(true);
    expect(isProxyKind('nginx')).toBe(false);
  });
});
