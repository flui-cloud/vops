import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { renderDeploy } from '../src/apps/quadlet-render';
import { renderHealthUnits } from '../src/apps/health-timer';
import { buildDeployScript, buildPullScript, buildRemoveScript, pullBudgetSeconds } from '../src/apps/app-scripts';
import { parsePullOutput } from '../src/apps/app-parse';

/** The `podman-static` build vops installs is compiled without the `systemd` build tag, so
 * podman's own `createTimer`/`startTimer` are no-ops and a rendered `HealthCmd` is never run:
 * every container stays `starting` for ever. vops has to schedule the probe itself. */
describe('health timers', () => {
  const plan = normalizeManifest(getCatalogEntry('immich')!.manifest);
  const out = renderDeploy(plan, { selinux: false, ports: {} });

  it('emits a timer + oneshot pair for every component whose probe is rendered', () => {
    const containers = plan.components.filter((c) => c.health).map((c) => c.container);
    expect(containers.length).toBeGreaterThan(1);
    for (const c of containers) {
      expect(out.healthUnits[`${c}-health.timer`]).toBeDefined();
      expect(out.healthUnits[`${c}-health.service`]).toContain(`podman healthcheck run ${c}`);
    }
  });

  it('binds the timer to the container unit so it lives and dies with it', () => {
    const timer = out.healthUnits['vops-immich-redis-health.timer'];
    expect(timer).toContain('BindsTo=vops-immich-redis.service');
    expect(timer).toContain('After=vops-immich-redis.service');
    expect(timer).toContain('WantedBy=vops-immich-redis.service');
  });

  it("carries the manifest's own initialDelay + interval", () => {
    const timer = out.healthUnits['vops-immich-redis-health.timer'];
    expect(timer).toContain('OnActiveSec=5s'); // healthcheck.initialDelay
    expect(timer).toContain('OnUnitInactiveSec=10s'); // healthcheck.interval
  });

  it('renders nothing for a component with no healthcheck', () => {
    const bare = normalizeManifest(getCatalogEntry('it-tools')!.manifest);
    for (const c of bare.components) delete c.health;
    expect(renderDeploy(bare, { selinux: false, ports: { app: [] } }).healthUnits).toEqual({});
  });

  it('falls back to a valid duration when the manifest declares one systemd would reject', () => {
    const units = renderHealthUnits('vops-x-app', { type: 'exec', interval: '30', initialDelay: 'PT5S' });
    expect(units['vops-x-app-health.timer']).toContain('OnUnitInactiveSec=30s');
    expect(units['vops-x-app-health.timer']).toContain('OnActiveSec=30s');
  });

  it('the deploy script installs the units where systemd looks and enables the timers', () => {
    const s = buildDeployScript({
      unitDir: '/etc/containers/systemd/vops/immich',
      units: out.units,
      healthUnits: out.healthUnits,
      secrets: [],
      services: ['vops-immich-redis.service'],
      prereqServices: [],
      quadletGenerator: '/usr/local/lib/systemd/system-generators/podman-system-generator',
    });
    expect(s).toContain("cat > '/etc/systemd/system/vops-immich-redis-health.timer'");
    expect(s).toContain("systemctl enable 'vops-immich-redis-health.timer'");
    // Enabled after the container unit exists, or the .wants symlink has no target.
    expect(s.indexOf("systemctl restart 'vops-immich-redis.service'")).toBeLessThan(
      s.indexOf("systemctl enable 'vops-immich-redis-health.timer'"),
    );
  });

  it('the remove script disables and deletes them, probed component or not', () => {
    const s = buildRemoveScript({
      unitDir: '/etc/containers/systemd/vops/immich',
      services: ['vops-immich-redis.service'],
      prereqServices: [],
      containers: ['vops-immich-redis'],
      secrets: [],
      volumes: [],
      purge: false,
    });
    expect(s).toContain("systemctl disable --now 'vops-immich-redis-health.timer'");
    expect(s).toContain("rm -f '/etc/systemd/system/vops-immich-redis-health.timer'");
  });
});

/** A Quadlet unit's ExecStart is `podman run`, so a first-install image download is charged
 * to `TimeoutStartSec`; systemd kills the pull at the budget and `Restart=always` restarts it from
 * zero, for ever. The images have to be on the host before any unit starts. */
describe('image pull before the units start', () => {
  const images = ['ghcr.io/immich-app/postgres:14', 'docker.io/valkey/valkey:9', 'docker.io/valkey/valkey:9'];

  it('pulls each distinct image once, keeping --pull=missing semantics', () => {
    const s = buildPullScript({ images });
    expect(s).toContain("vops_pull 'ghcr.io/immich-app/postgres:14'");
    expect(s.match(/vops_pull 'docker\.io\/valkey\/valkey:9'/g)).toHaveLength(1);
    expect(s).toContain('podman image exists "$1"');
  });

  it('bounds the whole phase, so a stalled registry cannot hang the deploy for ever', () => {
    expect(buildPullScript({ images })).toContain(`deadline=$(( $(date +%s) + ${pullBudgetSeconds(2)} ))`);
    expect(pullBudgetSeconds(99)).toBeLessThanOrEqual(2400);
  });

  it('logs into a private registry before pulling from it', () => {
    const s = buildPullScript({ images, registry: { host: 'ghcr.io', user: 'u', token: 't' } });
    expect(s.indexOf('podman login')).toBeLessThan(s.indexOf('vops_pull'));
  });

  it('names the image that could not be fetched', () => {
    const out = '@@pull\nlocal docker.io/valkey/valkey:9\nfailed ghcr.io/immich-app/postgres:14\n@@done\n';
    expect(parsePullOutput(out)).toEqual({ ran: true, failed: ['ghcr.io/immich-app/postgres:14'] });
  });

  it('does not read a truncated run as success', () => {
    expect(parsePullOutput('@@pull\nlocal a\n').ran).toBe(false);
  });
});

/** A unit killed by its start budget must not reach the user as a bare "services not active". */
describe('deploy diagnostics name a start-timeout', () => {
  it('calls out Result=timeout with the budget that was hit', () => {
    const s = buildDeployScript({
      unitDir: '/etc/containers/systemd/vops/immich',
      units: {},
      secrets: [],
      services: ['vops-immich-redis.service'],
      prereqServices: [],
      quadletGenerator: '/gen',
    });
    expect(s).toContain('systemctl show -p Result --value');
    expect(s).toContain('never signalled readiness within TimeoutStartSec=300s');
  });
});
