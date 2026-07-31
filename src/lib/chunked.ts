/**
 * Run `fn` over `items` with at most `size` in flight, preserving input order.
 *
 * `allSettled`, not `all`: one item that throws must not take the rest of its
 * chunk with it. Callers get a `null` in that slot and decide what it means —
 * for a fleet probe, "this host didn't answer" is a result, not a failure of the
 * whole run.
 */
export async function inChunks<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> {
  const out: Array<R | null> = [];
  for (let i = 0; i < items.length; i += size) {
    const settled = await Promise.allSettled(items.slice(i, i + size).map((item, j) => fn(item, i + j)));
    out.push(...settled.map((s) => (s.status === 'fulfilled' ? s.value : null)));
  }
  return out;
}
