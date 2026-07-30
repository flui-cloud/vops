import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { internalExposureWarnings } from '../src/apps/app-deploy-view';
import { deployBody, exposeWarnings } from '../src/apps/deploy-flags';
import type { DeployFlags } from '../src/apps/deploy-flags';
import { VopsAppsService } from '../src/apps/vops-apps.service';
import type { DeployPlanView, DeployResult } from '../src/apps/vops-apps.service';
import { VopsIngressService } from '../src/apps/vops-ingress.service';
import { AppPlan } from '../src/apps/app.model';
import { VopsHost } from '../src/hosts/host.model';

/**
 * Five DB-admin GUIs declare `spec.exposure: internal` and nothing read it, so the declaration
 * was a comment. vops does NOT refuse a `--domain` on them (that is the user's call, still open) —
 * it must say plainly, at the moment the domain is created, that the manifest asked for host-local
 * and that vops is not enforcing it. A bare install asks for nothing and must stay silent.
 */

const INTERNAL = ['dbgate', 'pgweb', 'phpmyadmin', 'mongo-express', 'redis-commander'];

const plan = (app: string, name = app): AppPlan => normalizeManifest(getCatalogEntry(app)!.manifest, name);

describe('the exposure declaration reaches the plan', () => {
  it.each(INTERNAL)('%s carries exposure: internal', (app) => {
    expect(plan(app).exposure).toBe('internal');
  });

  it('leaves an app that declares nothing (or public) undeclared', () => {
    expect(plan('vaultwarden').exposure).toBeUndefined();
    expect(plan('gitea').exposure).toBeUndefined();
  });
});

describe('the advisory fires only when a domain is actually being created', () => {
  it('names the declaration, says vops does not enforce it, and gives the way back', () => {
    const [w, ...rest] = internalExposureWarnings(plan('dbgate'), { hostname: 'db.example.com' });
    expect(rest).toEqual([]);
    expect(w).toContain('`exposure: internal`');
    expect(w).toContain('does NOT enforce');
    expect(w).toContain('db.example.com');
    expect(w).toContain('advisory');
    expect(w).toContain('vops app unexpose dbgate');
  });

  it('says nothing for a bare install of the same app — that is what the manifest asked for', () => {
    expect(internalExposureWarnings(plan('dbgate'), undefined)).toEqual([]);
  });

  it('says nothing for an app that never declared internal, domain or not', () => {
    expect(internalExposureWarnings(plan('vaultwarden'), { hostname: 'vault.example.com' })).toEqual([]);
  });
});

describe('the deploy plan carries it (service level, dry-run)', () => {
  const host = { name: 'box', address: '203.0.113.9', opsKeyInstalled: false, userKeyName: 'k' } as VopsHost;
  const preflight = [
    '@@podman', 'podman version 5.4.2',
    '@@quadlet', '/usr/lib/systemd/system-generators/podman-system-generator',
    '@@k3s', 'inactive',
    '@@selinux', 'no',
    '@@arch', 'x86_64',
    '@@ports', '0.0.0.0:22',
    '@@diskkb', '52428800',
    '@@networks', 'podman',
  ].join('\n');

  const service = () => {
    const real = new VopsIngressService(null as any, null as any, null as any, null as any, null as any, null as any);
    const ingress = {
      resolveBinding: (p: AppPlan, h: VopsHost, o: any) => real.resolveBinding(p, h, o),
      preflightDns: async () => null,
    };
    return new VopsAppsService(
      { show: () => host } as any,
      { keyPathFor: () => '/tmp/id_ed25519', list: () => [] } as any,
      { assertReady: async () => undefined } as any,
      { runScript: async () => ({ stdout: preflight, stderr: '', code: 0 }) } as any,
      { getInstall: async () => null, listInstalls: async () => [] } as any,
      ingress as any,
    );
  };

  it('warns in the plan when dbgate is given a domain (--auth none acknowledged)', async () => {
    const view = (await service().deploy({ catalog: 'dbgate' }, 'box', {
      dryRun: true,
      ingress: { domain: 'db.example.com', auth: { mode: 'none' } },
    })) as DeployPlanView;
    expect(view.ingress?.hostname).toBe('db.example.com');
    expect(view.warnings?.join(' ')).toContain('`exposure: internal`');
    expect(view.warnings?.join(' ')).toContain('does NOT enforce');
  });

  it('stays completely silent for a bare dbgate install', async () => {
    const view = (await service().deploy({ catalog: 'dbgate' }, 'box', { dryRun: true })) as DeployPlanView;
    expect(view.ingress).toBeUndefined();
    expect(view.warnings).toBeUndefined();
  });
});

describe('an agent reading --json sees it', () => {
  const advisory = 'dbgate: its manifest declares `exposure: internal` — …';
  const view = { app: 'dbgate', host: 'box', files: {}, warnings: [advisory] } as unknown as DeployPlanView;
  const svc = { deploy: async () => view } as unknown as Pick<VopsAppsService, 'deploy'>;
  const flags = (): DeployFlags => ({ host: 'box', tls: true, staging: false, 'expose-direct': false, yes: false, 'dry-run': false, json: true });

  it('as an envelope warning on `app install`/`app deploy`', async () => {
    const body = await deployBody(svc, { catalog: 'dbgate' }, flags());
    expect(body.warnings).toContainEqual({ code: 'VOPS_DEPLOY_ADVISORY', message: advisory });
  });

  it('as an envelope warning on `app expose`, which used to drop every deploy advisory', () => {
    const data = { warnings: [advisory], ingress: { hostname: 'db.example.com', tls: true, note: 'n', warnings: ['dns'] } } as unknown as DeployResult;
    expect(exposeWarnings(data)).toEqual([
      { code: 'VOPS_INGRESS_ADVISORY', message: 'dns' },
      { code: 'VOPS_DEPLOY_ADVISORY', message: advisory },
    ]);
    expect(exposeWarnings({ warnings: undefined, ingress: undefined } as unknown as DeployResult)).toEqual([]);
  });
});
