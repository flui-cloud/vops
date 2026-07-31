import { AgentOperation } from './agent-model';

type Verification = NonNullable<AgentOperation['verification']>;

/** Only capabilities that return a verdict count as verification. `application.status`
 * reports state, not health, so it does not qualify. */
const VERIFYING_CAPABILITIES = new Set(['healthcheck.run']);

const VERDICT: Record<string, Verification['status']> = {
  healthy: 'passed',
  degraded: 'degraded',
  unknown: 'not_verified',
};

/** Read the plan's own verification steps back. A plan whose every command returned
 * cleanly can still have left the application unhealthy, and the operation must say so
 * rather than report a bare success. */
export function summariseVerification(
  results: Array<{ step: string; capability: string; output: unknown }>,
): Verification {
  const checks = results
    .filter((entry) => VERIFYING_CAPABILITIES.has(entry.capability))
    .map((entry) => ({
      capability: entry.capability,
      step: entry.step,
      status: reportStatus(entry.output),
      failed: failedCheckNames(entry.output),
    }));
  if (!checks.length) return { status: 'not_verified', checks };
  if (checks.some((check) => check.failed.length)) return { status: 'degraded', checks };
  const verdicts = new Set(checks.map((check) => VERDICT[check.status] ?? 'not_verified'));
  if (verdicts.has('degraded')) return { status: 'degraded', checks };
  if (verdicts.has('not_verified')) return { status: 'not_verified', checks };
  return { status: 'passed', checks };
}

function reportStatus(output: unknown): string {
  const status = record(output)?.status;
  return typeof status === 'string' ? status : 'unknown';
}

function failedCheckNames(output: unknown): string[] {
  const checks = record(output)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((check) => record(check)?.status === 'fail')
    .map((check) => {
      const name = record(check)?.name;
      return typeof name === 'string' ? name : 'check';
    });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
