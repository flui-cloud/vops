import { NodeSizeDto } from '@flui-cloud/infra';

/** A size's flat hourly rate (min across regions) — the twin-dedup discriminator. */
function sizeHourly(size: NodeSizeDto): number | null {
  const hs = size.prices
    .map((p) => Number.parseFloat(p.priceHourly?.net ?? ''))
    .filter((n) => Number.isFinite(n) && n > 0);
  return hs.length ? Math.min(...hs) : null;
}

/** A size's cheapest monthly — the price kept when collapsing twins. */
function sizeMonthly(size: NodeSizeDto): number {
  const ms = size.prices
    .map((p) => Number.parseFloat(p.priceMonthly?.net ?? ''))
    .filter((n) => Number.isFinite(n) && n > 0);
  return ms.length ? Math.min(...ms) : Number.POSITIVE_INFINITY;
}

const sizeRegions = (size: NodeSizeDto): Set<string> =>
  new Set(size.prices.map((p) => p.location.toLowerCase()));

/** Does `a` serve every region `b` does — so dropping `b` for `a` loses no coverage. */
function sizeCovers(a: NodeSizeDto, b: NodeSizeDto): boolean {
  const set = sizeRegions(a);
  return [...sizeRegions(b)].every((code) => set.has(code));
}

/**
 * Collapse "virtual twins": one machine a provider lists under two SKUs that
 * match on cores/RAM/disk/cpuType/arch AND an identical hourly rate, differing
 * only in the monthly commitment — Cherry's B1 (Gen-1 list) and B2 (Gen-2 promo)
 * "Cloud VPS 1" lines are identical in specs and €/h, so shown side by side the
 * dearer B1 reads as a rip-off. An identical hourly is the signature of "same
 * machine, different billing tier"; a genuinely different product carries a
 * different hourly (Cherry's G1/G2/P1/C1 VDS all do). Within a group keep the
 * cheapest monthly and drop a twin ONLY when the survivor also covers every one
 * of its regions — else both stay, so a promo scoped to fewer regions can never
 * silently drop the list SKU's extra regions. Bare metal is never collapsed: two
 * physical machines at one price are two machines, not billing twins.
 */
export function dedupeVirtualTwins(sizes: NodeSizeDto[]): NodeSizeDto[] {
  const groups = new Map<string, NodeSizeDto[]>();
  const metal: NodeSizeDto[] = [];
  for (const s of sizes) {
    if (s.bareMetal) {
      metal.push(s);
      continue;
    }
    const h = sizeHourly(s);
    const key = `${s.cores}|${s.memory}|${s.disk ?? 0}|${s.cpuType ?? '?'}|${s.architecture ?? '?'}|${h == null ? 'm' : h.toFixed(4)}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(s);
  }
  const kept: NodeSizeDto[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const [best, ...rest] = [...group].sort((a, b) => sizeMonthly(a) - sizeMonthly(b));
    kept.push(best);
    // Keep any twin whose regions the survivor does not fully cover.
    for (const twin of rest) if (!sizeCovers(best, twin)) kept.push(twin);
  }
  return [...metal, ...kept];
}
