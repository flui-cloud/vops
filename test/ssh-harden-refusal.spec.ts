import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from '@oclif/core';
import { ExitCode, exitCodeFor } from '../src/agent-api/agent-envelope';
import { runAgentCommand } from '../src/agent-api/agent-output';
import { SSH_HARDEN_REFUSED, preflightRefusal } from '../src/host-ops/ssh-lockdown-refusal';
import type { LockdownPreflight } from '../src/host-ops/vops-ssh-lockdown.service';

/**
 * `host ssh-harden` without `--yes` previews the lock-out preconditions. Exiting 0 with
 * `status: success` whatever they say makes the exit code identical whether the host can be
 * hardened or must not be. These pin both halves — the refusal signals, the clean preview does not.
 */

const preflight = (over: Partial<LockdownPreflight> = {}): LockdownPreflight => ({
  host: 'web1',
  ok: true,
  alreadyHardened: false,
  userKeyVerified: true,
  passwordLogins: [],
  refusals: [],
  overridable: false,
  deadManMinutes: 10,
  ...over,
});

const noUserKey = { code: 'no-user-key', message: "No personal SSH key is set for 'web1'." };
const notReady = { code: 'not-ready', message: "vops can't reach 'web1' over SSH right now." };
const noSudo = { code: 'no-sudo', message: "vops can't become root on 'web1'." };
const pwLogins = { code: 'password-logins', message: 'Recent password logins detected (deploy ×2).' };

describe('a refusing ssh-harden preview', () => {
  it('reports a prerequisite refusal, which is exit 4', () => {
    const { errors = [] } = preflightRefusal(preflight({ ok: false, refusals: [noUserKey] }));
    const [err] = errors;

    expect(err.code).toBe(SSH_HARDEN_REFUSED);
    expect(err.category).toBe('prerequisite');
    expect(exitCodeFor(err.category)).toBe(ExitCode.MISSING_PREREQUISITE);
    expect(err.recoverable).toBe(false);
    expect(err.message).toContain('web1');
    expect(err.message).toContain(noUserKey.message);
    expect(err.documentation).toContain('#vops_ssh_harden_refused');
  });

  it('carries a way forward, not just prose', () => {
    const { errors, nextActions } = preflightRefusal(preflight({ ok: false, refusals: [noUserKey] }));

    expect(errors?.[0].suggestedAction).toContain('assign the key you log in with');
    expect(nextActions?.map((a) => a.command)).toEqual([
      'vops ssh-key list --json',
      'vops host key set web1 <key> --json',
    ]);
  });

  it("never hands an agent the apply itself — the override is the user's decision", () => {
    const { errors, nextActions } = preflightRefusal(preflight({ ok: false, refusals: [pwLogins], overridable: true }));

    expect(nextActions?.some((a) => a.command.includes('--yes'))).toBe(false);
    expect(errors?.[0].suggestedAction).toContain('--override --yes');
    expect(errors?.[0].recoverable).toBe(false);
  });

  it('does not offer the override when the blockers are not overridable', () => {
    const { errors } = preflightRefusal(preflight({ ok: false, refusals: [noUserKey], overridable: false }));
    expect(errors?.[0].suggestedAction).not.toContain('--override');
    expect(errors?.[0].suggestedAction).toContain('do not pass --yes');
  });

  it('names every blocker once and lists each remedy once', () => {
    const { errors, nextActions } = preflightRefusal(preflight({ ok: false, refusals: [notReady, noSudo] }));

    expect(errors?.[0].message).toContain(notReady.message);
    expect(errors?.[0].message).toContain(noSudo.message);
    expect(nextActions).toEqual([
      { command: 'vops host status web1 --json', description: expect.stringContaining('Probe the host') },
    ]);
  });

  it('still refuses when a future refusal code has no remedy mapped', () => {
    const { errors, nextActions } = preflightRefusal(
      preflight({ ok: false, refusals: [{ code: 'something-new', message: 'A new blocker.' }] }),
    );

    expect(errors?.[0].code).toBe(SSH_HARDEN_REFUSED);
    expect(errors?.[0].suggestedAction).toContain('refusals');
    expect(nextActions?.length).toBeGreaterThan(0);
  });
});

describe('a preview with nothing to refuse', () => {
  it('adds no error, so it stays exit 0', () => {
    expect(preflightRefusal(preflight())).toEqual({});
  });

  it('treats an already-hardened host as done, not refused — applying it is a no-op', () => {
    expect(preflightRefusal(preflight({ ok: false, alreadyHardened: true, refusals: [noUserKey] }))).toEqual({});
  });
});

/** The same two paths through the envelope helper, since the exit code is what a caller branches on. */
describe('the envelope the command emits', () => {
  class FakeExit extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }

  const fakeCommand = () => {
    const out: string[] = [];
    const cmd = {
      id: 'host:ssh-harden',
      log: (line = '') => {
        out.push(line);
      },
      exit: (code = 0): never => {
        throw new FakeExit(code);
      },
      error: (_m: string, opts: { exit?: number } = {}): never => {
        throw new FakeExit(opts.exit ?? 2);
      },
    };
    return { cmd: cmd as unknown as Command, out };
  };

  const emit = async (pre: LockdownPreflight): Promise<{ env: Record<string, never>; code: number }> => {
    const { cmd, out } = fakeCommand();
    let code: number = ExitCode.SUCCESS;
    try {
      await runAgentCommand(cmd, 'vops host ssh-harden', true, async () => ({ data: pre, ...preflightRefusal(pre) }), () => undefined);
    } catch (err) {
      if (!(err instanceof FakeExit)) throw err;
      code = err.code;
    }
    return { env: JSON.parse(out.join('\n')), code };
  };

  it('is an error envelope with exit 4 when the preconditions refuse', async () => {
    const pre = preflight({ ok: false, refusals: [noUserKey] });
    const { env, code } = await emit(pre);

    expect(env).toMatchObject({ status: 'error', requiresApproval: false, data: { refusals: [noUserKey] } });
    expect(code).toBe(ExitCode.MISSING_PREREQUISITE);
  });

  it('is unchanged on the passing path: success, no error, exit 0', async () => {
    const { env, code } = await emit(preflight());

    expect(env).toMatchObject({ status: 'success', errors: [], nextActions: [], data: { ok: true } });
    expect(code).toBe(ExitCode.SUCCESS);
  });
});

/**
 * Observed from outside, where the defect lived: `$?` and stdout. A host record pointing at a
 * closed port refuses with `not-ready` without any machine being involved.
 */
describe('the refusal at the process boundary', () => {
  const root = path.join(__dirname, '..');
  let result: { code: number; stdout: string };

  const run = (argv: string[], configDir: string): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(root, 'bin', 'run'), ...argv, '--json'],
        { env: { ...process.env, VOPS_CONFIG_DIR: configDir }, encoding: 'utf8' },
        (err, stdout) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout }),
      );
    });

  beforeAll(async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-f35-'));
    await run(['host', 'add', 'zz-f35', '--address', '127.0.0.1', '--port', '1'], configDir);
    result = await run(['host', 'ssh-harden', 'zz-f35'], configDir);
  }, 120_000);

  it('writes one envelope to stdout and leaves with 4', () => {
    const env = JSON.parse(result.stdout);

    expect({ exit: result.code, status: env.status, code: env.errors[0]?.code }).toEqual({
      exit: ExitCode.MISSING_PREREQUISITE,
      status: 'error',
      code: SSH_HARDEN_REFUSED,
    });
    expect(env.data.refusals[0].code).toBe('not-ready');
    expect(env.nextActions[0].command).toBe('vops host status zz-f35 --json');
  });
});
