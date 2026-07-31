import { Finding } from '../src/lib/report';
import { SIGNAL_IDS, SIGNAL_META, signalsOf } from '../src/metrics/signals';

/**
 * The dashboard renders a signal straight from this object — label, unit and all.
 * It used to keep its own copy of the names; when the ids moved server-side the
 * names did not follow, and every metric tile on the page read "undefined". These
 * assertions are the reason that cannot come back silently.
 */
describe('signalsOf', () => {
  const findings: Finding[] = [
    { id: 'sys.cpu', severity: 'ok', summary: 'CPU 4.6% used (all cores)', value: 4.6 },
    { id: 'sys.memory', severity: 'ok', summary: '68% memory available', value: 68 },
    { id: 'sys.disk', severity: 'ok', summary: 'Disk usage healthy', value: 15 },
    { id: 'sys.load', severity: 'warn', summary: 'load1 0.23 on 4 core(s)', value: 0.23 },
    { id: 'sys.io', severity: 'ok', summary: 'Disk I/O: read 0.0 MB/s · write 0.2 MB/s', value: 0.2 },
  ];

  it('gives every signal a label and a unit the UI can print', () => {
    for (const sig of signalsOf(findings)) {
      expect(sig.label).toBeTruthy();
      expect(sig.short).toBeTruthy();
      expect(typeof sig.unit).toBe('string');
      expect(sig.label).toBe(SIGNAL_META[sig.key].label);
    }
  });

  it('describes every key it can emit', () => {
    for (const key of Object.keys(SIGNAL_IDS)) {
      expect(SIGNAL_META[key as keyof typeof SIGNAL_META]).toBeDefined();
    }
  });

  it('carries the check that produced the reading', () => {
    const cpu = signalsOf(findings).find((s) => s.key === 'cpu');
    expect(cpu).toMatchObject({ id: 'sys.cpu', severity: 'ok', value: 4.6, unit: '%' });
    expect(cpu?.summary).toContain('4.6%');
  });

  it('reports memory as used, not available', () => {
    expect(signalsOf(findings).find((s) => s.key === 'mem')?.value).toBe(32);
  });

  it('keeps the core count that makes load comparable', () => {
    expect(signalsOf(findings).find((s) => s.key === 'load')).toMatchObject({ cores: 4, severity: 'warn' });
  });

  it('emits nothing for a signal with no numeric source', () => {
    expect(signalsOf([{ id: 'sys.cpu', severity: 'ok', summary: 'no reading' }])).toEqual([]);
  });
});
