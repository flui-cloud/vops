import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planEnvImport, pruneEnvFile, readEnvValues } from '../src/lib/keyring/env-import';
import { keyringCookie, resetKeyringCookie } from '../src/lib/keyring/keyring-cookie';
import { SecretReader } from '../src/lib/keyring/prompt';

const ENV_FILE = `# vops credentials
OS_AUTH_URL=https://auth.example/v3
OS_USERNAME=user-abc
OS_PASSWORD=super-secret

# not ours
EDITOR=vim
export CONTABO_CLIENT_SECRET=cs-123
CONTABO_API_USER=someone@example.com
`;

function tempFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

describe('plaintext .env import', () => {
  it('takes credentials and leaves everything else alone', () => {
    const plan = planEnvImport(tempFile(ENV_FILE));
    const names = plan.entries.map((e) => e.name).sort();
    expect(names).toEqual([
      'CONTABO_API_USER',
      'CONTABO_CLIENT_SECRET',
      'OS_AUTH_URL',
      'OS_PASSWORD',
      'OS_USERNAME',
    ]);
    expect(plan.ignored).toEqual(['EDITOR']);
  });

  it('marks the values that are themselves the secret', () => {
    const plan = planEnvImport(tempFile(ENV_FILE));
    const secrets = plan.entries.filter((e) => e.kind === 'secret').map((e) => e.name).sort();
    expect(secrets).toEqual(['CONTABO_CLIENT_SECRET', 'OS_PASSWORD']);
  });

  it('is empty (not an error) when there is no file', () => {
    expect(planEnvImport(path.join(os.tmpdir(), 'vops-absent-.env')).entries).toEqual([]);
  });

  it('reads the values only when asked', () => {
    const plan = planEnvImport(tempFile(ENV_FILE));
    expect(readEnvValues(plan).OS_PASSWORD).toBe('super-secret');
    expect(JSON.stringify(plan)).not.toContain('super-secret');
  });

  it('prunes only the imported assignments, keeping comments and neighbours', () => {
    const file = tempFile(ENV_FILE);
    const { removed, backup } = pruneEnvFile(file, ['OS_PASSWORD', 'CONTABO_CLIENT_SECRET']);
    const after = fs.readFileSync(file, 'utf8');

    expect(removed.sort()).toEqual(['CONTABO_CLIENT_SECRET', 'OS_PASSWORD']);
    expect(after).not.toContain('super-secret');
    expect(after).not.toContain('cs-123');
    expect(after).toContain('# vops credentials');
    expect(after).toContain('EDITOR=vim');
    expect(after).toContain('OS_USERNAME=user-abc');
    // The only step that destroys plaintext leaves a way back.
    expect(fs.readFileSync(backup, 'utf8')).toBe(ENV_FILE);
    expect(fs.statSync(backup).mode & 0o077).toBe(0);
  });

  it('matches `export FOO=` as an assignment to FOO', () => {
    const file = tempFile('export OS_PASSWORD=x\n');
    pruneEnvFile(file, ['OS_PASSWORD']);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('');
  });
});

describe('keyring cookie', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-cookie-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is stable across calls and unreadable by others', () => {
    const cookie = keyringCookie(dir);
    expect(cookie).toHaveLength(64);
    expect(keyringCookie(dir)).toBe(cookie);
    expect(fs.statSync(path.join(dir, 'keyring.cookie')).mode & 0o077).toBe(0);
  });

  it('repairs a widened mode rather than trusting it', () => {
    keyringCookie(dir);
    const file = path.join(dir, 'keyring.cookie');
    fs.chmodSync(file, 0o644);
    keyringCookie(dir);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('mints a new one after a reset', () => {
    const first = keyringCookie(dir);
    resetKeyringCookie(dir);
    expect(keyringCookie(dir)).not.toBe(first);
  });
});

describe('passphrase keystrokes', () => {
  const read = (...chunks: string[]) => {
    const reader = new SecretReader();
    const state = chunks.map((c) => reader.feed(c)).pop();
    return { state, value: reader.value };
  };

  it('accepts on Enter and keeps what was typed', () => {
    expect(read('hunter2\r')).toEqual({ state: 'accept', value: 'hunter2' });
  });

  it('survives a character split across two reads', () => {
    // The reason stdin is decoded as utf8 rather than byte by byte.
    expect(read('pass', 'é', '\n').value).toBe('passé');
  });

  it('deletes a whole code point on backspace', () => {
    expect(read('passé\u007f\r').value).toBe('pass');
  });

  it('swallows arrow keys instead of typing them into the passphrase', () => {
    expect(read('ab\u001b[Acd\r').value).toBe('abcd');
  });

  it('cancels on Ctrl-C', () => {
    expect(read('abc\u0003').state).toBe('cancel');
  });

  it('treats Ctrl-D as cancel only on an empty buffer', () => {
    expect(read('\u0004').state).toBe('cancel');
    expect(read('abc\u0004\r')).toEqual({ state: 'accept', value: 'abc' });
  });
});
