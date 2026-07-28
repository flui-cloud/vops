import { buildRestartScript, buildStatusScript } from '../src/apps/app-scripts';

const services = ['vops-wp-db.service', 'vops-wp-web.service'];

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
