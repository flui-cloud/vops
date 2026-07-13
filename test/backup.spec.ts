import { RESTIC_BINARIES, RESTIC_VERSION, resticForArch } from '../src/backup/restic-manifest';
import {
  parseKeepPolicy,
  renderBackupEnv,
  renderBackupScript,
  renderResticInstall,
} from '../src/backup/backup-render';

describe('restic manifest', () => {
  it('pins a version with 64-hex sha256 per arch and the matching URL', () => {
    for (const arch of ['amd64', 'arm64'] as const) {
      const b = RESTIC_BINARIES[arch];
      expect(b.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(b.url).toContain(`restic_${RESTIC_VERSION}_linux_${arch}.bz2`);
    }
  });

  it('maps uname -m to the right binary', () => {
    expect(resticForArch('x86_64')).toBe(RESTIC_BINARIES.amd64);
    expect(resticForArch('aarch64')).toBe(RESTIC_BINARIES.arm64);
    expect(resticForArch('armv7l')).toBeNull();
  });
});

describe('backup renderers', () => {
  it('parses a retention policy into restic forget flags', () => {
    expect(parseKeepPolicy('7d4w6m')).toEqual(['--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '6']);
    expect(parseKeepPolicy('24h2y')).toEqual(['--keep-hourly', '24', '--keep-yearly', '2']);
    expect(parseKeepPolicy(undefined)).toEqual(['--keep-daily', '7']); // sane default
  });

  it('renders an env file with repo + password + optional s3 creds', () => {
    const env = renderBackupEnv({ repository: 's3:https://x/b', password: 'pw', s3AccessKey: 'AK', s3SecretKey: 'SK' });
    expect(env).toContain("export RESTIC_REPOSITORY='s3:https://x/b'");
    expect(env).toContain("export RESTIC_PASSWORD='pw'");
    expect(env).toContain("export AWS_ACCESS_KEY_ID='AK'");
    expect(renderBackupEnv({ repository: 'r', password: 'p' })).not.toContain('AWS_ACCESS_KEY_ID');
  });

  it('renders a wrapper that backs up, prunes and pings on failure', () => {
    const sh = renderBackupScript(['/etc', '/var/www'], ['--keep-daily', '7']);
    expect(sh).toContain("backup --tag vops '/etc' '/var/www'");
    expect(sh).toContain('forget --prune --keep-daily 7');
    expect(sh).toContain('VOPS_BACKUP_PING');
    expect(sh).toContain('exit $FAIL');
  });

  it('self-verifies the binary against the manifest sha before install', () => {
    const script = renderResticInstall(RESTIC_BINARIES.amd64);
    expect(script).toContain(RESTIC_BINARIES.amd64.sha256);
    expect(script).toContain('sha256sum -c -');
    expect(script).toContain('/usr/local/bin/vops-restic');
  });
});
