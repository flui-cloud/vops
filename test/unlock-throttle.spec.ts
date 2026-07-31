import { UnlockThrottle } from '../src/lib/keyring/unlock-throttle';

describe('UnlockThrottle', () => {
  let clock = 0;
  const now = () => clock;
  const make = () => new UnlockThrottle({ now });

  beforeEach(() => {
    clock = 1_000_000;
  });

  it('allows a first attempt and clears after success', () => {
    const t = make();
    expect(t.begin()).toBe(true);
    t.record(true);
    expect(t.state()).toEqual({ failures: 0, retryInMs: 0 });
    expect(t.begin()).toBe(true);
  });

  it('refuses a concurrent attempt without consuming a failure', () => {
    const t = make();
    expect(t.begin()).toBe(true);
    expect(t.begin()).toBe(false);
    expect(t.check().busy).toBe(true);
    expect(t.state().failures).toBe(0);
    t.record(true);
    expect(t.begin()).toBe(true);
  });

  it('backs off further on each consecutive failure', () => {
    const t = make();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(t.begin()).toBe(true);
      t.record(false);
      waits.push(t.state().retryInMs);
      clock += waits[waits.length - 1];
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
  });

  it('refuses while the backoff window is open, then allows again', () => {
    const t = make();
    t.begin();
    t.record(false);

    expect(t.begin()).toBe(false);
    clock += 999;
    expect(t.begin()).toBe(false);
    clock += 1;
    expect(t.begin()).toBe(true);
  });

  it('locks out for 15 minutes after ten consecutive failures', () => {
    const t = make();
    for (let i = 0; i < 10; i++) {
      expect(t.begin()).toBe(true);
      t.record(false);
      clock += t.state().retryInMs;
    }
    // The tenth failure is the one that trips the lockout; the loop advanced past
    // the ninth backoff, so what is left is the lockout itself.
    clock -= 15 * 60_000;
    expect(t.state()).toEqual({ failures: 10, retryInMs: 15 * 60_000 });
    expect(t.begin()).toBe(false);
  });

  it('resets the counter once an attempt finally succeeds', () => {
    const t = make();
    t.begin();
    t.record(false);
    clock += 1_000;
    t.begin();
    t.record(true);
    expect(t.state()).toEqual({ failures: 0, retryInMs: 0 });
  });

  it('release() frees the slot without scoring the attempt', () => {
    const t = make();
    t.begin();
    t.release();
    expect(t.state().failures).toBe(0);
    expect(t.begin()).toBe(true);
  });
});
