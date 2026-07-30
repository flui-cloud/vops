import { createHash } from 'node:crypto';
import { ExitCode, agentError } from '../agent-api/agent-envelope';
import { AgentBadRequest } from '../agent-api/agent-http-errors';

/**
 * What counts as importable public-key material, and the typed refusals for everything that is
 * not. The body is decoded and walked rather than pattern-matched: an OpenSSH public key is a
 * base64 blob of length-prefixed strings whose *first* string repeats the algorithm name. A prefix
 * regex — `^(ssh-…|ecdsa-sha2-\S+)\s+\S+` — reads the label and nothing else, so
 * `ssh-ed25519 !!!!notbase64!!!!` satisfies it and lands in the store with `fingerprint: ''`.
 * Decoding is what catches corrupt base64, a truncated blob, and a label that disagrees with its
 * own body.
 *
 * Refusals are `input`/exit 2 and carry no key material in their message: these strings reach
 * shells, logs and agent transcripts, and one of the inputs being refused is somebody's secret.
 */

export const SSH_KEY_MATERIAL_MISSING = 'VOPS_SSH_KEY_MATERIAL_MISSING';
export const SSH_KEY_MATERIAL_INVALID = 'VOPS_SSH_KEY_MATERIAL_INVALID';
export const SSH_KEY_MATERIAL_PRIVATE = 'VOPS_SSH_KEY_MATERIAL_PRIVATE';
export const SSH_KEY_FILE_MISSING = 'VOPS_SSH_KEY_FILE_MISSING';

/** Algorithms whose blob layout is known below. Unchanged from the regex it replaces — widening
 * the accepted set (sk-*, *-cert-v01) is a product decision, not part of rejecting garbage. */
const ALGORITHM = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-[A-Za-z0-9._-]+)$/;

/** Field count fixed by the wire format: RFC 4253 §6.6 (rsa: e,n — dss: p,q,g,y), RFC 5656 §3.1
 * (ecdsa: curve, Q) and draft-ietf-curdle-ssh-ed25519 (ed25519: key). Name included. */
const BLOB_FIELDS: Record<string, number> = { 'ssh-ed25519': 2, 'ssh-rsa': 3, 'ssh-dss': 5 };
const ECDSA_FIELDS = 3;
const ED25519_KEY_BYTES = 32;

export type PublicKeyRejection = { ok: false; kind: 'missing' | 'private' | 'malformed'; reason: string };
export type PublicKeyParse = { ok: true; algorithm: string; blob: Buffer; comment: string } | PublicKeyRejection;

export function parsePublicKey(text: string | undefined): PublicKeyParse {
  const raw = (text ?? '').trim();
  if (!raw) return no('missing', 'no public key material was given');
  if (/\bBEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY\b/.test(raw)) return no('private', 'this is a private key');
  if (/[\r\n]/.test(raw)) return no('malformed', 'expected exactly one key on a single line');

  const [algorithm, body, ...rest] = raw.split(/\s+/);
  if (!ALGORITHM.test(algorithm)) {
    return no('malformed', 'the first field is not a supported public-key algorithm (ssh-ed25519, ssh-rsa, ssh-dss, ecdsa-sha2-*)');
  }
  if (!body) return no('malformed', `only the algorithm '${algorithm}' was given, with no key body`);
  const blob = decodeBody(body);
  if (!blob) return no('malformed', 'the key body is not valid base64');

  const fields = readStrings(blob);
  if (!fields) return no('malformed', 'the key body is truncated: it does not decode to a whole SSH key blob');
  if (fields[0].toString('utf8') !== algorithm) {
    return no('malformed', `the key body is not an '${algorithm}' key — its own blob names a different algorithm`);
  }
  const expected = BLOB_FIELDS[algorithm] ?? ECDSA_FIELDS;
  if (fields.length !== expected) {
    return no('malformed', `an '${algorithm}' key blob holds ${expected} fields, this one holds ${fields.length}`);
  }
  if (algorithm === 'ssh-ed25519' && fields[1].length !== ED25519_KEY_BYTES) {
    return no('malformed', `an ed25519 public key is ${ED25519_KEY_BYTES} bytes, this one is ${fields[1].length}`);
  }
  return { ok: true, algorithm, blob, comment: rest.join(' ') };
}

/** `SHA256:<unpadded base64 of sha256(blob)>` — byte-for-byte what `ssh-keygen -lf` prints, from
 * the blob already parsed. No subprocess, so a fingerprint can no longer come back empty for a key
 * that validated, and `ssh-keygen`'s "is not a public key file" no longer leaks onto stderr. */
export function publicKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/={1,2}$/, '')}`;
}

/** Fingerprint of a stored `.pub` line, empty when it does not parse. Tolerant on purpose: `list()`
 * must still enumerate a key store that a previous version wrote garbage into. */
export function fingerprintOf(publicKey: string): string {
  const parsed = parsePublicKey(publicKey);
  return parsed.ok ? publicKeyFingerprint(parsed.blob) : '';
}

/** No `--from`, no `--pub`, no `--public-key` — or one of them present and empty. */
export function noKeyMaterial(): AgentBadRequest {
  return refusal(
    SSH_KEY_MATERIAL_MISSING,
    'Nothing to import: no SSH key material was given.',
    'Pass exactly one of --from <private-key-path> (recorded by reference, never copied), ' +
      '--pub <public-key-file>, or --public-key "ssh-ed25519 AAAA…". Nothing was stored.',
  );
}

export function keyFileMissing(half: 'private' | 'public', file: string): AgentBadRequest {
  return refusal(
    SSH_KEY_FILE_MISSING,
    `No ${half} key file at ${file}.`,
    `Check the path — \`ls ${file}\` — and pass one that exists. Nothing was stored.`,
  );
}

/** A secret where the public half belongs. Not recoverable by the agent: the remedy is never to
 * hand the private material over at all, and if it was pasted it is already exposed. */
export function privateKeyMaterial(origin: string): AgentBadRequest {
  return refusal(
    SSH_KEY_MATERIAL_PRIVATE,
    `That is a PRIVATE key, not a public one (${origin}).`,
    'Do not retry with the same value. vops never stores private material: import the key by ' +
      'reference with `vops ssh-key import <name> --from <path-to-private-key>`, which records the ' +
      'path and derives the public half locally, or pass the matching `.pub` file. Nothing was ' +
      'stored. If the private key was pasted on a command line, treat it as exposed and rotate it.',
    false,
  );
}

export function invalidPublicKey(origin: string, reason: string): AgentBadRequest {
  return refusal(
    SSH_KEY_MATERIAL_INVALID,
    `Not a usable OpenSSH public key (${origin}): ${reason}.`,
    'Do not retry with the same value — it would be stored with no fingerprint and authorize ' +
      'nothing. Take the whole single line of a `.pub` file (`ssh-ed25519 AAAA… comment`), or point ' +
      '--from at the private key and let vops derive it. Nothing was stored.',
  );
}

/** `ssh-keygen -y` could not read the file `--from` named: not a key, wrong format, or encrypted
 * with a passphrase nobody supplied. */
export function unusablePrivateKey(file: string, detail: string): AgentBadRequest {
  return refusal(
    SSH_KEY_MATERIAL_INVALID,
    `Could not derive a public key from ${file}: ${oneLine(detail)}`,
    `Confirm it is an OpenSSH private key — \`ssh-keygen -y -f ${file}\` must print its public ` +
      'half — and that any passphrase is loaded in your agent. Nothing was stored.',
  );
}

/** Turn a parse rejection into the refusal that matches its kind. */
export function publicKeyRefusal(rejection: PublicKeyRejection, origin: string): AgentBadRequest {
  if (rejection.kind === 'missing') return noKeyMaterial();
  if (rejection.kind === 'private') return privateKeyMaterial(origin);
  return invalidPublicKey(origin, rejection.reason);
}

function refusal(code: string, message: string, suggestedAction: string, recoverable = true): AgentBadRequest {
  return new AgentBadRequest(
    agentError(code, 'input', message, { recoverable, suggestedAction }),
    ExitCode.INVALID_INPUT,
  );
}

/** `ssh-keygen`'s multi-line stderr, flattened: the envelope is read as one line by both a shell
 * and an agent. */
function oneLine(detail: string): string {
  const flat = detail.replaceAll(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

function no(kind: PublicKeyRejection['kind'], reason: string): PublicKeyRejection {
  return { ok: false, kind, reason };
}

/** Strict base64: `Buffer.from` silently drops anything it does not recognise, so a round-trip is
 * the only way to tell `AAAA` from `AA!!AA`. */
function decodeBody(body: string): Buffer | null {
  if (body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const blob = Buffer.from(body, 'base64');
  return blob.toString('base64') === body ? blob : null;
}

/** The blob as its sequence of `uint32 length + bytes` strings; null unless it is exactly that,
 * with no trailing remainder — which is what a truncated or padded key looks like. */
function readStrings(blob: Buffer): Buffer[] | null {
  const out: Buffer[] = [];
  let at = 0;
  while (at + 4 <= blob.length) {
    const len = blob.readUInt32BE(at);
    at += 4;
    if (len > blob.length - at) return null;
    out.push(blob.subarray(at, at + len));
    at += len;
  }
  return at === blob.length && out.length > 0 ? out : null;
}
