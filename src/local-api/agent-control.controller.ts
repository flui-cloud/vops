import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AgentSessionManager } from '../agent-control/agent-session-manager';
import { ApprovalManager } from '../agent-control/approval-manager';
import { OperationManager } from '../agent-control/operation-manager';
import { CapabilityRegistry } from '../agent-control/capability-registry';
import { AgentStore } from '../agent-control/agent-store';
import { AgentSafetyState } from '../agent-control/agent-safety-state';
import { RemoteAgentRegistry } from '../remote/remote-agent-registry';
import { RemoteAgentPolicyStore } from '../remote/remote-agent-policy';
import { activityLines } from '../agent-control/activity-view';
import {
  AgentClientAdapters,
  ClientInstallScope,
  SupportedAgentClient,
} from '../agent-clients/client-adapters';

@Controller('api/agent')
export class AgentControlController {
  constructor(
    private readonly sessions: AgentSessionManager,
    private readonly approvals: ApprovalManager,
    private readonly operations: OperationManager,
    private readonly capabilities: CapabilityRegistry,
    private readonly store: AgentStore,
    private readonly safety: AgentSafetyState,
    private readonly agentProviders: RemoteAgentRegistry,
    private readonly providerPolicy: RemoteAgentPolicyStore,
  ) {}

  private readonly clients = new AgentClientAdapters();

  @Get('overview')
  async overview() {
    const [sessions, approvals, plans, operations, events, providers] = await Promise.all([
      this.sessions.list(),
      this.approvals.list(),
      this.store.listPlans(),
      this.operations.list(),
      this.store.listEventPage({ limit: 30 }),
      this.agentProviders.providers(),
    ]);
    const capabilities = this.capabilities.list({ includeUnavailable: true });
    return {
      mode: 'advisory',
      sessions,
      approvals,
      plans,
      operations,
      capabilities,
      events: events.events,
      eventsCursor: events.nextCursor,
      activity: activityLines({ operations, plans, sessions, capabilities }),
      clients: this.clientStatus(),
      emergencyStop: this.safety.current(),
      providers,
      providerPolicy: this.providerPolicy.read(),
    };
  }

  @Get('events')
  events(
    @Query('before') before?: string,
    @Query('session') session?: string,
    @Query('limit') limit?: string,
  ) {
    return this.store.listEventPage({
      ...(session ? { sessionId: session } : {}),
      ...(before ? { before: Number(before) } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

  /** Both scopes at once: the dashboard has to show whether this project is wired up
   * and whether the user-wide install already covers every repository. */
  @Get('clients')
  clientStatus() {
    return this.clients.clients().map((client) => ({
      client,
      project: this.clients.status(client, 'project'),
      user: this.clients.status(client, 'user'),
    }));
  }

  @Post('clients/:client/:action')
  clientAction(
    @Param('client') client: string,
    @Param('action') action: string,
    @Body() body: { scope?: string },
  ) {
    const target = this.assertClient(client);
    const scope: ClientInstallScope = body?.scope === 'user' ? 'user' : 'project';
    if (action === 'install') return this.clients.install(target, scope);
    if (action === 'uninstall') return this.clients.uninstall(target, scope);
    throw new Error(`Unsupported client action '${action}'.`);
  }

  private assertClient(client: string): SupportedAgentClient {
    const known = this.clients.clients().find((entry) => entry === client);
    if (!known) throw new Error(`Unsupported coding-agent client '${client}'.`);
    return known;
  }

  @Post('providers/fallback')
  providerFallback(@Body() body: {
    providers?: string[];
    deterministicFallback?: boolean;
  }) {
    const providers = Array.isArray(body?.providers)
      ? body.providers.map((entry) => this.providerPolicy.assertProvider(entry))
      : [];
    this.providerPolicy.setFallbackOrder(providers);
    if (typeof body?.deterministicFallback === 'boolean') {
      this.providerPolicy.setDeterministicFallback(body.deterministicFallback);
    }
    return this.providerPolicy.read();
  }

  @Post('providers/:id/:action')
  providerAction(@Param('id') id: string, @Param('action') action: string) {
    const provider = this.providerPolicy.assertProvider(id);
    if (action === 'default') return this.providerPolicy.setDefault(provider);
    if (action === 'enable') return this.providerPolicy.setEnabled(provider, true);
    if (action === 'disable') return this.providerPolicy.setEnabled(provider, false);
    throw new Error(`Unsupported provider action '${action}'.`);
  }

  /** The kill switch: persistent, and it also ends every live session. Kept distinct from
   * `sessions/revoke-all`, which clears the current agents without disarming new ones. */
  @Post('sessions/stop-all')
  async stopAll() {
    await this.safety.activate('local_user', 'Emergency stop from local vOps UI.');
    return {
      emergencyStop: this.safety.current(),
      sessions: await this.sessions.stopAll(),
    };
  }

  @Post('sessions/revoke-all')
  async revokeAll() {
    return {
      emergencyStop: this.safety.current(),
      sessions: await this.sessions.stopAll(),
    };
  }

  @Post('sessions/clear-emergency-stop')
  clearEmergencyStop(@Body() body: { reason?: string }) {
    return this.safety.clear('local_user', body?.reason ?? 'Cleared from local vOps UI.');
  }

  @Post('sessions/:id/narrow')
  narrowSession(
    @Param('id') id: string,
    @Body() body: {
      capabilities?: string[];
      targets?: string[];
      expiresAt?: string;
      maxProviderSpendEur?: number;
    },
  ) {
    return this.sessions.narrowScope(id, {
      ...(Array.isArray(body?.capabilities) ? { capabilities: body.capabilities.map(String) } : {}),
      ...(Array.isArray(body?.targets) ? { targets: body.targets.map(String) } : {}),
      ...(body?.expiresAt ? { expiresAt: String(body.expiresAt) } : {}),
      ...(typeof body?.maxProviderSpendEur === 'number'
        ? { maxProviderSpendEur: body.maxProviderSpendEur }
        : {}),
    });
  }

  @Post('sessions/:id/:action')
  sessionAction(@Param('id') id: string, @Param('action') action: string) {
    if (action === 'pause') return this.sessions.pause(id);
    if (action === 'resume') return this.sessions.resume(id);
    if (action === 'revoke') return this.sessions.revoke(id);
    throw new Error(`Unsupported session action '${action}'.`);
  }

  @Post('approvals/:id/:decision')
  approvalDecision(
    @Param('id') id: string,
    @Param('decision') decision: string,
    @Body() body: { reason?: string },
  ) {
    if (decision === 'approve') return this.approvals.approve(id, body?.reason);
    if (decision === 'deny') return this.approvals.deny(id, body?.reason);
    throw new Error(`Unsupported approval decision '${decision}'.`);
  }

  @Post('operations/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.operations.requestCancel(id);
  }
}
