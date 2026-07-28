import { BadRequestException } from '@nestjs/common';
import { AgentError, ExitCode, ExitCodeValue, agentError } from './agent-envelope';

/** A refusal usable by both callers of the same services: the local API needs a NestJS
 * exception (mapped to HTTP 400), an agent needs a structured code + exit status. A plain
 * `BadRequestException` would give only the first, collapsing every failure to
 * `VOPS_OPERATION_FAILED`/1. Use only where the category is unambiguous (e.g. unknown id = `input`). */
export class AgentBadRequest extends BadRequestException {
  constructor(
    readonly agent: AgentError,
    readonly exitCode: ExitCodeValue = ExitCode.INVALID_INPUT,
  ) {
    super(agent.message);
  }
}

/** The common case: a name or id that does not resolve to anything. */
export function notFound(code: string, message: string, suggestedAction: string): AgentBadRequest {
  return new AgentBadRequest(agentError(code, 'input', message, { suggestedAction }), ExitCode.INVALID_INPUT);
}
