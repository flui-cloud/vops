import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { configBase } from '../profile';

/** Moves credentials out of the plaintext `.env` (where env-based providers like
 * OVH/Contabo read them today) into the vault. Importing alone doesn't remove the
 * exposure — pruning, a separate explicit step, is what does. */
export interface EnvEntry {
  name: string;
  /** `secret` is the exposure; `companion` travels with it to keep a set whole. */
  kind: 'secret' | 'companion';
}

export interface EnvImportPlan {
  file: string;
  entries: EnvEntry[];
  /** Names left untouched — not credentials, so not ours to move. */
  ignored: string[];
}

/** Names whose VALUE is the secret. Substring match, case-insensitive. */
const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|_KEY$|PRIVATE)/i;

/** Credential families vops reads from the environment. OS_* is OVH's OpenStack
 * credential (one set spans every region); others resolve via ConfigService. */
const CREDENTIAL_PREFIXES = ['OS_', 'CONTABO_', 'CHERRY_', 'HETZNER_', 'SCALEWAY_'];

export function defaultEnvFile(): string {
  return path.join(configBase(), '.env');
}

export function planEnvImport(file = defaultEnvFile()): EnvImportPlan {
  if (!fs.existsSync(file)) return { file, entries: [], ignored: [] };
  const parsed = dotenv.parse(fs.readFileSync(file));

  const names = Object.keys(parsed).filter((name) => parsed[name]);
  const entries = names
    .filter((name) => SECRET_NAME.test(name) || hasCredentialPrefix(name))
    .map((name): EnvEntry => ({ name, kind: SECRET_NAME.test(name) ? 'secret' : 'companion' }));
  const taken = new Set(entries.map((e) => e.name));

  return { file, entries, ignored: names.filter((name) => !taken.has(name)) };
}

/** Read the values a plan refers to. Kept separate so a plan can be shown safely. */
export function readEnvValues(plan: EnvImportPlan): Record<string, string> {
  if (!plan.entries.length) return {};
  const parsed = dotenv.parse(fs.readFileSync(plan.file));
  return Object.fromEntries(plan.entries.map((e) => [e.name, parsed[e.name]]));
}

/** Line-oriented so hand-edited comments/blanks survive verbatim. Writes a 0600
 * `.bak` first since this is the only step here that destroys plaintext. */
export function pruneEnvFile(file: string, names: string[]): { removed: string[]; backup: string } {
  const remove = new Set(names);
  const original = fs.readFileSync(file, 'utf8');
  const backup = `${file}.bak`;
  fs.writeFileSync(backup, original, { mode: 0o600 });

  const removed: string[] = [];
  const kept = original.split('\n').filter((line) => {
    const name = assignedName(line);
    if (!name || !remove.has(name)) return true;
    removed.push(name);
    return false;
  });

  fs.writeFileSync(file, kept.join('\n'), { mode: 0o600 });
  return { removed, backup };
}

/** The variable a line assigns, or null for comments, blanks and continuations. */
function assignedName(line: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/.exec(line);
  return match ? match[1] : null;
}

function hasCredentialPrefix(name: string): boolean {
  return CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
