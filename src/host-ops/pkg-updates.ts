import { OsFamily } from '../hosts/host.model';

/**
 * On-demand "which packages are pending" probe. A separate, bounded read-only
 * SSH round-trip (not part of the fast status battery): the list can be long, so
 * it is fetched only when the user asks. Kept dependency-free and pure so the
 * script builder and parser are testable against captured debian/rhel fixtures.
 */
export interface PendingPackage {
  name: string;
  current: string | null;
  candidate: string | null;
  security: boolean;
}

export interface PendingUpdates {
  packages: PendingPackage[];
  total: number;
  truncated: boolean;
}

const LIST_LIMIT = 300;

// Each body emits a headed package list plus a `@@count <total>` computed from
// the FULL (pre-head) set, so the parser can tell the list was truncated.
const DEBIAN_BODY = [
  "_u=$(apt-get -s upgrade 2>/dev/null | grep '^Inst ')",
  'echo "@@list"',
  String.raw`printf '%s\n' "$_u" | grep '^Inst ' | head -n ${LIST_LIMIT}`,
  String.raw`echo "@@count $(printf '%s\n' "$_u" | grep -c '^Inst ')"`,
].join('\n');

const RHEL_BODY = [
  "_c=$(dnf -q check-update 2>/dev/null | grep -E '^[[:alnum:]][^[:space:]]*[[:space:]]')",
  'echo "@@list"',
  String.raw`printf '%s\n' "$_c" | head -n ${LIST_LIMIT}`,
  'echo "@@security"',
  String.raw`dnf -q updateinfo list security 2>/dev/null | grep -E '\.[^[:space:]]+$' | head -n ${LIST_LIMIT}`,
  String.raw`echo "@@count $(printf '%s\n' "$_c" | grep -c '^[[:alnum:]]')"`,
].join('\n');

const PRELUDE = 'set +e\nexport LC_ALL=C';

// When the OS wasn't detected, pick the package manager at runtime — the same
// `command -v` fallback the status battery uses for its count, so the detail
// never disagrees with the badge on an unknown-family host.
const AUTO_BODY = [
  'if command -v apt-get >/dev/null 2>&1; then',
  DEBIAN_BODY,
  'elif command -v dnf >/dev/null 2>&1; then',
  RHEL_BODY,
  'else echo "@@count 0"; fi',
].join('\n');

/** Render the on-demand pending-updates script for a given OS family. */
export function buildPendingUpdatesScript(family: OsFamily): string {
  const body = bodyFor(family);
  return `${PRELUDE}\n${body}`;
}

function bodyFor(family: OsFamily): string {
  if (family === 'debian') return DEBIAN_BODY;
  if (family === 'rhel') return RHEL_BODY;
  return AUTO_BODY;
}

interface Sections {
  list: string[];
  security: string[];
  count: number;
}

const COUNT_MARK = '@@count';

function split(stdout: string): Sections {
  const out: Sections = { list: [], security: [], count: 0 };
  let cur: 'list' | 'security' | '' = '';
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(COUNT_MARK)) {
      const n = Number(line.slice(COUNT_MARK.length).trim());
      out.count = Number.isFinite(n) ? n : 0;
      cur = '';
    } else if (line === '@@list') {
      cur = 'list';
    } else if (line === '@@security') {
      cur = 'security';
    } else if (cur) {
      out[cur].push(line);
    }
  }
  return out;
}

// Remote text is untrusted: drop ANSI escape sequences (ESC built at runtime so
// no control byte lives in this source) and anything outside printable ASCII,
// bound field lengths, and reject any name that isn't a plausible package id.
const ANSI = new RegExp(String.fromCodePoint(27) + String.raw`\[[0-9;]*[A-Za-z]`, 'g');
const CTRL = /[^\x20-\x7e]/g;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+:-]*$/;

const clean = (s: string): string => s.replace(ANSI, '').replace(CTRL, '').trim();
const boundName = (s: string): string => clean(s).slice(0, 64);

function boundVer(s: string | null): string | null {
  if (s == null) return null;
  const v = clean(s).slice(0, 48);
  return v || null;
}

function stripArch(token: string): string {
  const dot = token.lastIndexOf('.');
  return dot > 0 ? token.slice(0, dot) : token;
}

// First `<open>…<close>` span, or a fallback when it isn't a matched pair.
function between(s: string, open: string, close: string, fallback: string | null): string | null {
  const a = s.indexOf(open);
  if (a < 0) return fallback;
  const b = s.indexOf(close, a + 1);
  return b > a ? s.slice(a + 1, b) : fallback;
}

// `Inst <name> [<cur>] (<new> <origin> [arch])`. The `[cur]` bracket (when
// present) sits before the `(`; the security signal is the origin text inside
// the parens.
function parseDebianRow(line: string): PendingPackage | null {
  if (!line.startsWith('Inst ')) return null;
  const rest = line.slice(5).trim();
  const name = boundName(rest.split(/\s+/)[0] ?? '');
  if (!NAME_RE.test(name)) return null;
  // `[cur]` lives before the `(`; `[arch]` lives inside it — read current only from the head.
  const current = between(rest.split('(')[0], '[', ']', null);
  const paren = between(rest, '(', ')', '') ?? '';
  return {
    name,
    current: boundVer(current),
    candidate: boundVer(paren.split(/\s+/)[0] ?? ''),
    security: /security/i.test(paren),
  };
}

// `dnf updateinfo list security` rows end in a `name.arch` token — collect the
// package names so the check-update rows can be flagged by set membership.
function securitySet(lines: string[]): Set<string> {
  const set = new Set<string>();
  for (const line of lines) {
    const toks = clean(line).split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const name = boundName(stripArch(toks.at(-1) ?? ''));
    if (NAME_RE.test(name)) set.add(name);
  }
  return set;
}

// `check-update` rows: `name.arch  version-release  repo`. dnf gives no current
// version here, so it stays null.
function parseRhelRow(line: string, security: Set<string>): PendingPackage | null {
  const toks = clean(line).split(/\s+/).filter(Boolean);
  if (toks.length < 2) return null;
  const name = boundName(stripArch(toks[0]));
  if (!NAME_RE.test(name)) return null;
  return { name, current: null, candidate: boundVer(toks[1]), security: security.has(name) };
}

// The undetected-OS script auto-selects apt or dnf at runtime, so for an unknown
// family route the parser by content — debian emits `Inst ` lines, dnf does not.
function packagesFor(family: OsFamily, s: Sections): PendingPackage[] {
  const debian = family === 'debian' || (family !== 'rhel' && s.list.some((l) => l.startsWith('Inst ')));
  if (debian) {
    return s.list.flatMap((l) => { const p = parseDebianRow(l); return p ? [p] : []; });
  }
  const sec = securitySet(s.security);
  return s.list.flatMap((l) => { const p = parseRhelRow(l, sec); return p ? [p] : []; });
}

export function parsePendingUpdates(family: OsFamily, stdout: string): PendingUpdates {
  const s = split(stdout);
  const packages = packagesFor(family, s);
  packages.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name));
  return { packages, total: s.count, truncated: s.count > packages.length };
}
