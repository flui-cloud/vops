import { buildDeployScript, buildRestartScript, buildStatusScript } from '../src/apps/app-scripts';

const services = ['vops-wp-db.service', 'vops-wp-web.service'];

describe('buildDeployScript — a redeploy must replace a running container', () => {
  const script = buildDeployScript({
    unitDir: '/etc/containers/systemd/vops/wp',
    units: { 'vops-wp-web.container': '[Container]' },
    secrets: [],
    services,
    prereqServices: ['vops-wp-pod.service'],
    quadletGenerator: '/usr/lib/systemd/system-generators/podman-system-generator',
  });

  it('restarts the app services instead of starting them (start is a no-op when active)', () => {
    for (const s of services) {
      expect(script).toContain(`systemctl restart '${s}'`);
      expect(script).not.toContain(`systemctl start '${s}'`);
    }
  });

  it('clears a start-limit block before restarting', () => {
    for (const s of services) {
      expect(script.indexOf(`systemctl reset-failed '${s}'`)).toBeLessThan(script.indexOf(`systemctl restart '${s}'`));
    }
  });
});

describe('buildRestartScript', () => {
  it('restarts each service before reporting status, in order', () => {
    const s = buildRestartScript('wp', services);
    const restartDb = s.indexOf(`systemctl restart 'vops-wp-db.service'`);
    const restartWeb = s.indexOf(`systemctl restart 'vops-wp-web.service'`);
    const units = s.indexOf("echo '@@units'");
    expect(restartDb).toBeGreaterThanOrEqual(0);
    expect(restartDb).toBeLessThan(restartWeb);
    expect(restartWeb).toBeLessThan(units);
  });

  it('reports back the exact same @@units/@@containers trailer as a status check', () => {
    const restart = buildRestartScript('wp', services);
    const status = buildStatusScript('wp', services);
    const trailerOf = (s: string) => s.slice(s.indexOf("echo '@@units'"));
    expect(trailerOf(restart)).toBe(trailerOf(status));
  });
});
