import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { AgentBadRequest } from '../src/agent-api/agent-http-errors';
import { parsePublicKey, publicKeyFingerprint } from '../src/ssh-keys/public-key-material';
import { VopsSshKeysService } from '../src/ssh-keys/vops-ssh-keys.service';

/**
 * Checked only by a prefix regex on the label, `ssh-key import <name> --public-key "<garbage>"`
 * stores the garbage and exits 0 — the key lands in the store with `fingerprint: ''` (ssh-keygen
 * cannot read it) and authorizes nothing.
 *
 * Both halves are pinned here, for every kind of garbage: a typed refusal with a real
 * code/category/exit, AND nothing left on disk — not the `.pub`, not the `.path` reference sidecar
 * an aborted `--from` would leave behind, not even the key-store directory.
 */
/** `uint32 length + bytes`, the one primitive an SSH key blob is built from. */
function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

describe('ssh-key import refuses invalid public-key material', () => {
  let dir: string;
  let keys: string;
  let priv: string;
  let pub: string;
  let body: string;

  const svc = () => new VopsSshKeysService({} as any, {} as any, {} as any);
  const stored = (): string[] => (fs.existsSync(keys) ? fs.readdirSync(keys).sort() : []);

  const refusal = (fn: () => unknown): AgentBadRequest => {
    try {
      fn();
    } catch (e) {
      if (e instanceof AgentBadRequest) return e;
      throw new Error(`expected an AgentBadRequest, got ${e}`);
    }
    throw new Error('expected a refusal, the import succeeded');
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-f53-'));
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'f53';
    keys = path.join(dir, 'profiles', 'f53', 'keys');
    priv = path.join(dir, 'real');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', priv, '-N', '', '-C', 'real'], { stdio: 'ignore' });
    pub = fs.readFileSync(`${priv}.pub`, 'utf8').trim();
    body = pub.split(/\s+/)[1];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  /** Refused with that code, and the key store still holds nothing at all. */
  const expectRefused = (value: string, code: string): void => {
    const e = refusal(() => svc().import('bad', { publicKey: value }));
    expect({ value: value.slice(0, 24), code: e.agent.code, category: e.agent.category, exit: e.exitCode }).toEqual({
      value: value.slice(0, 24),
      code,
      category: 'input',
      exit: ExitCode.INVALID_INPUT,
    });
    expect(e.agent.suggestedAction).toContain('Nothing was stored');
    expect(stored()).toEqual([]);
  };

  // Static garbage — `it.each` is built at describe time, before any key exists.
  it.each([
    ['an empty string', '', 'VOPS_SSH_KEY_MATERIAL_MISSING'],
    ['whitespace only', '   ', 'VOPS_SSH_KEY_MATERIAL_MISSING'],
    ['random text', 'totally not a key', 'VOPS_SSH_KEY_MATERIAL_INVALID'],
    ['a valid-looking prefix with corrupt base64', 'ssh-ed25519 !!!!notbase64!!!!', 'VOPS_SSH_KEY_MATERIAL_INVALID'],
    ['a label with no body', 'ssh-ed25519', 'VOPS_SSH_KEY_MATERIAL_INVALID'],
    ['a truncated blob', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5', 'VOPS_SSH_KEY_MATERIAL_INVALID'],
    ['an ed25519 key that is not 32 bytes', `ssh-ed25519 ${Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(31))]).toString('base64')}`, 'VOPS_SSH_KEY_MATERIAL_INVALID'],
  ])('refuses %s with a typed input error and stores nothing', (_what, value, code) => {
    expectRefused(value, code);
  });

  it('refuses garbage derived from a real key: truncated, mislabelled, doubled, unlabelled', () => {
    expectRefused(`ssh-ed25519 ${body.slice(0, 40)}`, 'VOPS_SSH_KEY_MATERIAL_INVALID');
    expectRefused(`ssh-rsa ${body}`, 'VOPS_SSH_KEY_MATERIAL_INVALID');
    expectRefused(`${pub}\n${pub}`, 'VOPS_SSH_KEY_MATERIAL_INVALID');
    expectRefused(body, 'VOPS_SSH_KEY_MATERIAL_INVALID');
    expectRefused(`ssh-ed25519 ${body}AAAA`, 'VOPS_SSH_KEY_MATERIAL_INVALID');
  });

  it('refuses a PRIVATE key pasted where a public one belongs, without echoing it', () => {
    const secret = fs.readFileSync(priv, 'utf8');
    const e = refusal(() => svc().import('oops', { publicKey: secret.replaceAll('\n', ' ') }));
    expect({ code: e.agent.code, exit: e.exitCode, recoverable: e.agent.recoverable }).toEqual({
      code: 'VOPS_SSH_KEY_MATERIAL_PRIVATE',
      exit: ExitCode.INVALID_INPUT,
      recoverable: false,
    });
    const material = secret.split('\n')[1];
    expect(e.agent.message.includes(material)).toBe(false);
    expect(stored()).toEqual([]);
  });

  it('refuses a --pub file that holds a private key', () => {
    const e = refusal(() => svc().import('oops', { publicKeyPath: priv }));
    expect(e.agent.code).toBe('VOPS_SSH_KEY_MATERIAL_PRIVATE');
    expect(stored()).toEqual([]);
  });

  it('refuses a missing --from / --pub path with VOPS_SSH_KEY_FILE_MISSING', () => {
    for (const input of [{ privateKeyPath: `${dir}/nope` }, { publicKeyPath: `${dir}/nope.pub` }]) {
      const e = refusal(() => svc().import('gone', input));
      expect({ code: e.agent.code, exit: e.exitCode }).toEqual({
        code: 'VOPS_SSH_KEY_FILE_MISSING',
        exit: ExitCode.INVALID_INPUT,
      });
    }
    expect(stored()).toEqual([]);
  });

  it('leaves NO .path sidecar when --from names a file that is not a key', () => {
    const junk = path.join(dir, 'junk');
    fs.writeFileSync(junk, 'not a key at all\n', { mode: 0o600 });
    const e = refusal(() => svc().import('junk', { privateKeyPath: junk }));
    expect({ code: e.agent.code, exit: e.exitCode }).toEqual({
      code: 'VOPS_SSH_KEY_MATERIAL_INVALID',
      exit: ExitCode.INVALID_INPUT,
    });
    // the sidecar must not be written before the material is validated
    expect(stored()).toEqual([]);
    expect(fs.existsSync(path.join(keys, 'junk.path'))).toBe(false);
  });

  it('refuses nothing valid: a good key still imports, with a real fingerprint', () => {
    const key = svc().import('good', { publicKey: pub });
    expect(key.fingerprint).not.toBe('');
    expect(stored()).toEqual(['good.pub']);
    expect(svc().list().every((k) => k.fingerprint !== '')).toBe(true);
  });

  it('computes the same fingerprint ssh-keygen prints, for every algorithm it accepts', () => {
    for (const type of ['ed25519', 'rsa', 'ecdsa'] as const) {
      const f = path.join(dir, `k-${type}`);
      execFileSync('ssh-keygen', ['-t', type, '-f', f, '-N', '', '-C', type], { stdio: 'ignore' });
      const expected = execFileSync('ssh-keygen', ['-lf', `${f}.pub`], { encoding: 'utf8' }).trim().split(/\s+/)[1];
      const key = svc().import(`k-${type}`, { publicKeyPath: `${f}.pub` });
      expect({ type, fingerprint: key.fingerprint }).toEqual({ type, fingerprint: expected });
    }
  });

  it('parses a real key into the blob its fingerprint is taken over', () => {
    const parsed = parsePublicKey(pub);
    if (parsed.ok !== true) throw new Error(`expected a parse, got ${parsed.reason}`);
    expect(parsed.algorithm).toBe('ssh-ed25519');
    expect(parsed.comment).toBe('real');
    expect(publicKeyFingerprint(parsed.blob)).toBe(
      execFileSync('ssh-keygen', ['-lf', `${priv}.pub`], { encoding: 'utf8' }).trim().split(/\s+/)[1],
    );
  });
});
