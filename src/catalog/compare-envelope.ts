import { AgentError, AgentWarning } from '../agent-api/agent-envelope';
import { toFailure } from '../agent-api/agent-output';
import { VopsCompareReport } from '../dto/plan.dto';

/**
 * A provider left out of the fan-out, per unreachable state. Two codes rather than one
 * message an agent has to read: "configure a credential" and "unlock the vault you already
 * filled" are different remedies, and only one of them needs the user to find a token.
 */
export function compareWarnings(report: VopsCompareReport): AgentWarning[] {
  return report.skipped.map((s) => ({
    code: s.cause === 'sealed' ? 'VOPS_PROVIDER_VAULT_SEALED' : 'VOPS_PROVIDER_SKIPPED',
    message: `${s.provider} is not in this comparison: ${s.reason}.`,
  }));
}

/**
 * A provider that was asked and failed is an error, not a warning. The rows of the
 * providers that answered are real and are kept — one refusal must not cost the user the
 * four comparisons that worked — but the failure keeps the code, category and exit it
 * would have had as the only provider, so nothing that branches on the envelope sees a
 * refused or unreachable provider as a complete market.
 */
export function compareErrors(report: VopsCompareReport): AgentError[] {
  return report.failed.map((f) => {
    const { error } = toFailure(f.error);
    return { ...error, message: `${f.provider} could not be priced: ${error.message}` };
  });
}
