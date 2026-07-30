import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface CommandIndex {
  commands: { id: string; args: string[]; flags: [name: string, type: string, char?: string][]; strict: boolean }[];
  topics: string[];
}

/** oclif cannot load the built commands inside jest (they pull in ESM-only deps), so the
 * command tree is dumped from a plain node process — the same one `bin/run` would use. */
const DUMP = `
const { Config } = require('@oclif/core');
Config.load(process.argv[1]).then((c) => {
  process.stdout.write(JSON.stringify({
    commands: c.commands.map((x) => ({
      id: x.id,
      args: Object.keys(x.args ?? {}),
      flags: Object.entries(x.flags ?? {}).map(([n, f]) => [n, f.type, f.char]),
      strict: x.strict !== false,
    })),
    topics: c.topics.map((t) => t.name),
  }));
});
`;

/**
 * Every `vops …` command printed in the published docs must exist, take the arguments it is
 * shown taking, and know every flag it is shown with.
 *
 * A command string in a README is data: no compiler sees it, and it rots the moment a flag is
 * renamed. This caught `providers regions hetzner` (the per-provider command is `locations`),
 * `servers plan --region` (it is `--location`), `servers create <plan-file>` and
 * `host-firewall render <plan>` (both take flags, not a positional) and
 * `config set hetzner YOUR_TOKEN` (the token goes in `--token`) — six wrong commands in the
 * README, three of which nobody had noticed by running it.
 *
 * Scope: the two documents that ship. Everything else under `docs/` is gitignored internal
 * analysis describing commands that may never exist, so holding it to this bar would be wrong.
 */
describe('documented commands are real', () => {
  const root = path.join(__dirname, '..');
  const DOCS = ['README.md', 'docs/errors.md'];

  /** Fenced blocks line by line, plus inline `code` spans in prose. */
  const snippets = (md: string): string[] => {
    const out: string[] = [];
    let fenced = false;
    for (const line of md.split('\n')) {
      if (line.trimStart().startsWith('```')) fenced = !fenced;
      else if (fenced) out.push(line);
      else for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]);
    }
    return out;
  };

  /** `a / b / c` and `a|b` are prose shorthand for several commands sharing a prefix. */
  const expand = (c: string): string[] => {
    const [head, ...rest] = c.split(' / ');
    const prefix = head.split(/\s+/).slice(0, -1).join(' ');
    const variants = [head, ...rest.map((r) => `${prefix} ${r}`)];
    return variants.flatMap((v) => {
      const tokens = v.split(/\s+/);
      const i = tokens.findIndex((t) => t.includes('|'));
      if (i < 0) return [v];
      return tokens[i].split('|').map((alt) => [...tokens.slice(0, i), alt, ...tokens.slice(i + 1)].join(' '));
    });
  };

  const commandsIn = (doc: string): string[] => {
    const found = new Set<string>();
    for (const s of snippets(fs.readFileSync(path.join(root, doc), 'utf8'))) {
      const c = s.split(/\s#/)[0].trim().replace(/^\$\s+/, '');
      if (/^vops(\s|$)/.test(c)) for (const v of expand(c)) found.add(v);
    }
    return [...found].sort();
  };

  /**
   * A value the reader has to substitute, not a word they would type: `<name>`, `${id}`,
   * `[opt]`, an ALL_CAPS stand-in (`YOUR_HETZNER_TOKEN`), or a flag. Everything else is
   * literal, and has to be a real command word or an argument the command declares.
   */
  const isPlaceholder = (t: string): boolean => t.startsWith('-') || /^["'`]?[<[$]/.test(t) || /^[A-Z][A-Z0-9_]+$/.test(t);

  const cases: [string, string][] = DOCS.flatMap((d) => commandsIn(d).map((c): [string, string] => [d, c]));

  const cli: CommandIndex = JSON.parse(
    execFileSync(process.execPath, ['-e', DUMP, root], { cwd: root, encoding: 'utf8' }),
  );
  const byId = new Map(cli.commands.map((c) => [c.id, c]));

  /** Longest leading run of literal words that names a command — `watch plan add`, not `watch`. */
  const resolve = (words: string[]): { id?: string; used: number } => {
    for (let n = words.length; n > 0; n--) {
      const id = words.slice(0, n).join(':');
      if (byId.has(id)) return { id, used: n };
    }
    return { used: 0 };
  };

  const problems = (command: string): string[] => {
    const tokens = command.split(/\s+/).slice(1);
    const words: string[] = [];
    for (const t of tokens) {
      if (isPlaceholder(t)) break;
      words.push(t);
    }
    const { id, used } = resolve(words);
    if (id === undefined) {
      // `vops watch`, `vops keyring` — prose naming a topic, not a command.
      const topic = words.length === 0 || cli.topics.includes(words.join(':'));
      return topic ? [] : [`no such command: vops ${words.join(' ')}`];
    }

    const cmd = byId.get(id);
    const flagFor = (token: string): [string, string, string?] | undefined => {
      const name = token.replace(/^--?/, '').split('=')[0];
      if (token.startsWith('--')) return cmd.flags.find(([n]) => n === name || n === name.replace(/^no-/, ''));
      return cmd.flags.find(([, , char]) => char === name);
    };

    const issues: string[] = [];
    const positionals: string[] = [];
    const rest = tokens.slice(used);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (!token.startsWith('-')) {
        positionals.push(token);
        continue;
      }
      const def = flagFor(token);
      if (!def) issues.push(`unknown flag ${token} on \`vops ${id.replaceAll(':', ' ')}\``);
      else if (def[1] === 'option' && !token.includes('=')) i++;
    }

    const declared = cmd.args.length;
    if (cmd.strict && positionals.length > declared) {
      issues.push(`\`vops ${id.replaceAll(':', ' ')}\` takes ${declared} argument(s), shown with ${positionals.length}: ${positionals.join(' ')}`);
    }
    return issues;
  };

  it.each(cases)('%s › %s', (_doc, command) => {
    expect(problems(command)).toEqual([]);
  });
});
