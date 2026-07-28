import { buildRemoveScript } from '../src/apps/app-scripts';

const base = {
  unitDir: '/etc/containers/systemd/vops-wp',
  services: ['vops-wp-db.service', 'vops-wp-web.service'],
  prereqServices: ['vops-wp-pod.service'],
  containers: ['vops-wp-db', 'vops-wp-web'],
  pod: 'vops-wp',
  secrets: ['vops-wp-db-password'],
  volumes: ['vops-wp-db-data'],
};

describe('buildRemoveScript — bounded teardown', () => {
  it('caps each stop and force-kills so a stuck container cannot stall the remove', () => {
    const s = buildRemoveScript({ ...base, purge: false });
    for (const unit of ['vops-wp-web.service', 'vops-wp-db.service', 'vops-wp-pod.service']) {
      expect(s).toContain(`timeout 12 systemctl stop '${unit}'`);
      expect(s).toContain(`systemctl kill -s SIGKILL '${unit}'`);
    }
    // Still force-removes the pod + containers after the bounded stops.
    expect(s).toContain(`podman pod rm -f 'vops-wp'`);
    expect(s).toContain(`podman rm -f 'vops-wp-db'`);
  });

  it('stops app services in reverse, then the prereq (pod/volume) services', () => {
    const s = buildRemoveScript({ ...base, purge: false });
    const web = s.indexOf('systemctl stop \'vops-wp-web.service\'');
    const db = s.indexOf('systemctl stop \'vops-wp-db.service\'');
    const pod = s.indexOf('systemctl stop \'vops-wp-pod.service\'');
    expect(web).toBeGreaterThanOrEqual(0);
    expect(web).toBeLessThan(db); // reversed: web before db
    expect(db).toBeLessThan(pod); // prereqs last
  });

  it('only deletes volumes/secrets when purging', () => {
    const kept = buildRemoveScript({ ...base, purge: false });
    expect(kept).not.toContain('podman secret rm');
    expect(kept).not.toContain('podman volume rm');
    expect(kept).toContain('kept-data');

    const purged = buildRemoveScript({ ...base, purge: true });
    expect(purged).toContain(`podman secret rm 'vops-wp-db-password'`);
    expect(purged).toContain(`podman volume rm 'vops-wp-db-data'`);
    expect(purged).toContain('purged');
  });
});
