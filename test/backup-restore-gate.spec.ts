import { parseRestoreTargetState, renderRestoreTargetProbe } from '../src/backup/backup-render';
import { VopsBackupService } from '../src/backup/vops-backup.service';

/**
 * `backup restore` must not run restic for real on the first call: restic unpacks a whole snapshot
 * into `--target` over whatever is already sitting there, so it needs the same class-C consent
 * gate every other write path has.
 */

const HOST = { name: 'web1', address: '203.0.113.5', user: 'root', port: 22, opsKeyInstalled: false, userKeyName: 'work' };

function svc(answer: (command: string) => { code: number; stdout: string; stderr: string }) {
  const ran: string[] = [];
  const ssh = {
    run: async (_t: unknown, command: string) => {
      ran.push(command);
      return answer(command);
    },
  };
  const hosts = { show: () => HOST };
  const keys = { list: () => [], keyPathFor: () => '/keys/work' };
  return { s: new VopsBackupService(hosts as never, keys as never, ssh as never), ran };
}

const probeAnswers = (state: string) => (command: string) =>
  command.includes('echo missing')
    ? { code: 0, stdout: `${state}\n`, stderr: '' }
    : { code: 0, stdout: '', stderr: '' };

const restored = (ran: string[]): string[] => ran.filter((c) => c.includes('vops-restic restore'));

describe('backup restore — the consent gate', () => {
  it('runs nothing on the host but the collision probe when approval is missing', async () => {
    const { s, ran } = svc(probeAnswers('empty'));
    const plan = await s.restore('web1', { snapshot: 'latest', target: '/restore' });

    expect(restored(ran)).toEqual([]);
    expect(ran).toEqual([renderRestoreTargetProbe('/restore')]);
    expect(plan).toEqual({
      dryRun: true,
      host: 'web1',
      command: "vops-restic restore 'latest' --target '/restore'",
      snapshot: 'latest',
      target: '/restore',
      targetState: 'empty',
    });
  });

  it('reports a target that already has content, which is what the user must approve', async () => {
    const { s } = svc(probeAnswers('not-empty'));
    const plan = await s.restore('web1', { snapshot: 'abc123', target: '/srv' });
    expect(plan).toMatchObject({ dryRun: true, snapshot: 'abc123', targetState: 'not-empty' });
  });

  it('says unknown rather than implying an empty target when the probe cannot answer', async () => {
    const failing = svc(() => ({ code: 255, stdout: '', stderr: 'Permission denied (publickey).' }));
    expect(await failing.s.restore('web1', { snapshot: 'latest', target: '/restore' })).toMatchObject({
      targetState: 'unknown',
    });

    const thrown = svc(() => {
      throw new Error('connection closed');
    });
    expect(await thrown.s.restore('web1', { snapshot: 'latest', target: '/restore' })).toMatchObject({
      targetState: 'unknown',
    });
    expect(restored(thrown.ran)).toEqual([]);
  });

  it('restores once approval is given', async () => {
    const { s, ran } = svc(probeAnswers('missing'));
    const res = await s.restore('web1', { snapshot: 'latest', target: '/restore', approved: true });

    expect(restored(ran)).toEqual([expect.stringContaining("restore 'latest' --target '/restore'")]);
    expect(res).toMatchObject({ dryRun: false, restored: true, target: '/restore' });
  });

  it('keeps --dry-run a preview even when approved', async () => {
    const { s, ran } = svc(probeAnswers('missing'));
    const plan = await s.restore('web1', { snapshot: 'latest', target: '/restore', dryRun: true, approved: true });

    expect(restored(ran)).toEqual([]);
    expect(plan).toMatchObject({ dryRun: true, command: "vops-restic restore 'latest' --target '/restore' --dry-run" });
  });
});

describe('the restore target probe', () => {
  it('separates a missing target from an empty and an occupied one', () => {
    const script = renderRestoreTargetProbe('/restore');
    expect(script).toContain("[ ! -e '/restore' ]");
    expect(script).toContain("ls -A '/restore'");

    expect(parseRestoreTargetState('missing\n')).toBe('missing');
    expect(parseRestoreTargetState('empty\n')).toBe('empty');
    expect(parseRestoreTargetState('not-empty\n')).toBe('not-empty');
  });

  it('falls back to unknown on any output it did not write itself', () => {
    expect(parseRestoreTargetState('')).toBe('unknown');
    expect(parseRestoreTargetState('sh: 1: ls: not found\n')).toBe('unknown');
    expect(parseRestoreTargetState('Warning: Permanently added the host\nempty\n')).toBe('empty');
  });
});
