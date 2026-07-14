import {
  alreadyApplied,
  cancelDeadmanScript,
  lockdownProbeScript,
  lockdownScript,
  parseDeadmanPid,
  parseLockdownProbe,
  parsePasswordLogins,
  PASSWORD_LOCKDOWN,
  revertNowScript,
  sshdEffectiveValue,
  DEADMAN_UNIT,
  DROPIN,
} from '../src/host-ops/ssh-lockdown';

describe('PASSWORD_LOCKDOWN', () => {
  it('is the single password-auth-off directive', () => {
    expect(PASSWORD_LOCKDOWN).toEqual([{ key: 'PasswordAuthentication', value: 'no', effective: 'no' }]);
  });
});

describe('parsePasswordLogins', () => {
  const journal = [
    'Accepted publickey for root from 203.0.113.7 port 5 ssh2',
    'Accepted password for deploy from 198.51.100.9 port 4 ssh2',
    'Accepted password for deploy from 198.51.100.9 port 6 ssh2',
    'Accepted password for admin from 45.9.20.5 port 7 ssh2',
    'Failed password for root from 1.2.3.4 port 8 ssh2',
    'Accepted password for invalid user x from 9.9.9.9 port 1 ssh2',
  ].join('\n');
  it('counts only successful PASSWORD logins, by account, busiest first', () => {
    expect(parsePasswordLogins(journal)).toEqual([
      { user: 'deploy', count: 2 },
      { user: 'admin', count: 1 },
    ]);
  });
  it('ignores publickey logins entirely (safe to lock down)', () => {
    expect(parsePasswordLogins('Accepted publickey for root from 1.1.1.1 port 1 ssh2')).toEqual([]);
    expect(parsePasswordLogins('')).toEqual([]);
  });
});

describe('sshdEffectiveValue / alreadyApplied', () => {
  const sshdT = 'permitrootlogin without-password\npasswordauthentication yes\nport 22';
  it('reads the effective value (lowercased)', () => {
    expect(sshdEffectiveValue(sshdT, 'PasswordAuthentication')).toBe('yes');
    expect(sshdEffectiveValue(sshdT, 'PermitRootLogin')).toBe('without-password');
    expect(sshdEffectiveValue(sshdT, 'Nope')).toBeNull();
  });
  it('detects whether the password directive is already applied', () => {
    expect(alreadyApplied(sshdT, PASSWORD_LOCKDOWN)).toBe(false);
    const hardened = 'passwordauthentication no';
    expect(alreadyApplied(hardened, PASSWORD_LOCKDOWN)).toBe(true);
  });
});

describe('lockdownScript (safety invariants)', () => {
  const s = lockdownScript(PASSWORD_LOCKDOWN, 10);
  it('arms the dead-man BEFORE writing config', () => {
    const armIdx = s.indexOf('systemd-run');
    const writeIdx = s.indexOf('PasswordAuthentication no');
    expect(armIdx).toBeGreaterThan(-1);
    expect(armIdx).toBeLessThan(writeIdx);
    expect(s).toContain(`--unit=${DEADMAN_UNIT}`);
    expect(s).toContain('--on-active=10min');
    expect(s).toContain('nohup'); // non-systemd fallback survives session close
  });
  it('writes to the first-sorting drop-in and consolidates the legacy file', () => {
    expect(s).toContain(DROPIN);
    expect(DROPIN).toContain('00-vops.conf');
    expect(s).toContain('50-vops.conf'); // legacy consolidation
  });
  it('validates with sshd -t and self-reverts on failure, then verifies reload', () => {
    expect(s).toContain('sshd -t');
    expect(s).toContain('VOPS_SSHDT_FAIL');
    expect(s).toContain('VOPS_RELOAD_OK');
    expect(s).toContain('VOPS_RELOAD_FAIL');
    expect(s).toContain('VOPS_APPLIED');
  });
  it('never calls flush/restart (reload only, targeted HUP)', () => {
    expect(s).not.toMatch(/restart/);
    expect(s).toContain('pkill -HUP -x sshd');
  });
});

describe('cancel / revert / pid', () => {
  it('cancel stops the timer, removes the revert script, and kills a fallback pid when given', () => {
    expect(cancelDeadmanScript()).toContain(`stop ${DEADMAN_UNIT}.timer`);
    expect(cancelDeadmanScript()).toContain('VOPS_DEADMAN_CANCELLED');
    expect(cancelDeadmanScript('4242')).toContain('kill 4242');
    expect(cancelDeadmanScript()).not.toMatch(/kill \d/);
  });
  it('revertNow runs the revert script then cancels', () => {
    const r = revertNowScript();
    expect(r).toContain('sshd-revert.sh');
    expect(r).toContain('VOPS_REVERTED');
  });
  it('parses the dead-man pid from run output', () => {
    expect(parseDeadmanPid('VOPS_DEADMAN=pid:9931\nVOPS_APPLIED')).toBe('9931');
    expect(parseDeadmanPid('VOPS_DEADMAN=systemd\nVOPS_APPLIED')).toBeUndefined();
  });
});

describe('lockdown signal probe', () => {
  it('escalates inline and reads all signals; parses them back', () => {
    const script = lockdownProbeScript(14);
    expect(script).toContain('sudo -n true');
    expect(script).toContain('sshd -T');
    expect(script).toContain('Accepted password');
    const out = [
      '===SUDO===', 'ok',
      '===SSHDT===', 'permitrootlogin yes\npasswordauthentication yes',
      '===PWLOGINS===', 'Accepted password for deploy from 1.1.1.1 port 2 ssh2',
      '===ROOTAK===', 'ROOT_AK_ABSENT',
      '===SYSTEMD===', 'SYSTEMD_RUN',
      '===END===',
    ].join('\n');
    const sig = parseLockdownProbe(out);
    expect(sig.sudo).toBe('ok');
    expect(sshdEffectiveValue(sig.sshdT, 'PasswordAuthentication')).toBe('yes');
    expect(sig.passwordLogins).toEqual([{ user: 'deploy', count: 1 }]);
    expect(sig.rootAkPresent).toBe(false);
    expect(sig.systemdRun).toBe(true);
  });
  it('treats an unreadable probe as no-sudo, empty config, nothing detected', () => {
    const sig = parseLockdownProbe('===SUDO===\nno\n===SSHDT===\n===PWLOGINS===\n===ROOTAK===\nROOT_AK_ABSENT\n===SYSTEMD===\nNO_SYSTEMD_RUN\n===END===');
    expect(sig.sudo).toBe('no');
    expect(sig.sshdT).toBe('');
    expect(sig.systemdRun).toBe(false);
  });
});
