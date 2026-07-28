import * as crypto from 'node:crypto';

/** Digest both sides first: `timingSafeEqual` throws on a length mismatch, and
 * that throw would itself leak the length of the expected secret. */
export function secretEquals(provided: string | undefined | null, expected: string): boolean {
  if (!provided || !expected) return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(provided).digest(),
    crypto.createHash('sha256').update(expected).digest(),
  );
}
