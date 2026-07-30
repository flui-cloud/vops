import { BadRequestException } from '@nestjs/common';
import { ExitCode, agentError } from '../agent-api/agent-envelope';
import { AgentBadRequest } from '../agent-api/agent-http-errors';
import { ExecResult } from '../lib/ssh-exec';

// 127 is the shell's "command not found". The text form covers a wrapper that lost the code, and
// insists the message names the binary: ssh says "No such file or directory" about an unreadable
// identity file too, and that is a different failure entirely.
const MISSING = /(no such file or directory|not found)/i;
const AGENT_BINARY = /vops-agent/;

/**
 * The agent is opt-in, so "nobody installed it" is the ordinary state of a host — and it needs a
 * different answer from "the agent ran and broke". As a generic operational failure the first one
 * reads as transient and invites a retry of the same command; as a missing prerequisite it names
 * the one command that fixes it. Every other outcome (a crash, a timeout) stays operational.
 */
export function agentRunFailure(host: string, res: ExecResult): BadRequestException {
  const stderr = res.stderr.trim();
  if (res.code === 127 || (MISSING.test(stderr) && AGENT_BINARY.test(stderr))) {
    return new AgentBadRequest(
      agentError('VOPS_AGENT_NOT_INSTALLED', 'prerequisite', `The vops metrics agent is not installed on '${host}'.`, {
        suggestedAction: `Ask the user before installing software on their host, then run \`vops host agent install ${host}\`.`,
      }),
      ExitCode.MISSING_PREREQUISITE,
    );
  }
  const reason = stderr || `exit ${res.code}`;
  return new BadRequestException(`Agent run failed: ${reason}`);
}
