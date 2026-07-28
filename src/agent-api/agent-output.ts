import { ForbiddenException } from '@nestjs/common';
import { Command, Flags } from '@oclif/core';
import {
  AgentEnvelope,
  AgentFailure,
  EnvelopeOptions,
  ExitCode,
  ExitCodeValue,
  agentError,
  envelope,
  exitCodeFor,
} from './agent-envelope';
import { AgentBadRequest } from './agent-http-errors';

/** `--json` on every agent-facing command. Human output stays the default. */
export const agentJsonFlag = {
  json: Flags.boolean({ default: false, description: 'Emit the machine-readable envelope (no colour, no prompts)' }),
};

interface Outcome {
  code: ExitCodeValue;
  message?: string;
  suggestions?: string[];
}

/** Runs the command body and emits exactly one of the JSON envelope or human rendering, exiting
 * with the specific code the agent branches on. Exit happens outside the try — `cmd.exit()` throws,
 * and catching it would print a second envelope and overwrite the code with a generic 1. */
export async function runAgentCommand<T>(
  cmd: Command,
  commandId: string,
  json: boolean,
  body: () => Promise<{ data: T } & EnvelopeOptions>,
  render: (data: T, env: AgentEnvelope<T>) => void,
): Promise<void> {
  const outcome = await produce(cmd, commandId, json, body, render);
  if (outcome.code === ExitCode.SUCCESS) return;
  if (json) cmd.exit(outcome.code);
  cmd.error(outcome.message ?? 'failed', { exit: outcome.code, suggestions: outcome.suggestions });
}

async function produce<T>(
  cmd: Command,
  commandId: string,
  json: boolean,
  body: () => Promise<{ data: T } & EnvelopeOptions>,
  render: (data: T, env: AgentEnvelope<T>) => void,
): Promise<Outcome> {
  try {
    const result = await body();
    const env = envelope(commandId, result.data, result);
    if (json) cmd.log(JSON.stringify(env, null, 2));
    else render(result.data, env);

    const first = env.errors[0];
    if (!first) return { code: ExitCode.SUCCESS };
    return { code: exitCodeFor(first.category), message: first.message, suggestions: asSuggestions(first.suggestedAction) };
  } catch (err) {
    const failure = toFailure(err);
    if (json) cmd.log(JSON.stringify(envelope(commandId, null, { errors: [failure.error] }), null, 2));
    return {
      code: failure.exitCode,
      message: failure.error.message,
      suggestions: asSuggestions(failure.error.suggestedAction),
    };
  }
}

function asSuggestions(action?: string): string[] | undefined {
  return action ? [action] : undefined;
}

/** A non-Error throw, without the '[object Object]' that String() would produce. */
function stringify(err: unknown): string {
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/** Any thrown value → the structured failure (unknown throws stay operational/1). Only
 * `ForbiddenException` is translated, since it has one source (the ownership guard); `BadRequestException`
 * is deliberately left generic since services raise it for several unrelated conditions. */
export function toFailure(err: unknown): AgentFailure {
  if (err instanceof AgentFailure) return err;
  if (err instanceof AgentBadRequest) return new AgentFailure(err.agent, err.exitCode);
  const message = err instanceof Error ? err.message : stringify(err);
  if (err instanceof ForbiddenException) {
    return new AgentFailure(
      agentError('VOPS_NOT_VOPS_MANAGED', 'input', message, {
        recoverable: false,
        suggestedAction: 'Do not retry. Tell the user vops only modifies resources it created, and let them act.',
      }),
      ExitCode.INVALID_INPUT,
    );
  }
  return new AgentFailure(agentError('VOPS_OPERATION_FAILED', 'operational', message), ExitCode.FAILURE);
}
