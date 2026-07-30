/** Building a `nextActions` command out of the invocation that produced it.
 *
 * An agent runs a follow-up verbatim, so one that silently drops a flag the caller passed is worse
 * than no follow-up at all: it either fails or succeeds against the wrong target. These
 * helpers exist so a reconstruction reads as "carry this flag through" rather than as a fixed
 * template someone has to remember to update. */

/** A value flag, omitted when it was never given or when it still holds the flag's default. */
export function flagArg(name: string, value?: string, dflt?: string): string[] {
  return value == null || value === dflt ? [] : [`--${name}`, value];
}

/** A boolean flag that defaults to false: emitted only when it is on. */
export function boolArg(name: string, value?: boolean): string[] {
  return value ? [`--${name}`] : [];
}

/** An `allowNo` boolean with no default: `--x`, `--no-x`, or nothing when it was never given. */
export function toggleArg(name: string, value?: boolean): string[] {
  if (value == null) return [];
  return value ? [`--${name}`] : [`--no-${name}`];
}

/** The carried flags as a suffix that disappears entirely when there are none. */
export function carried(...groups: string[][]): string {
  const tokens = groups.flat();
  return tokens.length ? ` ${tokens.join(' ')}` : '';
}
