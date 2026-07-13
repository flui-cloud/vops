/**
 * Pure authorized_keys transforms — the highest-risk code in the day-2 spec, so
 * kept side-effect-free and exhaustively unit-tested. vops finds *its own* line by
 * the `vops-ops:<profileId>` comment tag, never by parsing key material, and every
 * mutation preserves the lockout invariant: it must never be the operation that
 * removes the last working access path.
 */

export const opsTag = (profileId: string): string => `vops-ops:${profileId}`;

const isKeyType = (tok: string): boolean =>
  tok.startsWith('ssh-') ||
  tok.startsWith('ecdsa-sha2-') ||
  tok.startsWith('sk-ssh-') ||
  tok.startsWith('sk-ecdsa-');

function toLines(content: string): string[] {
  const trimmed = content.replace(/\n+$/, '');
  return trimmed.length ? trimmed.split('\n') : [];
}

function fromLines(lines: string[]): string {
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** A real, non-comment authorized_keys entry (options prefix allowed). */
function isKeyLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith('#')) return false;
  const parts = t.split(/\s+/);
  if (isKeyType(parts[0])) return Boolean(parts[1]);
  if (isKeyType(parts[1] ?? '')) return Boolean(parts[2]);
  return false;
}

/** Is this the vops ops line for the given profile (matched by its trailing tag)? */
export function isOpsLine(line: string, tag: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith('#')) return false;
  return t.endsWith(` ${tag}`) || t === tag;
}

/**
 * Idempotently set the ops line: replace any existing line carrying this profile's
 * tag with `line`, otherwise append it. `changed` is false when the file already
 * contained exactly `line` (nothing to write).
 */
export function upsertOpsLine(
  content: string,
  line: string,
  tag: string,
): { content: string; changed: boolean } {
  const lines = toLines(content);
  const alreadyIdentical = lines.some((l) => l.trim() === line.trim());
  const withoutOps = lines.filter((l) => !isOpsLine(l, tag));
  return { content: fromLines([...withoutOps, line]), changed: !alreadyIdentical };
}

/** Remove exactly the tagged ops line(s); reports how many were removed. */
export function removeOpsLine(content: string, tag: string): { content: string; removed: number } {
  const lines = toLines(content);
  const kept = lines.filter((l) => !isOpsLine(l, tag));
  return { content: fromLines(kept), removed: lines.length - kept.length };
}

/** Is there ≥1 authorized key that is NOT this profile's ops line? (lockout guard) */
export function hasOtherAuthorizedKey(content: string, tag: string): boolean {
  return toLines(content).some((l) => isKeyLine(l) && !isOpsLine(l, tag));
}

/** Does the given public-key blob (the base64 field) appear authorized? */
export function authorizesKeyData(content: string, publicKey: string): boolean {
  const data = publicKey.split(/\s+/)[1];
  if (!data) return false;
  return toLines(content).some((l) => isKeyLine(l) && l.includes(data));
}

const KEY_TYPE_RE = /^(ssh-|ecdsa-|sk-)/;

/** The options prefix of a key line (comma list before the key type), or '' if none. */
export function extractOptions(line: string): string {
  const parts = line.trim().split(/\s+/);
  if (!parts.length || KEY_TYPE_RE.test(parts[0])) return '';
  return KEY_TYPE_RE.test(parts[1] ?? '') ? parts[0] : '';
}

/** Compose an ops authorized_keys line from a public key, a tag and an options prefix. */
export function buildOpsLine(publicKey: string, tag: string, options: string): string {
  const [type, data] = publicKey.split(/\s+/);
  return `${options} ${type} ${data} ${tag}`.trim();
}

export function findOpsLine(content: string, tag: string): string | null {
  return toLines(content).find((l) => isOpsLine(l, tag)) ?? null;
}

export type RotateState = 'done' | 'mid' | 'old' | 'absent';

/**
 * Classify a host's rotation state from its authorized_keys — the file is the
 * source of truth, so resume-after-crash is just re-running the machine.
 *   done   canonical line already carries the NEW key
 *   mid    a temp line exists (APPEND happened, SWAP did not)
 *   old    canonical line present (still the OLD key), no temp
 *   absent no vops ops line at all
 */
export function classifyRotation(
  content: string,
  canonicalTag: string,
  tempTag: string,
  nextPublicKey: string,
): RotateState {
  const canonical = findOpsLine(content, canonicalTag);
  const nextData = nextPublicKey.split(/\s+/)[1] ?? '\0';
  if (canonical?.includes(nextData)) return 'done';
  if (findOpsLine(content, tempTag)) return 'mid';
  if (canonical) return 'old';
  return 'absent';
}
