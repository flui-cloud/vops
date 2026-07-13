import { hasCronBlock, removeCronBlock, upsertCronBlock } from '../src/host-ops/crontab';
import {
  MONITOR_CRON_TAG,
  renderMonitorCron,
  renderMonitorEnv,
  renderMonitorScript,
} from '../src/host-ops/monitor-steps';

describe('crontab block transforms', () => {
  const other = '0 3 * * * /usr/bin/backup.sh';
  const body = ['*/5 * * * * /etc/vops/monitor.sh'];

  it('inserts a tagged block, preserving other lines', () => {
    const out = upsertCronBlock(other + '\n', 'monitor', body);
    expect(out).toContain(other);
    expect(out).toContain('# vops:monitor:start');
    expect(out).toContain(body[0]);
    expect(out).toContain('# vops:monitor:end');
    expect(hasCronBlock(out, 'monitor')).toBe(true);
  });

  it('is idempotent — re-applying replaces, never duplicates', () => {
    const once = upsertCronBlock(other + '\n', 'monitor', body);
    const twice = upsertCronBlock(once, 'monitor', ['*/10 * * * * /etc/vops/monitor.sh']);
    expect((twice.match(/# vops:monitor:start/g) || []).length).toBe(1);
    expect(twice).toContain('*/10 * * * *');
    expect(twice).not.toContain('*/5 * * * *');
    expect(twice).toContain(other);
  });

  it('removes exactly the tagged block', () => {
    const withBlock = upsertCronBlock(other + '\n', 'monitor', body);
    const { content, removed } = removeCronBlock(withBlock, 'monitor');
    expect(removed).toBe(true);
    expect(content.trim()).toBe(other);
    expect(hasCronBlock(content, 'monitor')).toBe(false);
  });

  it('reports nothing removed when the block is absent', () => {
    expect(removeCronBlock(other + '\n', 'monitor').removed).toBe(false);
  });
});

describe('monitor renderers', () => {
  it('bakes thresholds into a POSIX-sh collector that always exits 0', () => {
    const sh = renderMonitorScript({ diskWarn: 80, diskCrit: 92, loadCrit: 3.5 });
    expect(sh.startsWith('#!/bin/sh')).toBe(true);
    expect(sh).toContain('-ge 92'); // disk crit
    expect(sh).toContain('-ge 80'); // disk warn
    expect(sh).toContain('> 3.5'); // load crit
    expect(sh).toContain('/api/monitor/ingest');
    expect(sh).toContain('exit 0');
  });

  it('renders the env file with url/host/token', () => {
    const env = renderMonitorEnv('https://relay.example/', 'h-123', 'tok-abc');
    expect(env).toContain("VOPS_MON_URL='https://relay.example'"); // trailing slash stripped
    expect(env).toContain("VOPS_MON_HOST='h-123'");
    expect(env).toContain("VOPS_MON_TOKEN='tok-abc'");
  });

  it('renders a crontab line at the requested interval', () => {
    expect(renderMonitorCron(10)).toEqual(['*/10 * * * * /etc/vops/monitor.sh']);
    expect(MONITOR_CRON_TAG).toBe('monitor');
  });
});
