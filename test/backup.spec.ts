import { RESTIC_BINARIES, RESTIC_VERSION, resticForArch } from '../src/backup/restic-manifest';
import {
  RESTIC_NO_BZIP2_MARKER,
  parseKeepPolicy,
  renderBackupEnv,
  renderBackupScript,
  renderResticInstall,
} from '../src/backup/backup-render';
import { resticInstallFailure } from '../src/backup/restic-install-error';
import { AgentBadRequest } from '../src/agent-api/agent-http-errors';
import { ExitCode } from '../src/agent-api/agent-envelope';

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

// A stock Ubuntu 24.04 cloud image has no bunzip2, and the install
// script ran it unconditionally.
describe('restic install script — decompression on a host without bzip2', () => {
  const script = renderResticInstall(RESTIC_BINARIES.amd64);
  const lines = script.split('\n');

  it('never invokes bunzip2 unguarded', () => {
    expect(script).not.toContain('bunzip2 -f "$tmp.bz2"');
    expect(lines.filter((l) => /^\s*bunzip2\s/.test(l))).toEqual([]);
    expect(script).toContain('command -v bunzip2 >/dev/null 2>&1');
  });

  it('picks the decompressor at runtime, never from an OS family', () => {
    for (const probe of ['command -v bzip2', 'command -v python3', 'command -v busybox']) {
      expect(script).toContain(probe);
    }
    expect(script).toContain('import bz2,shutil,sys');
    expect(script).toContain('busybox bunzip2 -c "$1" > "$2"');
  });

  it('installs bzip2 non-interactively as a last resort, per package manager', () => {
    expect(script).toContain('export DEBIAN_FRONTEND=noninteractive');
    expect(script).toContain('apt-get install -y -qq bzip2');
    expect(script).toContain('dnf install -y -q bzip2');
    expect(script).toContain('yum install -y -q bzip2');
    expect(script).toContain('apk add --no-cache bzip2');
    // the package manager is reached only when no decompressor was found
    expect(script.indexOf('vops_install_bz2 || return 1')).toBeGreaterThan(script.indexOf('vops_bz2_tool() {'));
  });

  it('refreshes the apt index only after an install attempt failed', () => {
    expect(script.indexOf('apt-get update -qq')).toBeGreaterThan(script.indexOf('apt-get install -y -qq bzip2'));
  });

  it('keeps the checksum verification ahead of any decompression', () => {
    expect(script.indexOf('sha256sum -c -')).toBeLessThan(script.indexOf('vops_decompress "$tmp.bz2"'));
    expect(script.indexOf('sha256sum -c -')).toBeLessThan(script.indexOf('command -v bunzip2'));
    expect(script).toContain(RESTIC_BINARIES.amd64.url);
  });

  it('fails with a recognisable marker instead of a bare shell error', () => {
    expect(script).toContain(`echo '${RESTIC_NO_BZIP2_MARKER}:`);
    expect(script).toContain('exit 4');
    expect(script).toContain('rm -f "$tmp" "$tmp.bz2"');
  });
});

describe('restic install failure classification', () => {
  it('names the exact remedy when no decompressor could be found or installed', () => {
    const err = resticInstallFailure(`${RESTIC_NO_BZIP2_MARKER}: no bzip2 decompressor on this host\n`);
    expect(err).toBeInstanceOf(AgentBadRequest);
    const agent = (err as AgentBadRequest).agent;
    expect(agent.code).toBe('VOPS_RESTIC_DECOMPRESS_UNAVAILABLE');
    expect(agent.category).toBe('prerequisite');
    expect(agent.suggestedAction).toContain('apt-get install -y bzip2');
    expect((err as AgentBadRequest).exitCode).toBe(ExitCode.MISSING_PREREQUISITE);
  });

  it('classifies the bare shell error the same way', () => {
    const err = resticInstallFailure('bash: line 5: bunzip2: command not found');
    expect(err).toBeInstanceOf(AgentBadRequest);
    expect((err as AgentBadRequest).agent.suggestedAction).toContain('apk add bzip2');
  });

  it('leaves every other install failure generic', () => {
    expect(resticInstallFailure('sha256sum: WARNING: 1 computed checksum did NOT match')).not.toBeInstanceOf(
      AgentBadRequest,
    );
    expect(resticInstallFailure('').message).toBe('restic install/verify failed: checksum mismatch');
  });
});
