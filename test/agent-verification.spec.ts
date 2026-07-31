import { summariseVerification } from '../src/agent-control/verification';
import { okEnvelope } from '../src/agent-control/mcp-envelope';
import { AgentOperation } from '../src/agent-control/agent-model';

const restart = { step: 'step_1', capability: 'application.restart', output: { status: 'deployed' } };

function healthcheck(status: string, checks: Array<{ name: string; status: string }>) {
  return { step: 'step_2', capability: 'healthcheck.run', output: { status, checks } };
}

function operation(results: Parameters<typeof summariseVerification>[0]): AgentOperation {
  return {
    id: 'op_1',
    sessionId: 'ses_1',
    planId: 'plan_1',
    state: 'succeeded',
    rollbackAvailable: true,
    cancelRequested: false,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    verification: summariseVerification(results),
  };
}

describe('operation verification verdict', () => {
  it('reports a passing verification when every check passes', () => {
    const summary = summariseVerification([
      restart,
      healthcheck('healthy', [{ name: 'units', status: 'pass' }, { name: 'public-url', status: 'pass' }]),
    ]);
    expect(summary.status).toBe('passed');
    expect(summary.checks).toHaveLength(1);
  });

  it('does not report a bare success when a check inside the plan failed', () => {
    const summary = summariseVerification([
      restart,
      healthcheck('degraded', [{ name: 'units', status: 'pass' }, { name: 'public-url', status: 'fail' }]),
    ]);
    expect(summary.status).toBe('degraded');
    expect(summary.checks[0].failed).toEqual(['public-url']);
  });

  it('marks a plan with no verification step as unverified rather than verified', () => {
    expect(summariseVerification([restart]).status).toBe('not_verified');
  });

  it('tells the agent to diagnose instead of claiming a succeeded operation is healthy', () => {
    const degraded = okEnvelope('Plan execution completed.', {}, {
      operation: operation([restart, healthcheck('degraded', [{ name: 'public-url', status: 'fail' }])]),
    });
    expect(degraded.operation).toMatchObject({ state: 'succeeded', verification: 'degraded' });
    expect(degraded.next_actions.join(' ')).toContain('public-url');

    const healthy = okEnvelope('Plan execution completed.', {}, {
      operation: operation([restart, healthcheck('healthy', [{ name: 'public-url', status: 'pass' }])]),
    });
    expect(healthy.operation.verification).toBe('passed');
    expect(healthy.next_actions).toEqual([]);
  });
});
