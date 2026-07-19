import { deriveConnState, sshOutcome } from '../src/host-ops/ssh-conn';

const HOST = { user: 'root', address: '203.0.113.9', port: 22 };

describe('sshOutcome', () => {
  it('exit 0 → reachable + authorized', () => {
    expect(sshOutcome(0, '')).toEqual({ reachable: true, authorized: true, reason: '' });
  });
  it('permission denied → reachable but not authorized (endpoint answered)', () => {
    const o = sshOutcome(255, 'root@x: Permission denied (publickey).');
    expect(o.reachable).toBe(true);
    expect(o.authorized).toBe(false);
  });
  it('timeout → unreachable', () => {
    const o = sshOutcome(255, 'ssh: connect to host x port 22: Operation timed out');
    expect(o.reachable).toBe(false);
    expect(o.authorized).toBe(false);
    expect(o.reason).toMatch(/timed out/);
  });
  it('connection refused → unreachable', () => {
    expect(sshOutcome(255, 'ssh: connect to host x port 22: Connection refused').reachable).toBe(false);
  });
});

describe('deriveConnState (structural: reachable → key → authorized)', () => {
  it('no key → no-key, points at assigning one', () => {
    const r = deriveConnState({ reachable: true, hasKey: false, authorized: false, keyKind: 'none', host: HOST });
    expect(r.state).toBe('no-key');
    expect(r.message).toMatch(/pick a local key|generate/i);
  });
  it('has key but unreachable → unreachable (network fix, not auth)', () => {
    const r = deriveConnState({ reachable: false, hasKey: true, authorized: false, keyKind: 'user', host: HOST, reason: 'Operation timed out' });
    expect(r.state).toBe('unreachable');
    expect(r.message).toMatch(/accept SSH from this machine/i);
  });
  it('reachable + key + not authorized → auth-failed (authorize the key)', () => {
    const r = deriveConnState({ reachable: true, hasKey: true, authorized: false, keyKind: 'user', host: HOST });
    expect(r.state).toBe('auth-failed');
    expect(r.message).toMatch(/authorized/i);
  });
  it('an assigned key that is refused → names it and says to authorize it', () => {
    const r = deriveConnState({
      reachable: true, hasKey: true, authorized: false, keyKind: 'user', host: HOST,
      keyName: 'bootstrap', keySource: 'assigned',
    });
    expect(r.state).toBe('auth-failed');
    expect(r.message).toMatch(/'bootstrap'/);
    expect(r.message).toMatch(/add its public half/i);
  });
  it('a fallback key that is refused → says it was never assigned, offers reassigning first', () => {
    const r = deriveConnState({
      reachable: true, hasKey: true, authorized: false, keyKind: 'user', host: HOST,
      keyName: 'laptop', keySource: 'default',
    });
    expect(r.state).toBe('auth-failed');
    expect(r.message).toMatch(/isn't assigned to this host/i);
    expect(r.message).toMatch(/assign the right key/i);
  });
  it('reachable + key + authorized → ready, naming the key kind', () => {
    const r = deriveConnState({ reachable: true, hasKey: true, authorized: true, keyKind: 'ops', host: HOST });
    expect(r.state).toBe('ready');
    expect(r.message).toMatch(/ops key/);
  });
});
