import { AgentFailure, ExitCode, agentError } from '../agent-api/agent-envelope';

/** Approval guard: nothing persistent happens because a caller forgot to ask "has a human said
 * yes to *this* operation". Lives in the service layer, not per-command, so forgetting it is not
 * possible — the CLI flag and the local API both arrive here. Only class C (persistent) reaches this. */

export type ApprovalClass = 'A' | 'B' | 'C';

export interface ApprovalRequest {
  /** The action in the user's words: 'deploy', 'remove app', 'delete server'. */
  operation: string;
  /** What it lands on. Named in the refusal so the blast radius is never implicit. */
  target: string;
  /** Whether a human has actually agreed — `--yes`, or an explicit UI confirmation. */
  approved: boolean;
  /** What the user must understand before agreeing, when it is not obvious. */
  consequence?: string;
  /** Overrides the default instruction to the agent. */
  suggestedAction?: string;
}

export function assertApproved(req: ApprovalRequest): void {
  if (req.approved) return;
  throw approvalRequired(req);
}

export function approvalRequired(req: ApprovalRequest): AgentFailure {
  const consequence = req.consequence ? ` ${req.consequence}` : '';
  return new AgentFailure(
    agentError(
      'VOPS_APPROVAL_REQUIRED',
      'approval',
      `${req.operation} on '${req.target}' has not been approved.${consequence}`,
      {
        // Not recoverable by the agent: no amount of retrying produces consent.
        recoverable: false,
        suggestedAction:
          req.suggestedAction ?? 'Show the user what this changes, then re-run with --yes once they agree.',
      },
    ),
    ExitCode.APPROVAL_REQUIRED,
  );
}
