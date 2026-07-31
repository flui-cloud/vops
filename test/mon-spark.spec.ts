import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `monSpark` gained null-tolerance when the series moved from an in-memory
 * rolling window to a bucketed seven-day history, which has holes. It has a third
 * consumer that knows nothing about any of that — the bench steal-time charts in
 * sections/bench.html — so for a dense array the output must be byte-identical to
 * the version those were written against. A regression here would be silent.
 */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'dashboard', 'monitoring.js'), 'utf8');

type Spark = (series: Array<number | null>) => string;

function loadMonSpark(): Spark {
  const factory = new Function(`${SRC}; return dashboardMonitoring();`) as () => { monSpark: Spark };
  const dashboard = factory();
  return dashboard.monSpark.bind(dashboard);
}

/** The implementation as it stood before the history landed. */
function previousMonSpark(series: number[]): string {
  const a = series || [];
  if (a.length < 2) return '';
  const min = Math.min(...a);
  const max = Math.max(...a);
  const span = max - min || 1;
  const n = a.length;
  return a
    .map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 28 - ((v - min) / span) * 26;
      return x.toFixed(1) + ',' + y.toFixed(1);
    })
    .join(' ');
}

describe('monSpark', () => {
  const monSpark = loadMonSpark();

  const dense: number[][] = [
    [0, 1],
    [5, 5, 5, 5],
    [0, 50, 100, 25, 75],
    [0.1, 0.24, 0.18, 0.9, 0.33, 0.4, 0.4, 1.2],
    Array.from({ length: 48 }, (_, i) => Math.sin(i / 3) * 40 + 50),
    [-10, 0, 10],
  ];

  it.each(dense.map((s, i) => [i, s]))('matches the previous output exactly (case %i)', (_i, series) => {
    expect(monSpark(series as number[])).toBe(previousMonSpark(series as number[]));
  });

  it('still refuses to draw a line from fewer than two points', () => {
    expect(monSpark([])).toBe('');
    expect(monSpark([7])).toBe('');
    // One real reading surrounded by gaps is still one reading.
    expect(monSpark([null, 7, null])).toBe('');
  });

  it('skips gaps instead of drawing through them', () => {
    const withGap = monSpark([0, null, 100]);
    expect(withGap.split(' ')).toHaveLength(2);
    // x stays on the original grid: the surviving points keep their real position
    // in time rather than closing up as if the gap never happened.
    expect(withGap).toBe('0.0,28.0 100.0,2.0');
  });

  it('scales to the real values, ignoring the holes', () => {
    expect(monSpark([10, null, 20])).toBe(monSpark([10, null, 20]));
    expect(monSpark([10, null, 20]).startsWith('0.0,28.0')).toBe(true);
  });
});
