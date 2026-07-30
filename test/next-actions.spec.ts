import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every `nextActions` command an envelope emits must actually be runnable.
 *
 * An agent is told to act on these verbatim, so a wrong flag is worse than no
 * suggestion: it reads as authoritative and fails at the shell. This caught
 * `vops app setup --host <h>` — the command takes a positional argument — which
 * no type checker or unit test could have seen, because the string is data.
 */
describe('nextActions are runnable', () => {
  const root = path.join(__dirname, '..');

  const sources = (): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) out.push(p);
      }
    };
    walk(path.join(root, 'src'));
    return out;
  };

  const templates = (): string[] => {
    const found = new Set<string>();
    for (const f of sources()) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/command: `([^`]+)`/g)) found.add(m[1]);
      for (const m of s.matchAll(/command: '([^']+)'/g)) found.add(m[1]);
    }
    return [...found].filter((c) => c.startsWith('vops ')).sort();
  };

  // Placeholders (`${id}`, `<host>`) stand for values, not for command words.
  const concrete = (c: string): string => c.replaceAll(/\$\{[^}]+\}/g, 'X').replaceAll(/<[^>]+>/g, 'X');

  const helpFor = (words: string[]): string =>
    execFileSync(process.execPath, [path.join(root, 'bin', 'run'), ...words, '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  it.each(templates())('%s', (template) => {
    const c = concrete(template);
    const words: string[] = [];
    for (const t of c.slice('vops '.length).split(/\s+/)) {
      if (t.startsWith('-') || t === 'X') break;
      words.push(t);
    }
    const help = helpFor(words);
    for (const flag of c.match(/--[a-z-]+/g) ?? []) {
      expect({ template, flag, exists: help.includes(flag) }).toEqual({ template, flag, exists: true });
    }
  });
});
