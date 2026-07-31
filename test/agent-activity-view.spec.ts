import { activityLines } from '../src/agent-control/activity-view';
import { CapabilityRegistry } from '../src/agent-control/capability-registry';
import { AgentOperation, AgentPlan, AgentSession } from '../src/agent-control/agent-model';

const capabilities = new CapabilityRegistry().list({ includeUnavailable: true });

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'ses_1',
    actor: { type: 'coding_agent', client: 'claude-code', displayName: 'Claude Code' },
    objective: 'Operate staging',
    mode: 'advisory',
    status: 'active',
    repository: { path: '/repo', name: 'repo' },
    scope: { projects: ['repo'], targets: ['vmi3399032'], environments: ['staging'] },
    permissions: { allow: [], allowWithinApprovedPlan: [], requireApproval: [], deny: [] },
    limits: { expiresAt: '2026-07-30T18:00:00.000Z', maxOperations: 50, maxProviderSpendEur: 0 },
    operationCount: 1,
    createdAt: '2026-07-30T16:00:00.000Z',
    updatedAt: '2026-07-30T16:00:00.000Z',
    ...overrides,
  } as AgentSession;
}

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: 'plan_1',
    hash: 'a'.repeat(64),
    sessionId: 'ses_1',
    objective: 'Restart home-assistant and verify it',
    environment: 'staging',
    target: 'vmi3399032',
    steps: [
      { id: 'step_1', capability: 'application.restart', input: { name: 'home-assistant', host: 'vmi3399032' }, risk: 'medium' },
      { id: 'step_2', capability: 'healthcheck.run', input: { name: 'home-assistant', host: 'vmi3399032' }, risk: 'read_only' },
    ],
    successCriteria: [],
    estimatedEffects: [],
    excludedEffects: [],
    rollback: { available: true, limitations: [] },
    status: 'succeeded',
    createdAt: '2026-07-30T16:00:00.000Z',
    updatedAt: '2026-07-30T16:00:12.000Z',
    ...overrides,
  } as AgentPlan;
}

function operation(overrides: Partial<AgentOperation> = {}): AgentOperation {
  return {
    id: 'op_1',
    sessionId: 'ses_1',
    planId: 'plan_1',
    state: 'succeeded',
    rollbackAvailable: true,
    cancelRequested: false,
    createdAt: '2026-07-30T16:00:00.000Z',
    updatedAt: '2026-07-30T16:00:12.000Z',
    ...overrides,
  };
}

describe('agent activity view', () => {
  it('reads back as a sentence naming the agent, the objective and the target', () => {
    const [row] = activityLines({
      operations: [operation()],
      plans: [plan()],
      sessions: [session()],
      capabilities,
    });
    expect(row.actor).toBe('Claude Code');
    expect(row.headline).toBe('Restart home-assistant and verify it');
    expect(row.target).toBe('vmi3399032');
    expect(row.durationMs).toBe(12_000);
    expect(row.steps.map((step) => step.action)).toEqual(['Restart an application', 'Run a healthcheck']);
    expect(row.steps[0].detail).toBe('vmi3399032');
  });

  it('surfaces a degraded verification next to a succeeded outcome', () => {
    const [row] = activityLines({
      operations: [operation({
        verification: {
          status: 'degraded',
          checks: [{ capability: 'healthcheck.run', step: 'step_2', status: 'degraded', failed: ['public-url'] }],
        },
      })],
      plans: [plan()],
      sessions: [session()],
      capabilities,
    });
    expect(row.outcome).toBe('succeeded');
    expect(row.verification).toBe('degraded');
    expect(row.failedChecks).toEqual(['public-url']);
  });

  it('falls back to the capability label when the plan is gone, and carries the error', () => {
    const [row] = activityLines({
      operations: [operation({
        state: 'failed',
        error: { code: 'VOPS_AGENT_SCOPE_DENIED', message: 'Target is outside the session scope.', recoverable: true },
      })],
      plans: [],
      sessions: [session()],
      capabilities,
    });
    expect(row.outcome).toBe('failed');
    expect(row.headline).toBe('Ran a plan that is no longer stored.');
    expect(row.error).toContain('outside the session scope');
  });

  it('orders newest first', () => {
    const rows = activityLines({
      operations: [
        operation({ id: 'op_old', updatedAt: '2026-07-30T15:00:00.000Z' }),
        operation({ id: 'op_new', updatedAt: '2026-07-30T17:00:00.000Z' }),
      ],
      plans: [plan()],
      sessions: [session()],
      capabilities,
    });
    expect(rows.map((row) => row.operationId)).toEqual(['op_new', 'op_old']);
  });

  it('gives every registered capability a human action label', () => {
    for (const capability of capabilities) {
      expect(typeof capability.action).toBe('string');
      expect(capability.action.length).toBeGreaterThan(3);
    }
  });
});
