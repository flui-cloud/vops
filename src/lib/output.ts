import chalk from 'chalk';

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c ?? '', widths[i])).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [chalk.bold(line(headers)), chalk.dim(sep), ...rows.map(line)].join(
    '\n',
  );
}

export const yesNo = (v: boolean): string =>
  v ? chalk.green('yes') : chalk.dim('no');

/** Colourise a findings severity for terminal output. */
export function severityBadge(severity: 'ok' | 'info' | 'warn' | 'fail'): string {
  const map = {
    ok: chalk.green('ok  '),
    info: chalk.cyan('info'),
    warn: chalk.yellow('warn'),
    fail: chalk.red('fail'),
  };
  return map[severity] ?? severity;
}

/** Create-column label: deprecated → retired, real create → yes, guided → guide, else no. */
export function createLabel(
  createAllowed: boolean,
  guided: boolean,
  deprecated = false,
): string {
  if (deprecated) return chalk.magenta('deprecated');
  if (createAllowed) return chalk.green('yes');
  if (guided) return chalk.cyan('guide');
  return chalk.dim('no');
}

export const money = (n: number | null, digits = 4): string =>
  n === null ? chalk.dim('n/a') : n.toFixed(digits);

/**
 * Region-availability label mirroring the landing badge: count = coverage of
 * ACTIVE regions, colour = live stock. green all in stock · yellow some sold
 * out · red all sold out · plain when the provider reports no stock signal.
 * Deprecated (retiring) regions are a distinct state, counted separately and
 * appended in magenta — only present when the caller opted into them.
 */
export function regionsLabel(
  regions: Array<{ code: string; up: boolean | null; deprecated?: boolean }>,
): string {
  const active = regions.filter((r) => !r.deprecated);
  const deprecated = regions.filter((r) => r.deprecated).length;
  const n = active.length;
  const signal = active.some((r) => r.up !== null);
  const up = active.filter((r) => r.up === true).length;
  const down = active.filter((r) => r.up === false).length;
  const dep = deprecated ? chalk.magenta(` · ${deprecated} deprecated`) : '';

  let base: string;
  if (n === 0) base = deprecated ? chalk.magenta(`${deprecated} deprecated`) : chalk.dim('-');
  else if (signal && up === 0) base = chalk.red('sold out');
  else if (signal && down > 0) base = chalk.yellow(`${n} region${n === 1 ? '' : 's'} (${down} sold out)`);
  else if (signal) base = chalk.green(`${n} region${n === 1 ? '' : 's'}`);
  else base = `${n} region${n === 1 ? '' : 's'}`;

  return n === 0 ? base : base + dep;
}

const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, '');
const pad = (s: string, w: number): string =>
  s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
