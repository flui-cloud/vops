import { ForbiddenException } from '@nestjs/common';
import { Command, Flags } from '@oclif/core';
import { isCredentialError, isCredentialRejected } from '@flui-cloud/infra';
import {
  AgentEnvelope,
  AgentError,
  AgentFailure,
  EnvelopeOptions,
  ExitCode,
  ExitCodeValue,
  agentError,
  envelope,
  exitCodeFor,
} from './agent-envelope';
import { AgentBadRequest } from './agent-http-errors';
import { AgentControlError } from '../agent-control/agent-control-error';

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
    if (json) cmd.log(JSON.stringify(failureEnvelope(commandId, failure.error), null, 2));
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

/** A failure with no payload. `requiresApproval` tracks the category so the flag an agent branches
 * on never contradicts the error beside it — a refusal thrown from the body is still a refusal. */
function failureEnvelope(command: string, error: AgentError): AgentEnvelope<null> {
  return envelope(command, null, { errors: [error], requiresApproval: error.category === 'approval' });
}

/** Fail a command that does not (yet) speak the envelope, still honouring the structured exit
 * code and suggestion when the error carries one. Without this a typed failure — "no relay is
 * connected" (4) — reaches the shell as a generic 1, indistinguishable from "the relay is down".
 * Under `--json` the failure envelope is emitted too, so the machine-readable `code` is there
 * for a caller that reads stdout rather than `$?`. */
export function failCommand(cmd: Command, err: unknown, json = false): never {
  const failure = toFailure(err);
  // Same split `runAgentCommand` makes: under --json the envelope IS the output, so the human
  // rendering must not be appended to it.
  if (json) {
    cmd.log(JSON.stringify(failureEnvelope(commandIdOf(cmd), failure.error), null, 2));
    cmd.exit(failure.exitCode);
  }
  cmd.error(failure.error.message, {
    exit: failure.exitCode,
    suggestions: asSuggestions(failure.error.suggestedAction),
  });
}

/** For a command whose normal path is an interactive stream (`ssh`, `app shell`): `--json`
 * resolves the session and returns without connecting, so that branch can speak the envelope
 * while the connect path stays raw. `runAgentCommand` does not fit — its render callback would
 * have to spawn the child process and exit from inside the try. */
export function emitEnvelope<T>(cmd: Command, commandId: string, data: T): void {
  cmd.log(JSON.stringify(envelope(commandId, data), null, 2));
}

/** oclif ids are colon-separated (`watch:uptime:list`); the envelope carries the invocation. */
function commandIdOf(cmd: Command): string {
  return `vops ${(cmd.id ?? '').replaceAll(':', ' ')}`.trim();
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
  if (err instanceof AgentControlError) return controlPlaneFailure(err);
  const message = err instanceof Error ? err.message : stringify(err);
  if (isCredentialRejected(err)) {
    return new AgentFailure(
      agentError('VOPS_CREDENTIALS_INVALID', 'auth', message, {
        recoverable: false,
        suggestedAction:
          'Do not retry with the same credential — the provider refused it. Ask the user for a valid one, ' +
          'store it with `vops config set <provider>`, then run the command again. Never read this as an empty account.',
      }),
      ExitCode.AUTH,
    );
  }
  if (isCredentialError(err)) {
    return new AgentFailure(
      agentError('VOPS_CREDENTIALS_MISSING', 'auth', message, {
        recoverable: false,
        suggestedAction:
          'Do not retry. Ask the user to configure the credential named in the message, then run the command again.',
      }),
      ExitCode.AUTH,
    );
  }
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

function controlPlaneFailure(err: AgentControlError): AgentFailure {
  const category = {
    VOPS_AGENT_AUTH_REQUIRED: 'auth',
    VOPS_AGENT_TOKEN_INVALID: 'auth',
    VOPS_AGENT_SESSION_EXPIRED: 'auth',
    VOPS_AGENT_SESSION_INACTIVE: 'auth',
    VOPS_AGENT_SCOPE_DENIED: 'auth',
    VOPS_AGENT_APPROVAL_REQUIRED: 'approval',
    VOPS_AGENT_PLAN_INVALID: 'validation',
    VOPS_AGENT_PLAN_STALE: 'validation',
    VOPS_AGENT_NOT_FOUND: 'input',
    VOPS_AGENT_UNSUPPORTED: 'unsupported',
    VOPS_AGENT_OPERATION_FAILED: 'operational',
  } as const;
  return new AgentFailure(
    agentError(err.code, category[err.code], err.message, { recoverable: err.recoverable }),
    exitCodeFor(category[err.code]),
  );
}
