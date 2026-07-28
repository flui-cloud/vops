/** The machine-readable contract every agent-facing command speaks: one envelope, one error
 * record, one set of exit codes, stable across releases since agents parse stdout, not prose. */

export const AGENT_SCHEMA_VERSION = '1' as const;

/** Process exit codes an agent branches on before parsing anything — `1` is never used for a
 * condition a more specific code describes. */
export const ExitCode = {
  SUCCESS: 0,
  /** The operation ran and failed (SSH error, build failure, unreachable host). */
  FAILURE: 1,
  /** The command was called wrong (bad flag, unknown id, missing argument). */
  INVALID_INPUT: 2,
  /** A manifest, plan or spec did not validate. */
  VALIDATION: 3,
  /** Something the command depends on is absent (no podman, no catalog, no token). */
  MISSING_PREREQUISITE: 4,
  /** A persistent change was requested without approval. */
  APPROVAL_REQUIRED: 5,
  /** This build of vops does not implement the capability. */
  UNSUPPORTED: 6,
  /** Credentials are missing, wrong, or lack the required scope. */
  AUTH: 7,
  /** Some stages succeeded and some did not — the result needs reading. */
  PARTIAL: 8,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCategory =
  | 'validation'
  | 'input'
  | 'prerequisite'
  | 'approval'
  | 'auth'
  | 'unsupported'
  | 'operational';

/** One actionable failure. `recoverable` says whether the agent can fix it by editing its own
 * inputs or must ask the user; `suggestedAction` is the sentence it acts on, never a restatement of `message`. */
export interface AgentError {
  code: string;
  category: ErrorCategory;
  message: string;
  /** JSON-pointer-ish location inside the offending document, when there is one. */
  path?: string;
  recoverable: boolean;
  suggestedAction?: string;
  documentation?: string;
}

export interface AgentWarning {
  code: string;
  message: string;
  path?: string;
}

/** A command the agent can run next, with why it would. */
export interface NextAction {
  command: string;
  description: string;
}

export interface AgentEnvelope<T> {
  schemaVersion: typeof AGENT_SCHEMA_VERSION;
  command: string;
  status: 'success' | 'error';
  data: T;
  warnings: AgentWarning[];
  errors: AgentError[];
  requiresApproval: boolean;
  nextActions: NextAction[];
}

export interface EnvelopeOptions {
  warnings?: AgentWarning[];
  errors?: AgentError[];
  requiresApproval?: boolean;
  nextActions?: NextAction[];
}

export function envelope<T>(command: string, data: T, opts: EnvelopeOptions = {}): AgentEnvelope<T> {
  const errors = opts.errors ?? [];
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    command,
    status: errors.length ? 'error' : 'success',
    data,
    warnings: opts.warnings ?? [],
    errors,
    requiresApproval: opts.requiresApproval ?? false,
    nextActions: opts.nextActions ?? [],
  };
}

/** Carries the structured error record plus the exit code the CLI should leave with; thrown by
 * services, unwrapped by the command layer. */
export class AgentFailure extends Error {
  constructor(
    readonly error: AgentError,
    readonly exitCode: ExitCodeValue = ExitCode.FAILURE,
  ) {
    super(error.message);
    this.name = 'AgentFailure';
  }
}

export function docLink(code: string): string {
  return `https://github.com/flui-cloud/vops/blob/main/docs/errors.md#${code.toLowerCase()}`;
}

/** Build a structured error with the documentation link filled in from the code. */
export function agentError(
  code: string,
  category: ErrorCategory,
  message: string,
  extra: Partial<Omit<AgentError, 'code' | 'category' | 'message'>> = {},
): AgentError {
  return {
    code,
    category,
    message,
    recoverable: extra.recoverable ?? (category === 'validation' || category === 'input'),
    ...(extra.path ? { path: extra.path } : {}),
    ...(extra.suggestedAction ? { suggestedAction: extra.suggestedAction } : {}),
    documentation: extra.documentation ?? docLink(code),
  };
}

/** Exit code implied by a category, for failures that do not name one. */
export function exitCodeFor(category: ErrorCategory): ExitCodeValue {
  const map: Record<ErrorCategory, ExitCodeValue> = {
    validation: ExitCode.VALIDATION,
    input: ExitCode.INVALID_INPUT,
    prerequisite: ExitCode.MISSING_PREREQUISITE,
    approval: ExitCode.APPROVAL_REQUIRED,
    auth: ExitCode.AUTH,
    unsupported: ExitCode.UNSUPPORTED,
    operational: ExitCode.FAILURE,
  };
  return map[category];
}
