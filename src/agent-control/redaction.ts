const SENSITIVE_KEY =
  /(^|_)(token|secret|password|passphrase|private[_-]?key|authorization|cookie|credential|api[_-]?key|client[_-]?secret)($|_)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URI_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi;

export interface RedactionResult<T> {
  value: T;
  applied: boolean;
}

export function redactSecrets<T>(input: T): RedactionResult<T> {
  let applied = false;

  function visit(value: unknown, key?: string): unknown {
    if (key && isSensitiveKey(key)) {
      applied = true;
      return '[REDACTED]';
    }
    if (typeof value === 'string') {
      const redacted = value
        .replace(BEARER, 'Bearer [REDACTED]')
        .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
        .replace(URI_CREDENTIAL, '$1[REDACTED]@');
      if (redacted !== value) applied = true;
      return redacted;
    }
    if (Array.isArray(value)) return value.map((entry) => visit(entry));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
          entryKey,
          visit(entry, entryKey),
        ]),
      );
    }
    return value;
  }

  return { value: visit(input) as T, applied };
}

export function containsSecretLikeField(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  if (Array.isArray(input)) return input.some(containsSecretLikeField);
  return Object.entries(input as Record<string, unknown>).some(
    ([key, value]) => isSensitiveKey(key) || containsSecretLikeField(value),
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SENSITIVE_KEY.test(normalized);
}
