import { toFailure } from '../src/agent-api/agent-output';
import { AgentBadRequest } from '../src/agent-api/agent-http-errors';
import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { VopsAppsService } from '../src/apps/vops-apps.service';
import { BindingResolution } from '../src/apps/vops-ingress.service';
import { AppInstallV1, AppPlan } from '../src/apps/app.model';

/**
 * `--domain` on an app with no reachable login of its own is refused until the operator
 * chooses `--auth basic|none`. The refusal is raised inside the gate resolver, so what these
 * cases pin is the rest of the chain the CLI actually observes: the service must not flatten it
 * into a generic `BadRequestException` (that is exit 1 / VOPS_OPERATION_FAILED), and the command
 * layer must turn it into an envelope error with the documented code and exit status.
 */
const svc = new VopsAppsService(null as any, null as any, null as any, null as any, null as any, null as any);
const plan = (app: string): AppPlan => normalizeManifest(getCatalogEntry(app)!.manifest, app);
const resolution = { binding: { hostname: 'dbgate.example.com', tls: true } } as BindingResolution;

const gateOf = (p: AppPlan, res: BindingResolution | null, intent?: { mode: 'none' | 'basic' }, prev: AppInstallV1 | null = null) =>
  (svc as any).resolveGate(p, res, intent, prev);

describe('exposing an app with no login requires an explicit --auth choice', () => {
  it('refuses through the service with the structured code intact (not VOPS_OPERATION_FAILED)', () => {
    const dbgate = plan('dbgate');
    expect(dbgate.authMode).toBe('none');
    let thrown: unknown;
    try {
      gateOf(dbgate, resolution);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AgentBadRequest);
    expect((thrown as AgentBadRequest).agent.code).toBe('VOPS_APP_EXPOSURE_UNGATED');
  });

  it('reaches the command layer as an envelope error with exit 2 and both ways out', () => {
    let thrown: unknown;
    try {
      gateOf(plan('dbgate'), resolution);
    } catch (e) {
      thrown = e;
    }
    const failure = toFailure(thrown);
    expect(failure.error.code).toBe('VOPS_APP_EXPOSURE_UNGATED');
    expect(failure.exitCode).toBe(2);
    expect(failure.error.message).toMatch(/--auth basic/);
    expect(failure.error.message).toMatch(/--auth none/);
    expect(failure.error.documentation).toContain('#vops_app_exposure_ungated');
  });

  it('accepts the same deploy once the choice is explicit', () => {
    expect(gateOf(plan('dbgate'), resolution, { mode: 'none' })).toBeNull();
    expect(gateOf(plan('dbgate'), resolution, { mode: 'basic' }).state.mode).toBe('basic');
  });

  it('leaves a bare install (no --domain) and a self-authenticating app alone', () => {
    expect(gateOf(plan('dbgate'), null)).toBeNull();
    expect(gateOf(plan('vaultwarden'), resolution)).toBeNull();
  });

  it('does not break a redeploy of an app that already carries a gate', () => {
    const prev = { ingress: { auth: { mode: 'basic', user: 'op', secret: 'vops-dbgate-ingress-auth', hash: 'h' } } } as AppInstallV1;
    expect(gateOf(plan('dbgate'), resolution, undefined, prev).routeAuth).toEqual({ user: 'op', hash: 'h' });
  });
});
