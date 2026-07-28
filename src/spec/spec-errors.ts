import type { FluiValidationError, FluiValidationWarning } from '@flui-cloud/spec';
import { AgentError, AgentWarning, agentError } from '../agent-api/agent-envelope';

/** flui-spec speaks Ajv; agents need a code to branch on and an action to take. Intentionally
 * coarse — a handful of stable codes, detail carried in `message`/`path` — since adding a finer
 * code later is additive but renaming one isn't. */

export const SPEC_ERROR = {
  PARSE: 'VOPS_SPEC_PARSE_ERROR',
  UNSUPPORTED_KIND: 'VOPS_SPEC_UNSUPPORTED_KIND',
  MISSING_FIELD: 'VOPS_SPEC_MISSING_FIELD',
  INVALID_TYPE: 'VOPS_SPEC_INVALID_TYPE',
  INVALID_VALUE: 'VOPS_SPEC_INVALID_VALUE',
  UNKNOWN_FIELD: 'VOPS_SPEC_UNKNOWN_FIELD',
  REFERENCE_NOT_FOUND: 'VOPS_SPEC_REFERENCE_NOT_FOUND',
  INVALID: 'VOPS_SPEC_INVALID',
} as const;

/** Warnings the hosted runtime calls "planned" but vops does apply on a host.
 * `resources.profile` and `scaling` are NOT here — vops honours resources.limits
 * only, and runs a single replica. */
const APPLIED_BY_VOPS = ['/deploy/env'];

export function toSpecErrors(errors: FluiValidationError[]): AgentError[] {
  return errors.map(toSpecError);
}

function toSpecError(e: FluiValidationError): AgentError {
  const { code, action } = classify(e);
  return agentError(code, 'validation', e.message, {
    path: e.path,
    recoverable: true,
    suggestedAction: action,
  });
}

function classify(e: FluiValidationError): { code: string; action: string } {
  const msg = e.message.toLowerCase();
  if (e.path === '/kind' || msg.includes('unsupported kind')) {
    return {
      code: SPEC_ERROR.UNSUPPORTED_KIND,
      action: 'Set kind to Application (a custom app you build) or CatalogApp (a packaged product).',
    };
  }
  if (msg.startsWith('must have required property') || isMissingPath(e)) {
    return { code: SPEC_ERROR.MISSING_FIELD, action: `Add ${e.path}. See: vops spec schema --kind Application` };
  }
  if (msg.includes('must not have additional')) {
    return {
      code: SPEC_ERROR.UNKNOWN_FIELD,
      action: `Remove ${e.path} — it is not part of the spec. See: vops spec schema --kind Application`,
    };
  }
  if (msg.startsWith('must be equal to one of')) {
    return { code: SPEC_ERROR.INVALID_VALUE, action: `Use one of the allowed values for ${e.path}.` };
  }
  if (msg.startsWith('must be')) {
    return { code: SPEC_ERROR.INVALID_TYPE, action: `Correct the type of ${e.path}.` };
  }
  if (msg.includes('unknown component') || msg.includes('must appear in') || msg.includes('does not exist')) {
    return { code: SPEC_ERROR.REFERENCE_NOT_FOUND, action: `Define the referenced name, or point ${e.path} at one that exists.` };
  }
  return { code: SPEC_ERROR.INVALID, action: `Correct ${e.path} and re-run: vops spec validate <file>` };
}

/** Ajv reports `required` with the missing key appended to the parent path. */
function isMissingPath(e: FluiValidationError): boolean {
  return typeof e.params?.missingProperty === 'string';
}

export function toSpecWarnings(warnings: FluiValidationWarning[]): AgentWarning[] {
  return warnings.map((w) => ({
    code: appliedByVops(w.path) ? 'VOPS_SPEC_APPLIED_LOCALLY' : 'VOPS_SPEC_PLANNED_FIELD',
    message: appliedByVops(w.path) ? `${w.message} (vops applies this on a single host.)` : w.message,
    path: w.path,
  }));
}

/** flui-spec's "not applied on source deploys" advisories describe the hosted Flui runtime, but
 * vops's Podman host DOES apply generated secrets and env — so the advisory is re-labelled rather
 * than passed through as if the field would be dropped. */
function appliedByVops(path: string): boolean {
  return APPLIED_BY_VOPS.some((p) => path === p || path.startsWith(`${p}/`));
}
