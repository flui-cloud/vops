import { VopsIngressService } from '../src/apps/vops-ingress.service';
import { parseRouteWrite, routeWriteMessage } from '../src/apps/ingress-route-write';

// The route fragment is written to disk BEFORE the proxy is asked to reload, so a run
// whose result is not read reports success for an app that is not routed until something else
// forces the next reload. Every non-`@@wrote` outcome must reach the user as a failure.
function svc(routeWrite: { stdout: string; stderr?: string; code?: number }) {
  const keys = { list: () => [], keyPathFor: () => '/tmp/key' };
  const ssh = {
    runScript: async (_t: unknown, body: string) =>
      body.includes('caddy validate')
        ? { code: routeWrite.code ?? 0, stdout: routeWrite.stdout, stderr: routeWrite.stderr ?? '' }
        : { code: 0, stdout: '@@proxy\ncaddy\n@@done', stderr: '' },
  };
  return new VopsIngressService({} as never, keys as never, {} as never, ssh as never, {} as never, {} as never);
}

const host = { name: 'web1', address: '203.0.113.10', user: 'root', userKeyName: 'k' };
const install = {
  name: 'tools',
  components: [{ name: 'app', container: 'vops-tools-app', image: 'img', published: [{ container: 80, host: 20000 }] }],
};
const binding = {
  hostname: 'tools.example.com',
  tls: false,
  exposeDirect: false,
  routes: [{ component: 'app', containerPort: 80, path: '/', stripPrefix: false }],
};

const attach = (stdout: string, stderr = '') =>
  svc({ stdout, stderr }).attachRoute(host as never, install as never, binding as never, false);

describe('ingress route write — the script result is checked', () => {
  it('succeeds when the proxy reports @@wrote', async () => {
    const res = await attach('@@wrote\n/etc/vops/ingress/caddy/tools.caddy');
    expect(res.reachable).toBe(true);
    expect(res.state.hostname).toBe('tools.example.com');
  });

  it('fails loudly on @@invalid and quotes what the proxy objected to', async () => {
    await expect(attach("@@invalid\nError: adapting config: /etc/vops/ingress/Caddyfile:12 - unrecognized directive 'reverse_prox'"))
      .rejects.toThrow(/refused the ingress config for 'tools'/);
    await expect(attach("@@invalid\nError: unrecognized directive 'reverse_prox'"))
      .rejects.toThrow(/unrecognized directive/);
  });

  it('fails when no marker comes back at all (timeout / SIGKILLed validate / dead ssh)', async () => {
    await expect(attach('', 'Killed by signal 9.')).rejects.toThrow(/no result/);
    await expect(attach('', 'Killed by signal 9.')).rejects.toThrow(/may not be publicly routed/);
  });

  it('fails when the config validated but the reload did not', async () => {
    await expect(attach('@@failed\ncaddy: reload: connection refused')).rejects.toThrow(/reload failed/);
  });
});

describe('parseRouteWrite', () => {
  it('maps each marker to its own outcome, and no marker to "unknown"', () => {
    expect(parseRouteWrite('@@wrote\n/etc/vops/ingress/caddy/tools.caddy')).toEqual({ ok: true, kind: 'wrote', detail: '' });
    expect(parseRouteWrite('@@invalid\nboom')).toEqual({ ok: false, kind: 'rejected', detail: 'boom' });
    expect(parseRouteWrite('@@failed\nboom')).toEqual({ ok: false, kind: 'reload-failed', detail: 'boom' });
    expect(parseRouteWrite('')).toEqual({ ok: false, kind: 'unknown', detail: '' });
    expect(parseRouteWrite('@@wrote\n').ok).toBe(true);
  });

  it('falls back to stderr when the failing marker carried no detail', () => {
    const msg = routeWriteMessage('tools', 'caddy', { kind: 'unknown', detail: '' }, 'ssh: connect to host … timed out');
    expect(msg).toContain('timed out');
    expect(msg).toContain('vops app expose tools --yes');
  });
});
