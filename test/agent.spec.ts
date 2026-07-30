import { ExitCode } from '../src/agent-api/agent-envelope';
import { AgentBadRequest } from '../src/agent-api/agent-http-errors';
import { agentArchFor } from '../src/agent/agent-manifest';
import { agentRunFailure } from '../src/agent/agent-run-error';
import { agentFindings, VopsAgentService } from '../src/agent/vops-agent.service';
import type { ExecResult, SshExec } from '../src/lib/ssh-exec';

describe('agent manifest arch mapping', () => {
  it('maps uname -m to amd64/arm64, null otherwise', () => {
    expect(agentArchFor('x86_64')).toBe('amd64');
    expect(agentArchFor('aarch64')).toBe('arm64');
    expect(agentArchFor('armv7l')).toBeNull();
  });
});

describe('agentFindings', () => {
  it('maps a snapshot to agent.* findings with the right severities', () => {
    const findings = agentFindings({
      cpu: { usagePercent: 95, load1: 4, cores: 2 },
      mem: { usedPercent: 40 },
      disks: [
        { mount: '/', usedPercent: 60 },
        { mount: '/data', usedPercent: 97 },
      ],
    });
    const by = Object.fromEntries(findings.map((f) => [f.id, f]));
    expect(by['agent.cpu'].severity).toBe('warn'); // 95 > 90
    expect(by['agent.mem'].severity).toBe('ok'); // 40% used
    expect(by['agent.disk'].severity).toBe('fail'); // worst mount 97 > 95
    expect(by['agent.disk'].summary).toContain('/data');
  });

  it('omits sections the snapshot did not report', () => {
    expect(agentFindings({})).toHaveLength(0);
  });
});

/**
 * The agent is opt-in, so a host without it is the common case. "Not set up yet" reaching the
 * caller as a generic operational failure (exit 1) is indistinguishable from "it broke", and the
 * natural response to "it broke" is a retry of a command that cannot ever succeed.
 */
describe('a failed agent run', () => {
  const exec = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', ...over });

  const service = (res: ExecResult): VopsAgentService =>
    new VopsAgentService(
      { show: () => ({ name: 'web1', userKeyName: 'mine' }) } as never,
      { keyPathFor: () => '/keys/mine', list: () => [] } as never,
      { run: async () => res } as unknown as SshExec,
    );

  const thrownBy = async (res: ExecResult): Promise<unknown> =>
    service(res)
      .snapshot('web1')
      .then(
        () => null,
        (err: unknown) => err,
      );

  it('is a missing prerequisite naming the install command when the binary is absent', async () => {
    const err = await thrownBy(exec({ code: 127, stderr: 'bash: line 1: /usr/local/bin/vops-agent: No such file or directory' }));

    expect(err).toBeInstanceOf(AgentBadRequest);
    const bad = err as AgentBadRequest;
    expect(bad.exitCode).toBe(ExitCode.MISSING_PREREQUISITE);
    expect({ code: bad.agent.code, category: bad.agent.category, recoverable: bad.agent.recoverable }).toEqual({
      code: 'VOPS_AGENT_NOT_INSTALLED',
      category: 'prerequisite',
      recoverable: false,
    });
    expect(bad.agent.suggestedAction).toContain('vops host agent install web1');
  });

  it('classifies by the shell text too, for a wrapper that lost the 127', () => {
    const err = agentRunFailure('web1', exec({ code: 1, stderr: '/usr/local/bin/vops-agent: not found' }));
    expect((err as AgentBadRequest).agent.code).toBe('VOPS_AGENT_NOT_INSTALLED');
  });

  it('does not read ssh’s own "No such file or directory" as a missing agent', async () => {
    const err = await thrownBy(
      exec({ code: 255, stderr: 'Warning: Identity file /keys/mine not accessible: No such file or directory.\nPermission denied (publickey).' }),
    );

    expect(err).not.toBeInstanceOf(AgentBadRequest);
    expect((err as Error).message).toContain('Permission denied');
  });

  it('leaves a genuine agent failure operational, so it is not read as "never installed"', async () => {
    const err = await thrownBy(exec({ code: 2, stderr: 'panic: cannot read /proc/stat' }));

    expect(err).not.toBeInstanceOf(AgentBadRequest);
    expect((err as Error).message).toBe('Agent run failed: panic: cannot read /proc/stat');
  });

  it('reports the exit code when the agent failed silently', () => {
    expect(agentRunFailure('web1', exec({ code: 3 })).message).toBe('Agent run failed: exit 3');
  });

  it('returns the snapshot untouched when the agent runs', async () => {
    const snap = await service(exec({ stdout: JSON.stringify({ mem: { usedPercent: 41 } }) })).snapshot('web1');
    expect(snap).toEqual({ mem: { usedPercent: 41 } });
  });
});
