import { KEY_DOMAIN, KeyDomain } from './derive';

/** Newline-delimited JSON, one request per connection — nothing to desynchronise.
 * Every request carries the cookie since the transport's own ACL isn't trusted. */

export type KeyringOp = 'status' | 'unlock' | 'key' | 'lock';

export interface KeyringRequest {
  op: KeyringOp;
  cookie: string;
  /** `unlock` only. */
  passphrase?: string;
  /** `key` only. */
  domain?: KeyDomain;
}

export type KeyringResponse =
  | { ok: true; op: 'status'; unlocked: boolean; expiresAt: number | null }
  | { ok: true; op: 'unlock' | 'lock' }
  | { ok: true; op: 'key'; key: string }
  | { ok: false; error: string; code: KeyringErrorCode };

export type KeyringErrorCode = 'locked' | 'unauthorized' | 'bad-request' | 'bad-passphrase' | 'internal';

const DOMAINS = new Set<string>(Object.values(KEY_DOMAIN));
const MAX_LINE = 64 * 1024;

export function encodeRequest(req: KeyringRequest): string {
  return JSON.stringify(req) + '\n';
}

export function encodeResponse(res: KeyringResponse): string {
  return JSON.stringify(res) + '\n';
}

/** Local socket, but still untrusted input: a malformed line must produce a typed
 * error, never a throw that takes the daemon down. */
export function decodeRequest(line: string): KeyringRequest | { error: string } {
  if (line.length > MAX_LINE) return { error: 'Request too large.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: 'Request is not valid JSON.' };
  }
  if (!isRecord(parsed)) return { error: 'Request is not an object.' };

  const { op, cookie, passphrase, domain } = parsed;
  if (op !== 'status' && op !== 'unlock' && op !== 'key' && op !== 'lock') {
    return { error: `Unknown op '${shown(op)}'.` };
  }
  if (typeof cookie !== 'string' || !cookie) return { error: 'Missing cookie.' };
  if (op === 'unlock' && (typeof passphrase !== 'string' || !passphrase)) {
    return { error: 'unlock requires a passphrase.' };
  }
  if (op === 'key' && !DOMAINS.has(shown(domain))) {
    return { error: `Unknown key domain '${shown(domain)}'.` };
  }

  return {
    op,
    cookie,
    ...(typeof passphrase === 'string' ? { passphrase } : {}),
    ...(op === 'key' ? { domain: domain as KeyDomain } : {}),
  };
}

export function decodeResponse(line: string): KeyringResponse {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw new Error('Malformed keyring response.');
  }
  return parsed as unknown as KeyringResponse;
}

export function errorResponse(code: KeyringErrorCode, error: string): KeyringResponse {
  return { ok: false, code, error };
}

export type KeyringError = Extract<KeyringResponse, { ok: false }>;

/** Explicit guard: this project compiles with `strict: false`, where narrowing a
 *  union by a literal boolean is not reliable. */
export function isKeyringError(res: KeyringResponse): res is KeyringError {
  return res.ok === false;
}

/** Render an untrusted value for an error message without '[object Object]'. */
function shown(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? typeof value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
