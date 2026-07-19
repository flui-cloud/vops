/**
 * Shared findings/report model for the observation-plane commands (`host status`
 * and the future external `doctor`). "Report, don't gate": every probe yields a
 * Finding carrying a severity; the report's `worst` drives the exit code. Kept
 * dependency-free and pure so both planes render identically.
 */
export type Severity = 'ok' | 'info' | 'warn' | 'fail';

const RANK: Record<Severity, number> = { ok: 0, info: 1, warn: 2, fail: 3 };

export interface Finding {
  /** Stable check id, e.g. `sys.disk`. */
  id: string;
  severity: Severity;
  /** One-line human summary. */
  summary: string;
  /** Optional longer context (multi-line allowed). */
  detail?: string;
  /** The measured value that drove the severity, when there is one. */
  value?: string | number;
}

export interface Report {
  /** What was inspected (host name). */
  target: string;
  findings: Finding[];
  /** Highest severity across findings (`ok` when empty). */
  worst: Severity;
}

export const worseOf = (a: Severity, b: Severity): Severity =>
  RANK[a] >= RANK[b] ? a : b;

export const worstSeverity = (findings: Finding[]): Severity =>
  findings.reduce<Severity>((w, f) => worseOf(w, f.severity), 'ok');

export function buildReport(target: string, findings: Finding[]): Report {
  return { target, findings, worst: worstSeverity(findings) };
}

/**
 * Exit-code convention shared with doctor: fail → non-zero; warn → non-zero only
 * under `--strict`; ok/info → 0.
 */
export function reportExitCode(worst: Severity, strict = false): number {
  if (worst === 'fail') return 1;
  if (worst === 'warn' && strict) return 1;
  return 0;
}
