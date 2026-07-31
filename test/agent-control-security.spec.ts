import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityRegistry } from '../src/agent-control/capability-registry';
import { containsSecretLikeField, redactSecrets } from '../src/agent-control/redaction';
import { AgentStore } from '../src/agent-control/agent-store';
import { AgentSessionManager } from '../src/agent-control/agent-session-manager';
import { PolicyEngine } from '../src/agent-control/policy-engine';
import { PlanEngine } from '../src/agent-control/plan-engine';
import { ApprovalManager } from '../src/agent-control/approval-manager';
import { ActionBroker } from '../src/agent-control/action-broker';
import { OperationManager } from '../src/agent-control/operation-manager';
import { CoreActionExecutor } from '../src/agent-control/core-action-executor';
import { AgentControlError } from '../src/agent-control/agent-control-error';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { toFailure } from '../src/agent-api/agent-output';

describe('agent control security boundaries', () => {
  let profile: string;
  let previous: string | undefined;
  let store: AgentStore;
  let sessions: AgentSessionManager;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-agent-control-'));
    previous = process.env.VOPS_CONFIG_DIR;
    process.env.VOPS_CONFIG_DIR = profile;
    store = new AgentStore();
    sessions = new AgentSessionManager(store);
    registry = new CapabilityRegistry();
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    if (previous === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = previous;
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it('publishes semantic capabilities and no arbitrary execution primitive', () => {
    const ids = registry.list({ includeUnavailable: true }).map((entry) => entry.id);
    expect(ids).toContain('application.deploy');
    expect(ids).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/shell|ssh\.exec|raw|command/i),
    ]));
    expect(registry.validate('target.list', { unexpected: true }).valid).toBe(false);
  });

  it.each([
    ['VOPS_AGENT_TOKEN_INVALID', 'auth', ExitCode.AUTH],
    ['VOPS_AGENT_APPROVAL_REQUIRED', 'approval', ExitCode.APPROVAL_REQUIRED],
    ['VOPS_AGENT_PLAN_STALE', 'validation', ExitCode.VALIDATION],
  ] as const)('preserves %s in the shared CLI envelope', (code, category, exitCode) => {
    const failure = toFailure(new AgentControlError(code, 'control-plane refusal'));
    expect(failure).toMatchObject({ error: { code, category }, exitCode });
  });

  it('redacts nested values, bearer tokens, private keys and credentialed URLs', () => {
    const result = redactSecrets({
      apiToken: 'top-secret',
      nested: ['Bearer abcdefghijklmnop', 'https://me:pass@example.com'],
      material: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    });
    expect(result.applied).toBe(true);
    expect(JSON.stringify(result.value)).not.toMatch(/top-secret|abcdefghijklmnop|:pass@|BEGIN PRIVATE/);
    expect(containsSecretLikeField({ deploy: { password: 'x' } })).toBe(true);
  });

  it('stores only the token hash and rejects paused or revoked sessions', async () => {
    const created = await sessions.create({
      client: 'codex',
      objective: 'Inspect safely',
      repository: process.cwd(),
    });
    expect(JSON.stringify(await sessions.show(created.session.id))).not.toContain(created.token);
    expect((await sessions.list()).map((session) => session.id)).toEqual([created.session.id]);
    expect((await sessions.authenticate(created.token)).id).toBe(created.session.id);
    expect(await store.verifyEventChain()).toMatchObject({ valid: true, events: 1 });
    await sessions.pause(created.session.id);
    await expect(sessions.authenticate(created.token)).rejects.toMatchObject({ code: 'VOPS_AGENT_SESSION_INACTIVE' });
    await sessions.resume(created.session.id);
    await sessions.revoke(created.session.id);
    await expect(sessions.authenticate(created.token)).rejects.toMatchObject({ code: 'VOPS_AGENT_SESSION_INACTIVE' });
  });

  it('does not claim protected enforcement before an isolation launcher exists', async () => {
    await expect(sessions.create({
      client: 'codex',
      objective: 'Protected deploy',
      repository: process.cwd(),
      mode: 'protected',
    })).rejects.toMatchObject({ code: 'VOPS_AGENT_UNSUPPORTED' });
  });

  it('requires approval for deploy and binds it to an immutable secret-free plan', async () => {
    const created = await sessions.create({
      client: 'claude-code',
      objective: 'Deploy',
      repository: process.cwd(),
      targets: ['demo'],
      environments: ['staging'],
    });
    const policy = new PolicyEngine(registry);
    const plans = new PlanEngine(store, registry, policy);
    const approvals = new ApprovalManager(store, sessions);
    const plan = await plans.create(created.session, {
      objective: 'Deploy demo',
      target: 'demo',
      steps: [{
        capability: 'application.deploy',
        input: { projectDir: process.cwd(), planId: 'abcdef123456' },
      }],
    });
    expect(plan.status).toBe('awaiting_approval');
    const approval = await approvals.requestForPlan(plan, 'Approve deploy');
    expect((await approvals.approve(approval.id)).status).toBe('approved');
    expect((await plans.validate(plan)).valid).toBe(true);
    await expect(plans.create(created.session, {
      objective: 'Leak',
      steps: [{ capability: 'target.list', input: { token: 'nope' } }],
    })).rejects.toMatchObject({ code: 'VOPS_AGENT_PLAN_INVALID' });
  });

  it('applies an explicitly approved scope expansion to the same session only', async () => {
    const created = await sessions.create({
      client: 'opencode',
      objective: 'Inspect then harden',
      repository: process.cwd(),
      targets: ['demo'],
    });
    const approvals = new ApprovalManager(store, sessions);
    const request = await approvals.requestScopeExpansion({
      sessionId: created.session.id,
      capability: 'server.harden',
      reason: 'Harden demo',
      risk: 'high',
      target: 'demo',
      environment: 'staging',
    });
    await approvals.approve(request.id);
    const updated = await sessions.show(created.session.id);
    expect(updated.permissions.allow).toContain('server.harden');
    expect(updated.permissions.requireApproval).not.toContain('server.harden');
  });

  it('refuses an application-named capability that does not name an in-scope host', async () => {
    const created = await sessions.create({
      client: 'claude-code',
      objective: 'Operate the staging box',
      repository: process.cwd(),
      targets: ['in-scope'],
      environments: ['staging'],
    });
    const policy = new PolicyEngine(registry);
    const plans = new PlanEngine(store, registry, policy);
    for (const capability of ['application.status', 'application.restart', 'logs.read_recent', 'healthcheck.run']) {
      await expect(plans.create(created.session, {
        objective: `Run ${capability} without a host`,
        environment: 'staging',
        steps: [{ capability, input: { name: 'some-app' } }],
      })).rejects.toMatchObject({ code: 'VOPS_AGENT_PLAN_INVALID' });
      await expect(plans.create(created.session, {
        objective: `Run ${capability} on another host`,
        environment: 'staging',
        steps: [{ capability, input: { name: 'some-app', host: 'out-of-scope' } }],
      })).rejects.toMatchObject({ code: 'VOPS_AGENT_PLAN_INVALID' });
    }
    const allowed = await plans.create(created.session, {
      objective: 'Read status on the scoped host',
      environment: 'staging',
      steps: [{ capability: 'application.status', input: { name: 'some-app', host: 'in-scope' } }],
    });
    expect(allowed.steps[0].input).toMatchObject({ host: 'in-scope' });
  });

  it('lets an approval-required capability run inside the plan the user approved', async () => {
    const created = await sessions.create({
      client: 'codex',
      objective: 'Provision one hourly server',
      repository: process.cwd(),
      environments: ['staging'],
      maxProviderSpendEur: 6,
    });
    const policy = new PolicyEngine(registry);
    const plans = new PlanEngine(store, registry, policy);
    const approvals = new ApprovalManager(store, sessions);
    expect(created.session.permissions.requireApproval).toContain('server.provision');
    const plan = await plans.create(created.session, {
      objective: 'Provision one hourly server',
      environment: 'staging',
      steps: [{ capability: 'server.provision', input: { provider: 'hetzner', planFile: 'vops-plan.json' } }],
    });
    expect(plan.status).toBe('awaiting_approval');
    const approval = await approvals.requestForPlan(plan, 'Approve provisioning');
    await approvals.approve(approval.id);
    expect(policy.evaluate({
      session: created.session,
      capability: 'server.provision',
      input: plan.steps[0].input,
      environment: 'staging',
      approvedPlan: { ...plan, status: 'approved' },
    }).effect).toBe('allow');
    expect(policy.evaluate({
      session: created.session,
      capability: 'server.provision',
      input: plan.steps[0].input,
      environment: 'staging',
    }).effect).toBe('approval_required');
  });

  it('narrows a live session so a revoked capability cannot come back through an approval', async () => {
    const created = await sessions.create({
      client: 'claude-code',
      objective: 'Deploy then stop',
      repository: process.cwd(),
      targets: ['a', 'b'],
      environments: ['staging'],
      maxProviderSpendEur: 20,
    });
    expect(created.session.permissions.allowWithinApprovedPlan).toContain('application.restart');

    const narrowed = await sessions.narrowScope(created.session.id, {
      capabilities: ['application.restart'],
      targets: ['a'],
      maxProviderSpendEur: 0,
    });
    expect(narrowed.permissions.allowWithinApprovedPlan).not.toContain('application.restart');
    expect(narrowed.permissions.deny).toContain('application.restart');
    expect(narrowed.scope.targets).toEqual(['a']);
    expect(narrowed.limits.maxProviderSpendEur).toBe(0);

    const policy = new PolicyEngine(registry);
    const plans = new PlanEngine(store, registry, policy);
    await expect(plans.create(narrowed, {
      objective: 'Restart anyway',
      environment: 'staging',
      steps: [{ capability: 'application.restart', input: { name: 'app', host: 'a' } }],
    })).rejects.toMatchObject({ code: 'VOPS_AGENT_PLAN_INVALID' });
    await expect(plans.create(narrowed, {
      objective: 'Work on the dropped target',
      environment: 'staging',
      steps: [{ capability: 'target.inspect', input: { target: 'b' } }],
    })).rejects.toMatchObject({ code: 'VOPS_AGENT_PLAN_INVALID' });
  });

  it('spends the provider budget once, so cheap resources cannot be bought forever', async () => {
    const created = await sessions.create({
      client: 'codex',
      objective: 'Provision within a budget',
      repository: process.cwd(),
      environments: ['staging'],
      maxProviderSpendEur: 12,
    });
    expect(created.session.providerSpendEur).toBe(0);

    const first = await sessions.commitProviderSpend(created.session.id, 5.49);
    expect(first.providerSpendEur).toBeCloseTo(5.49);
    const second = await sessions.commitProviderSpend(created.session.id, 5.49);
    expect(second.providerSpendEur).toBeCloseTo(10.98);

    await expect(sessions.commitProviderSpend(created.session.id, 5.49))
      .rejects.toMatchObject({ code: 'VOPS_AGENT_SCOPE_DENIED' });
    expect((await sessions.show(created.session.id)).providerSpendEur).toBeCloseTo(10.98);

    const events = await store.listEvents(created.session.id);
    expect(events.filter((event) => event.eventType === 'session.spend_committed')).toHaveLength(2);
  });

  it('pages the audit log with a stable cursor', async () => {
    const created = await sessions.create({
      client: 'codex',
      objective: 'Generate audit noise',
      repository: process.cwd(),
      environments: ['staging'],
    });
    for (let i = 0; i < 12; i += 1) await sessions.pause(created.session.id).then(() => sessions.resume(created.session.id));

    const first = await store.listEventPage({ limit: 5 });
    expect(first.events).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.listEventPage({ limit: 5, before: first.nextCursor! });
    expect(second.events).toHaveLength(5);
    const ids = new Set([...first.events, ...second.events].map((event) => event.eventId));
    expect(ids.size).toBe(10);
    expect(Math.max(...second.events.map((event) => event.sequence ?? 0)))
      .toBeLessThan(Math.min(...first.events.map((event) => event.sequence ?? 0)));

    const scoped = await store.listEventPage({ sessionId: created.session.id, limit: 100 });
    expect(scoped.events.every((event) => event.sessionId === created.session.id)).toBe(true);
    expect(scoped.nextCursor).toBeNull();
  });

  it('never dispatches a denied request to provider or SSH execution', async () => {
    const created = await sessions.create({
      client: 'antigravity',
      objective: 'Read only',
      repository: process.cwd(),
      targets: ['allowed'],
    });
    const execute = jest.fn();
    const policy = new PolicyEngine(registry);
    const broker = new ActionBroker(
      sessions,
      registry,
      new PlanEngine(store, registry, policy),
      policy,
      new ApprovalManager(store, sessions),
      { execute } as unknown as CoreActionExecutor,
      new OperationManager(store),
      store,
    );
    await expect(broker.invoke(created.token, 'server.destroy', {
      provider: 'hetzner',
      id: 'server-1',
    })).rejects.toMatchObject({ code: 'VOPS_AGENT_PLAN_INVALID' });
    await expect(broker.invoke(created.token, 'target.inspect', {
      target: 'outside',
    })).rejects.toMatchObject({ code: 'VOPS_AGENT_PLAN_INVALID' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes one unchanged deployment plan after one local approval', async () => {
    const created = await sessions.create({
      client: 'codex',
      objective: 'Deploy the repository',
      repository: process.cwd(),
      targets: ['staging-01'],
    });
    const execute = jest.fn().mockResolvedValue({ deployed: true, verified: true });
    const policy = new PolicyEngine(registry);
    const approvals = new ApprovalManager(store, sessions);
    const broker = new ActionBroker(
      sessions,
      registry,
      new PlanEngine(store, registry, policy),
      policy,
      approvals,
      { execute } as unknown as CoreActionExecutor,
      new OperationManager(store),
      store,
    );
    const proposal = await broker.invoke(created.token, 'application.deploy', {
      projectDir: process.cwd(),
      planId: 'abcdef123456',
    }, { target: 'staging-01', objective: 'Deploy approved revision' });
    expect(proposal.approval?.status).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
    await approvals.approve(proposal.approval.id);
    const operation = await broker.executePlan(created.token, proposal.plan.id);
    expect(operation.state).toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(operation.result).toEqual([
      {
        step: 'step_1',
        capability: 'application.deploy',
        output: { deployed: true, verified: true },
      },
    ]);
    expect(await store.verifyEventChain()).toMatchObject({ valid: true });
  });
});
