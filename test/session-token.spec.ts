import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSessionToken, sessionToken, tokenMatches } from '../src/local-api/session-token';

function withTempProfile<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-session-'));
  const prevDir = process.env.VOPS_CONFIG_DIR;
  const prevSession = process.env.VOPS_SESSION;
  process.env.VOPS_CONFIG_DIR = dir;
  delete process.env.VOPS_SESSION;
  try {
    return fn(dir);
  } finally {
    process.env.VOPS_CONFIG_DIR = prevDir;
    if (prevSession === undefined) delete process.env.VOPS_SESSION;
    else process.env.VOPS_SESSION = prevSession;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tokenPath = (dir: string) => path.join(dir, 'profiles', 'default', 'session.key');

describe('session token persistence', () => {
  it('mints once and returns the same token on a later run', () => {
    withTempProfile(() => {
      const first = sessionToken();
      expect(first).toHaveLength(48);
      expect(sessionToken()).toBe(first);
    });
  });

  it('writes the token 0600 inside a 0700 profile dir', () => {
    withTempProfile((dir) => {
      sessionToken();
      const file = tokenPath(dir);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o700).toBe(0o700);
    });
  });

  it('repairs a widened file mode on read', () => {
    withTempProfile((dir) => {
      const first = sessionToken();
      fs.chmodSync(tokenPath(dir), 0o644);
      expect(sessionToken()).toBe(first);
      expect(fs.statSync(tokenPath(dir)).mode & 0o077).toBe(0);
    });
  });

  it('mints a fresh token when the stored one is empty or missing', () => {
    withTempProfile((dir) => {
      const first = sessionToken();
      fs.writeFileSync(tokenPath(dir), '   \n');
      const second = sessionToken();
      expect(second).not.toBe(first);

      resetSessionToken();
      expect(fs.existsSync(tokenPath(dir))).toBe(false);
      expect(sessionToken()).not.toBe(second);
    });
  });

  it('lets VOPS_SESSION win so a parent process can inject one', () => {
    withTempProfile((dir) => {
      process.env.VOPS_SESSION = 'injected-by-parent';
      expect(sessionToken()).toBe('injected-by-parent');
      expect(fs.existsSync(tokenPath(dir))).toBe(false);
    });
  });
});

describe('tokenMatches', () => {
  it('accepts the exact token and rejects everything else', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true);
    expect(tokenMatches('abc124', 'abc123')).toBe(false);
    expect(tokenMatches(undefined, 'abc123')).toBe(false);
    expect(tokenMatches('', 'abc123')).toBe(false);
  });

  it('does not throw on a length mismatch', () => {
    expect(() => tokenMatches('short', 'a-much-longer-token')).not.toThrow();
    expect(tokenMatches('short', 'a-much-longer-token')).toBe(false);
  });
});
