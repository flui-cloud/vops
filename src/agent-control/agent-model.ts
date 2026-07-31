import { CapabilityRisk } from './capability-registry';

export type AgentClient = 'claude-code' | 'codex' | 'opencode' | 'antigravity' | 'other';
export type AgentSessionMode = 'advisory' | 'protected';
export type AgentSessionStatus = 'active' | 'paused' | 'revoked' | 'expired' | 'completed';
export type AgentEnvironment = 'development' | 'staging' | 'production';

export interface AgentSessionPermissions {
  allow: string[];
  allowWithinApprovedPlan: string[];
  requireApproval: string[];
  deny: string[];
}

export interface AgentSession {
  id: string;
  actor: {
    type: 'coding_agent';
    client: AgentClient;
    clientVersion?: string;
    displayName: string;
  };
  objective: string;
  mode: AgentSessionMode;
  status: AgentSessionStatus;
  repository: { path: string; name: string };
  scope: {
    projects: string[];
    targets: string[];
    environments: AgentEnvironment[];
  };
  permissions: AgentSessionPermissions;
  limits: {
    expiresAt: string;
    maxOperations: number;
    /** Total monthly-equivalent provider cost this session may commit to, across every
     * resource it creates — not a per-resource price ceiling. */
    maxProviderSpendEur: number;
  };
  operationCount: number;
  /** Monthly-equivalent provider cost already committed by this session. */
  providerSpendEur: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentPlanStatus =
  | 'proposed'
  | 'awaiting_approval'
  | 'approved'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export interface AgentPlanStep {
  id: string;
  capability: string;
  input: Record<string, unknown>;
  risk: CapabilityRisk;
}

export interface AgentPlan {
  id: string;
  hash: string;
  sessionId: string;
  objective: string;
  status: AgentPlanStatus;
  environment: AgentEnvironment;
  target?: string;
  steps: AgentPlanStep[];
  successCriteria: string[];
  estimatedEffects: string[];
  excludedEffects: string[];
  rollback: {
    available: boolean;
    strategy?: string;
    limitations: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface AgentApproval {
  id: string;
  sessionId: string;
  planId?: string;
  capability?: string;
  status: ApprovalStatus;
  reason: string;
  risk: CapabilityRisk;
  target?: string;
  environment?: AgentEnvironment;
  expectedEffects: string[];
  reversible: boolean | 'conditional';
  requestedAt: string;
  decidedAt?: string;
  expiresAt: string;
  decisionReason?: string;
}

export type AgentOperationState =
  | 'proposed'
  | 'awaiting_approval'
  | 'approved'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'rollback_requested'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_failed';

export interface AgentOperation {
  id: string;
  sessionId: string;
  planId: string;
  capability?: string;
  state: AgentOperationState;
  currentStep?: string;
  result?: unknown;
  /** What the plan's own verification steps concluded. `succeeded` means every step ran,
   * which is not the same as the application being healthy afterwards. */
  verification?: {
    status: 'passed' | 'degraded' | 'failed' | 'not_verified';
    checks: Array<{ capability: string; step: string; status: string; failed: string[] }>;
  };
  error?: { code: string; message: string; recoverable: boolean };
  rollbackAvailable: boolean;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAuditEvent {
  eventId: string;
  sequence?: number;
  timestamp: string;
  sessionId?: string;
  actor: string;
  operationId?: string;
  eventType: string;
  capability?: string;
  target?: string;
  summary: string;
  redactionsApplied: boolean;
  previousHash?: string;
  hash: string;
  detail?: unknown;
}

export interface CreateAgentSessionInput {
  client: AgentClient;
  clientVersion?: string;
  displayName?: string;
  objective: string;
  repository: string;
  mode?: AgentSessionMode;
  targets?: string[];
  environments?: AgentEnvironment[];
  permissions?: Partial<AgentSessionPermissions>;
  expiresInMinutes?: number;
  maxOperations?: number;
  maxProviderSpendEur?: number;
}

export interface CreatedAgentSession {
  session: AgentSession;
  token: string;
}
