import { BadRequestException } from '@nestjs/common';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { toFailure } from '../src/agent-api/agent-output';
import { SSH_HARDEN_NOT_APPLIED, SSH_HARDEN_REFUSED, SSH_HARDEN_ROLLED_BACK } from '../src/host-ops/ssh-lockdown-refusal';
import { VopsSshLockdownService } from '../src/host-ops/vops-ssh-lockdown.service';
import type { VopsHost } from '../src/hosts/host.model';

/**
 * The apply path (`--yes`) has three outcomes — blocked by the preconditions,
 * applied-and-not-taken, and applied-then-rolled-back. Thrown as bare `BadRequestException`s they
 * all reach the shell as VOPS_OPERATION_FAILED / exit 1, where a hardening that was **reverted** on
 * a live sshd reads exactly like one that never touched the machine, and like any generic
 * "maybe retry". Each outcome must be distinguishable by code, category and exit, and each must stay
 * an HTTP 400 because `POST /api/hosts/:name/ssh-lockdown` calls the same method.
 */

const host: VopsHost = {
  name: 'web1',
  address: '10.0.0.9',
  user: 'root',
  port: 22,
  opsKeyInstalled: true,
  userKeyName: 'laptop',
  tags: [],
  addedAt: new Date().toISOString(),
};

interface ProbeState {
  sudo: string;
  sshdT: string;
  pwLogins: string;
}

const probe = (s: ProbeState): string =>
  `===SUDO===\n${s.sudo}\n===SSHDT===\n${s.sshdT}\n===PWLOGINS===\n${s.pwLogins}\n===ROOTAK===\nROOT_AK_PRESENT\n===SYSTEMD===\nSYSTEMD_RUN\n===END===\n`;

const OPEN = 'passwordauthentication yes\npermitrootlogin yes';
const CLOSED = 'passwordauthentication no\npermitrootlogin prohibit-password';

interface Fakes {
  /** `sshd -T` seen by the pre-apply probe, and by the post-apply one unless `after` is set. */
  before?: ProbeState;
  /** `sshd -T` the post-apply verify sees — the rollback case is "the change didn't take effect". */
  after?: ProbeState;
  /** The lockdown apply script's result. */
  apply?: { code: number; stdout: string; stderr: string };
  /** Whether the operator's own key authenticates (false at any point = a blocker or a rollback). */
  userKeyOk?: boolean | 'onlyBefore';
}

interface Ran {
  scripts: string[];
}

function service(f: Fakes): { svc: VopsSshLockdownService; ran: Ran } {
  const before = f.before ?? { sudo: 'ok', sshdT: OPEN, pwLogins: '' };
  const ran: Ran = { scripts: [] };
  let applied = false;

  const ssh = {
    runScript: async (_t: unknown, script: string) => {
      ran.scripts.push(script);
      if (script.includes('===SUDO===') || script.includes('echo ===SUDO===')) {
        const state = applied ? (f.after ?? { ...before, sshdT: CLOSED }) : before;
        return { code: 0, stdout: probe(state), stderr: '' };
      }
      if (script.includes('VOPS_APPLIED')) {
        applied = true;
        return f.apply ?? { code: 0, stdout: 'VOPS_DEADMAN=pid:4242\nVOPS_RELOAD_OK\nVOPS_APPLIED\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    run: async () => ({ code: f.userKeyOk === false || (f.userKeyOk === 'onlyBefore' && applied) ? 255 : 0, stdout: '', stderr: '' }),
  };

  const svc = new VopsSshLockdownService(
    { show: () => host } as never,
    { list: () => [], keyPathFor: (name?: string) => (name ? `/keys/${name}` : undefined) } as never,
    { assertReady: async () => undefined } as never,
    ssh as never,
    { appendAudit: async () => undefined } as never,
  );
  return { svc, ran };
}

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (err) {
    return err;
  }
}

describe('ssh-harden --yes: the three failing outcomes are distinguishable', () => {
  it('blocked by the preconditions is the preview refusal: prerequisite, exit 4', async () => {
    const { svc } = service({ userKeyOk: false });
    const failure = toFailure(await thrownBy(() => svc.disable('web1')));

    expect({ code: failure.error.code, category: failure.error.category, exit: failure.exitCode }).toEqual({
      code: SSH_HARDEN_REFUSED,
      category: 'prerequisite',
      exit: ExitCode.MISSING_PREREQUISITE,
    });
    expect(failure.error.message).toContain("didn't authenticate");
    expect(failure.error.suggestedAction).toContain('Nothing was changed');
  });

  it('applied-but-not-taken is operational, exit 1, and says nothing changed', async () => {
    const { svc } = service({ apply: { code: 3, stdout: 'VOPS_DEADMAN=pid:4242\n', stderr: 'VOPS_SSHDT_FAIL: bad config' } });
    const failure = toFailure(await thrownBy(() => svc.disable('web1')));

    expect({ code: failure.error.code, category: failure.error.category, exit: failure.exitCode }).toEqual({
      code: SSH_HARDEN_NOT_APPLIED,
      category: 'operational',
      exit: ExitCode.FAILURE,
    });
    expect(failure.error.message).toContain('bad config');
    expect(failure.error.message).toContain('nothing changed');
    expect(failure.error.suggestedAction).toContain('nothing to undo');
  });

  it('rolled back is exit 8 (partial), because sshd was reconfigured and reverted', async () => {
    const { svc } = service({ after: { sudo: 'ok', sshdT: OPEN, pwLogins: '' } });
    const failure = toFailure(await thrownBy(() => svc.disable('web1')));

    expect({ code: failure.error.code, category: failure.error.category, exit: failure.exitCode }).toEqual({
      code: SSH_HARDEN_ROLLED_BACK,
      category: 'operational',
      exit: ExitCode.PARTIAL,
    });
    expect(failure.error.message).toContain("didn't take effect");
    expect(failure.error.message).toContain('Password login is back on');
  });

  it('rolled back also covers "your key no longer logs in", which is the lock-out case', async () => {
    const { svc, ran } = service({ userKeyOk: 'onlyBefore' });
    const failure = toFailure(await thrownBy(() => svc.disable('web1')));

    expect(failure.error.code).toBe(SSH_HARDEN_ROLLED_BACK);
    expect(failure.error.message).toContain('your key no longer logs in');
    expect(ran.scripts.some((s) => s.includes('VOPS_REVERTED'))).toBe(true);
  });

  it('gives the three outcomes three different codes and three different exits', async () => {
    const outcomes = await Promise.all(
      [
        service({ userKeyOk: false }),
        service({ apply: { code: 4, stdout: '', stderr: 'reload failed' } }),
        service({ after: { sudo: 'ok', sshdT: OPEN, pwLogins: '' } }),
      ].map(async ({ svc }) => toFailure(await thrownBy(() => svc.disable('web1')))),
    );

    expect(new Set(outcomes.map((f) => f.error.code)).size).toBe(3);
    expect(outcomes.map((f) => f.exitCode)).toEqual([
      ExitCode.MISSING_PREREQUISITE,
      ExitCode.FAILURE,
      ExitCode.PARTIAL,
    ]);
    expect(outcomes.every((f) => f.error.code !== 'VOPS_OPERATION_FAILED')).toBe(true);
    expect(outcomes.every((f) => !!f.error.suggestedAction)).toBe(true);
  });

  it.each([
    ['blocked', (): Fakes => ({ userKeyOk: false })],
    ['not applied', (): Fakes => ({ apply: { code: 3, stdout: '', stderr: 'nope' } })],
    ['rolled back', (): Fakes => ({ after: { sudo: 'ok', sshdT: OPEN, pwLogins: '' } })],
  ])('%s stays an HTTP 400 for the local API', async (_name, fakes) => {
    const { svc } = service(fakes());
    const err = await thrownBy(() => svc.disable('web1'));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getStatus()).toBe(400);
  });
});

describe('the outcomes that are not failures are untouched', () => {
  it('a clean apply reports applied and cancels the dead-man', async () => {
    const { svc, ran } = service({});
    await expect(svc.disable('web1')).resolves.toMatchObject({ host: 'web1', applied: true, reverted: false });
    expect(ran.scripts.some((s) => s.includes('VOPS_DEADMAN_CANCELLED'))).toBe(true);
  });

  it('an already-hardened host is a no-op, not any of the three failures', async () => {
    const { svc } = service({ before: { sudo: 'ok', sshdT: CLOSED, pwLogins: '' }, userKeyOk: false });
    await expect(svc.disable('web1')).resolves.toMatchObject({ applied: false, reverted: false, message: 'Already hardened — no change.' });
  });

  it('waives only password-logins under --override, and still refuses with a real blocker', async () => {
    const pw = 'Accepted password for deploy from 10.0.0.1 port 2222';
    await expect(service({ before: { sudo: 'ok', sshdT: OPEN, pwLogins: pw } }).svc.disable('web1', { override: true })).resolves.toMatchObject({
      applied: true,
    });

    const { svc } = service({ before: { sudo: 'no', sshdT: OPEN, pwLogins: pw } });
    const failure = toFailure(await thrownBy(() => svc.disable('web1', { override: true })));
    expect(failure.error.code).toBe(SSH_HARDEN_REFUSED);
    expect(failure.error.message).not.toContain('Recent password logins');
  });
});
