import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RealSshExec, ExecResult, ProcessRunner } from '../src/lib/ssh-exec';
import { VopsHost } from '../src/hosts/host.model';

const host: VopsHost = {
  name: 'h1',
  address: '203.0.113.10',
  user: 'admin',
  port: 2222,
  opsKeyInstalled: false,
  tags: [],
  addedAt: '2026-07-12T00:00:00Z',
};

describe('RealSshExec (fake transport)', () => {
  let dir: string;
  let calls: Array<{ cmd: string; args: string[]; input?: string }>;
  let exec: RealSshExec;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-ssh-exec-'));
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'test';
    calls = [];
    const fake: ProcessRunner = (cmd, args, opts): Promise<ExecResult> => {
      calls.push({ cmd, args, input: opts.input });
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    exec = new RealSshExec(fake);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  it('builds an ssh invocation with the key, port, user@host and the command last', async () => {
    await exec.run({ host, keyPath: '/keys/id' }, 'whoami');
    const c = calls[0];
    expect(c.cmd).toBe('ssh');
    expect(c.args).toEqual(expect.arrayContaining(['-i', '/keys/id', '-p', '2222', 'admin@203.0.113.10']));
    expect(c.args).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes']));
    expect(c.args[c.args.length - 1]).toBe('whoami');
  });

  it('runScript pipes the body over stdin via bash -s', async () => {
    await exec.runScript({ host, keyPath: '/k' }, 'echo hi');
    expect(calls[0].input).toBe('echo hi');
    expect(calls[0].args[calls[0].args.length - 1]).toBe('bash -s');
  });

  it('putFile pipes content over stdin and writes atomically (temp + mv)', async () => {
    await exec.putFile({ host, keyPath: '/k' }, '/etc/vops/x.conf', 'CONTENT', '0600');
    const c = calls[0];
    expect(c.input).toBe('CONTENT');
    const remoteCmd = c.args[c.args.length - 1];
    expect(remoteCmd).toContain('mktemp');
    expect(remoteCmd).toContain('chmod 0600');
    expect(remoteCmd).toContain("mv \"$tmp\" '/etc/vops/x.conf'");
  });

  it('run never throws on a non-zero exit', async () => {
    const failing = new RealSshExec(() => Promise.resolve({ code: 7, stdout: '', stderr: 'boom' }));
    await expect(failing.run({ host, keyPath: '/k' }, 'false')).resolves.toEqual({ code: 7, stdout: '', stderr: 'boom' });
  });
});
