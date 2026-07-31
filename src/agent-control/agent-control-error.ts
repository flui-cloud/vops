export type AgentControlErrorCode =
  | 'VOPS_AGENT_AUTH_REQUIRED'
  | 'VOPS_AGENT_TOKEN_INVALID'
  | 'VOPS_AGENT_SESSION_EXPIRED'
  | 'VOPS_AGENT_SESSION_INACTIVE'
  | 'VOPS_AGENT_SCOPE_DENIED'
  | 'VOPS_AGENT_APPROVAL_REQUIRED'
  | 'VOPS_AGENT_PLAN_INVALID'
  | 'VOPS_AGENT_PLAN_STALE'
  | 'VOPS_AGENT_NOT_FOUND'
  | 'VOPS_AGENT_UNSUPPORTED'
  | 'VOPS_AGENT_OPERATION_FAILED';

export class AgentControlError extends Error {
  constructor(
    readonly code: AgentControlErrorCode,
    message: string,
    readonly status: 'denied' | 'approval_required' | 'failed' = 'failed',
    readonly recoverable = false,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AgentControlError';
  }
}
