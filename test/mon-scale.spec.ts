import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The monitoring charts are drawn on a fixed scale on purpose. Fitting a series
 * to its own min/max — which the old sparkline did, and which mon-spark.spec
 * still pins for the bench charts — turns a CPU idling between 3% and 5% into a
 * mountain range. These assertions are what stops that from coming back.
 */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'dashboard', 'monitoring-view.js'), 'utf8');

interface View {
  monSigMax(sig: unknown, series: Array<number | null>): number;
  monSparkSegs(series: Array<number | null>, max: number): Array<{ line: string; area: string }>;
  monSparkGaps(series: Array<number | null>): string;
  monSparkEnd(series: Array<number | null>, max: number): { x: number; y: number } | null;
}

const view = new Function(`${SRC}; return dashboardMonitoringView();`)() as View;
const pct = { key: 'cpu', unit: '%', value: 5 };

/** Every y in a points string, so a test can ask where the line actually sits. */
const ys = (points: string): number[] => points.split(' ').map((p) => Number(p.split(',')[1]));

describe('monitoring chart scale', () => {
  it('draws percentages against 0-100, so an idle machine looks idle', () => {
    const idle = [3, 4, 5, 4, 3];
    const [seg] = view.monSparkSegs(idle, view.monSigMax(pct, idle));
    // The viewBox is 40 tall and the baseline is at 38: an idle CPU stays near it.
    expect(Math.min(...ys(seg.line))) .toBeGreaterThan(33);
  });

  it('keeps a busy machine visibly different from an idle one', () => {
    const busy = [90, 92, 95, 93, 91];
    const [seg] = view.monSparkSegs(busy, view.monSigMax(pct, busy));
    expect(Math.max(...ys(seg.line))).toBeLessThan(8);
  });

  it('scales load per core, not per machine', () => {
    expect(view.monSigMax({ key: 'load', unit: '', value: 0.5, cores: 8 }, [0.5])).toBe(8);
    expect(view.monSigMax({ key: 'load', unit: '', value: 0.5 }, [0.5])).toBe(1);
  });

  it('gives an unbounded signal headroom above its peak', () => {
    expect(view.monSigMax({ key: 'io', unit: 'MB/s', value: 2 }, [1, 2, 4])).toBe(5);
  });

  it('never draws through a hole — one segment per contiguous run', () => {
    const segs = view.monSparkSegs([10, 20, null, null, 30, 40], 100);
    expect(segs).toHaveLength(2);
    // x stays on the real time grid: the run after the hole starts where it happened.
    expect(segs[1].line.startsWith('80.0,')).toBe(true);
  });

  it('closes each area on the baseline under its own run', () => {
    const [seg] = view.monSparkSegs([10, 20, 30], 100);
    expect(seg.area.endsWith('100.0,40 0.0,40')).toBe(true);
  });

  it('shades the windows nothing was collected in', () => {
    const rects = view.monSparkGaps([null, null, 5, 5, null]);
    expect(rects.match(/<rect/g)).toHaveLength(2);
    expect(view.monSparkGaps([1, 2, 3])).toBe('');
  });

  it('marks the latest real reading, not the latest bucket', () => {
    expect(view.monSparkEnd([10, 50, null, null], 100)?.x).toBeCloseTo(100 / 3);
    expect(view.monSparkEnd([null, null], 100)).toBeNull();
  });
});
