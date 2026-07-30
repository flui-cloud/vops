/** Key identity across the local/provider boundary. Names do NOT cross it: a local key called
 * `laptop` and a provider key called `laptop` are unrelated strings that happen to match — which
 * is what let a plan reference a key the provider had never seen. The public material does cross
 * it, and it is the only thing that does. Fingerprints are avoided on purpose: providers publish
 * them in different digests (Hetzner MD5, `ssh-keygen -lf` SHA256), so comparing them is a
 * per-provider format trap. */

/** `<type> <base64>`, dropping the comment and any whitespace noise. Empty when unparseable. */
export function publicKeyBody(key: string): string {
  const [type, body] = (key ?? '').trim().split(/\s+/);
  const known = type?.startsWith('ssh-') || type?.startsWith('ecdsa-');
  if (!known || !body) return '';
  return `${type} ${body}`;
}

export function samePublicKey(a: string, b: string): boolean {
  const left = publicKeyBody(a);
  return left !== '' && left === publicKeyBody(b);
}
