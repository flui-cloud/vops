export type CodingAgentProviderId =
  | 'codex'
  | 'claude-code'
  | 'opencode'
  | 'antigravity'
  | 'openai-compatible';

export type RemoteAgentProviderId = CodingAgentProviderId | 'deterministic';

export type AgentProviderState =
  | 'ready'
  | 'not_installed'
  | 'not_authenticated'
  | 'not_headless_capable'
  | 'busy'
  | 'failed'
  | 'disabled'
  | 'unavailable';

export interface AgentProviderStatus {
  id: RemoteAgentProviderId;
  displayName: string;
  kind: 'coding-agent' | 'openai-compatible' | 'deterministic';
  state: AgentProviderState;
  installed: boolean;
  authenticated: boolean | 'unknown';
  headless: boolean;
  enabled: boolean;
  selectable: boolean;
  isDefault: boolean;
  fallbackRank?: number;
  version?: string;
  detail?: string;
  capabilities: {
    streaming: boolean;
    semanticTools: boolean;
    planProposal: boolean;
    intentProposal: boolean;
    cancellation: boolean;
    existingAuthentication: boolean;
  };
}

export interface RemoteIntentAgentProposal {
  id: string;
  objective: string;
  trigger: {
    type: 'catalog.availability';
    provider: string;
    serverType: string;
    location?: string;
  };
  action: {
    capability: string;
    input: Record<string, unknown>;
    environment: 'development' | 'staging' | 'production';
    target?: string;
  };
  constraints: {
    expiresAt: string;
    maxExecutions: 1;
    maxSpendEur: number;
    failureBehavior: 'stop';
  };
}

export interface RemoteAgentTurn {
  requestId: string;
  sessionToken: string;
  prompt: string;
  context: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal: AbortSignal;
  onDelta(delta: string): void | Promise<void>;
  onStatus(status: 'thinking' | 'using_tool', detail?: string): void | Promise<void>;
  onApproval?(approvalId: string): void | Promise<void>;
  onIntentProposal?(proposal: RemoteIntentAgentProposal): void | Promise<void>;
}

export interface RemoteAgentTurnResult {
  provider: CodingAgentProviderId;
  text: string;
}

export interface RemoteAgentAdapter {
  readonly id: CodingAgentProviderId;
  status(): Promise<Omit<AgentProviderStatus, 'enabled' | 'selectable' | 'isDefault' | 'fallbackRank'>>;
  run(turn: RemoteAgentTurn): Promise<RemoteAgentTurnResult>;
}
