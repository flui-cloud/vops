import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';

/**
 * Editing of the profile-scoped known_hosts file (see `knownHostsPath`). A destroyed server's
 * host key must go with it: provider IP pools are recycled, so the next machine at that address
 * presents a different key and every vops SSH attempt aborts with "host key verification failed"
 * until someone runs `ssh-keygen -R` by hand.
 */
export interface KnownHostTarget {
  address: string;
  port?: number;
}

const MARKERS = new Set(['@cert-authority', '@revoked']);
const HASHED = /^\|1\|([^|]+)\|(.+)$/;

/** The literal patterns OpenSSH writes for an address: bare on port 22, `[addr]:port` otherwise.
 * Both bracketed forms are covered because the recorded port may differ from today's. */
function patternsFor(t: KnownHostTarget): string[] {
  const port = t.port ?? 22;
  return [t.address, `[${t.address}]:${port}`, `[${t.address}]:22`];
}

/** Hashed entries (`|1|salt|hash`) hide the hostname behind HMAC-SHA1 keyed by the salt —
 * Debian/Ubuntu ship `HashKnownHosts yes`, so skipping them would no-op on most Linux laptops. */
function matchesHashed(pattern: string, names: string[]): boolean {
  const m = HASHED.exec(pattern);
  if (!m) return false;
  const salt = Buffer.from(m[1], 'base64');
  return names.some((n) => createHmac('sha1', salt).update(n).digest('base64') === m[2]);
}

function pruneLine(line: string, names: string[], lower: Set<string>): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return line;
  const fields = trimmed.split(/\s+/);
  const offset = MARKERS.has(fields[0]) ? 1 : 0;
  const hostField = fields[offset];
  if (!hostField) return line;
  const patterns = hostField.split(',');
  const keep = patterns.filter((p) => !lower.has(p.toLowerCase()) && !matchesHashed(p, names));
  if (keep.length === patterns.length) return line;
  if (keep.length === 0) return null;
  return [...fields.slice(0, offset), keep.join(','), ...fields.slice(offset + 1)].join(' ');
}

/** Drop every entry for `targets`, keeping the rest of the file byte-identical (pure). A line
 * naming several hosts loses only the matching names. */
export function pruneKnownHosts(
  content: string,
  targets: KnownHostTarget[],
): { content: string; removed: number } {
  const names = [...new Set(targets.flatMap(patternsFor))];
  if (names.length === 0) return { content, removed: 0 };
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const kept: string[] = [];
  let removed = 0;
  for (const line of content.split('\n')) {
    const next = pruneLine(line, names, lower);
    if (next == null) removed += 1;
    else kept.push(next);
  }
  return { content: kept.join('\n'), removed };
}

/** Apply `pruneKnownHosts` to a file, rewriting it only when something matched. */
export function pruneKnownHostsFile(file: string, targets: KnownHostTarget[]): number {
  if (!fs.existsSync(file)) return 0;
  const { content, removed } = pruneKnownHosts(fs.readFileSync(file, 'utf8'), targets);
  if (removed > 0) fs.writeFileSync(file, content, { mode: 0o600 });
  return removed;
}
