import { sha256 } from './plan-store';

/**
 * `--set` values never reach the plan file.
 *
 * A plan is an artifact that outlives the command that made it: it sits in the repo's `.vops/`,
 * `apply` re-reads it, and under the agent control plane a coding agent proposes and reads it too.
 * A password written there is a password handed to whoever — or whatever — opens the file next,
 * which is exactly what the vault exists to prevent for every other secret vops holds.
 *
 * So the plan keeps a digest per key and the values live in the vault. The digest is enough for
 * `apply` to prove the values it replays are the ones that were approved, and useless to anyone
 * who only has the file.
 */

/** Stands in for a redacted value. Deliberately not `***`: it says who removed it and why. */
export const SET_MASK = '<hidden by vops: supplied with --set>';

/** Below this, a value collides with ordinary plan text more often than it protects anything —
 * `--set PORT=80` would blank every 80 in the document. Short values still stay out of `inputs`
 * and are still masked on their own `Environment=` line, which is where the renderer puts them. */
const MIN_SCAN_LENGTH = 4;

export function setDigests(set?: Record<string, string>): Record<string, string> | undefined {
  if (!set || !Object.keys(set).length) return undefined;
  return Object.fromEntries(Object.entries(set).map(([key, value]) => [key, sha256(value)]));
}

/** True when every declared digest matches the value we are about to replay. */
export function digestsMatch(digests: Record<string, string> | undefined, set: Record<string, string>): boolean {
  const expected = setDigests(set) ?? {};
  const keys = Object.keys(digests ?? {});
  return keys.length === Object.keys(expected).length && keys.every((k) => digests?.[k] === expected[k]);
}

/**
 * Remove `--set` values from a rendered plan before it is stored or returned.
 *
 * Two passes, because under-redaction is a leak and over-redaction is only an inconvenience:
 * the exact `Environment=KEY=` line the quadlet renderer writes, then any other place the value
 * reached. Both are deterministic, so `plan` and `apply` still hash to the same thing.
 */
export function redactSet<T>(view: T, set?: Record<string, string>): T {
  if (!set || !Object.keys(set).length) return view;
  let json = JSON.stringify(view);
  for (const [key, value] of Object.entries(set)) {
    const encoded = jsonFragment(value);
    json = json.split(`Environment=${key}=${encoded}`).join(`Environment=${key}=${SET_MASK}`);
    if (value.length >= MIN_SCAN_LENGTH) json = json.split(encoded).join(SET_MASK);
  }
  return JSON.parse(json) as T;
}

/** The value as it appears *inside* a JSON string, so a quote or backslash still matches. */
function jsonFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
