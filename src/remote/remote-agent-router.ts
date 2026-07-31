import { Injectable } from '@nestjs/common';
import { RemoteAgentRegistry } from './remote-agent-registry';
import {
  AgentProviderStatus,
  CodingAgentProviderId,
  RemoteAgentProviderId,
  RemoteAgentTurn,
  RemoteAgentTurnResult,
} from './remote-agent.types';
import { RemoteDevice } from './remote-model';
import { RemoteSyncService } from './remote-sync.service';

@Injectable()
export class RemoteAgentRouter {
  constructor(
    private readonly registry: RemoteAgentRegistry,
    private readonly sync: RemoteSyncService,
  ) {}

  selectedProvider(): CodingAgentProviderId {
    return this.registry.policy().defaultProvider;
  }

  async providers(): Promise<AgentProviderStatus[]> {
    return this.registry.providers();
  }

  async resolveProvider(requested?: CodingAgentProviderId): Promise<RemoteAgentProviderId> {
    return this.registry.resolve(requested);
  }

  async run(
    device: RemoteDevice,
    requestId: string,
    turn: RemoteAgentTurn,
    requested?: CodingAgentProviderId,
  ): Promise<RemoteAgentTurnResult | { provider: 'deterministic'; text: string }> {
    const statuses = await this.providers();
    const route = this.registry.candidates(requested, statuses);
    let lastError: unknown;
    for (const provider of route.providers) {
      if (turn.signal.aborted) throw cancelledError();
      if (provider !== route.primary) {
        await turn.onStatus('thinking', `Locally approved fallback: ${provider}`);
      }
      try {
        return await this.registry.run(provider, turn);
      } catch (error) {
        if (isCancelled(error, turn.signal)) throw cancelledError();
        lastError = error;
      }
    }
    if (!route.deterministicFallback) {
      throw lastError ?? new Error('No locally approved remote agent provider is available.');
    }
    return this.deterministic(device, requestId, turn);
  }

  private async deterministic(
    device: RemoteDevice,
    requestId: string,
    turn: RemoteAgentTurn,
  ): Promise<{ provider: 'deterministic'; text: string }> {
    const snapshot = await this.sync.snapshot(device, requestId);
    const text = [
      `Control node online. ${snapshot.targets.length} target, ${snapshot.applications.length} application.`,
      `${snapshot.operations.length} recent operation and ${snapshot.approvals.filter((entry) => entry.status === 'pending').length} pending approval.`,
      'No locally approved coding-agent runtime is ready, so this is a deterministic read-only summary.',
    ].join(' ');
    await turn.onDelta(text);
    return { provider: 'deterministic', text };
  }
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

function cancelledError(): Error {
  const error = new Error('Remote agent turn was cancelled.');
  error.name = 'AbortError';
  return error;
}
