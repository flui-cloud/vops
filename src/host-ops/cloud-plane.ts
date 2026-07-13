import { ServerMetricsDto } from '@flui-cloud/infra';
import { Finding, Severity } from '../lib/report';

/**
 * Pure mappers for the provider/hypervisor plane of `host status` — the cheapest
 * rung of the agentless ladder (no SSH, no key, no install: just the provider
 * token). It sees the machine from OUTSIDE: power state (all providers) and, where
 * exposed, resource metrics (Hetzner). It cannot see inside the guest — disk-full,
 * OOM, failed units — so it complements the SSH battery, never replaces it.
 */
const POWER_SEVERITY: Record<string, Severity> = {
  running: 'ok',
  starting: 'info',
  initializing: 'info',
  migrating: 'info',
  rebuilding: 'info',
  off: 'warn',
  stopping: 'warn',
  deleting: 'fail',
  'not-found': 'fail',
  // Provider-plane uncertainty (API error / missing token), not a confirmed server fault.
  error: 'warn',
};

export function cloudPowerFinding(status: string): Finding {
  const sev = POWER_SEVERITY[status.toLowerCase()] ?? 'info';
  return { id: 'cloud.power', severity: sev, summary: `Provider power state: ${status}`, value: status };
}

/**
 * SSH is down but the hypervisor reports the VM running → the guest is likely hung
 * (kernel panic, OOM storm, disk full) rather than simply powered off. This is the
 * cross-plane signal the two planes together unlock.
 */
export function hungGuestFinding(powerStatus: string): Finding | null {
  return powerStatus.toLowerCase() === 'running'
    ? { id: 'cloud.hung', severity: 'warn', summary: 'SSH unreachable but provider reports running — possible hung guest' }
    : null;
}

export function metricFindings(m: ServerMetricsDto): Finding[] {
  const out: Finding[] = [];
  if (m.cpuPercent !== null) {
    const sev: Severity = m.cpuPercent > 90 ? 'warn' : 'ok';
    out.push({ id: 'cloud.cpu', severity: sev, summary: `Hypervisor CPU ${m.cpuPercent}%`, value: m.cpuPercent });
  }
  if (m.netBandwidthInBytes !== null || m.netBandwidthOutBytes !== null) {
    out.push({
      id: 'cloud.net',
      severity: 'info',
      summary: `Net ↓${bytesPerSec(m.netBandwidthInBytes)} ↑${bytesPerSec(m.netBandwidthOutBytes)}`,
    });
  }
  if (m.diskBandwidthReadBytes !== null || m.diskBandwidthWriteBytes !== null) {
    out.push({
      id: 'cloud.disk',
      severity: 'info',
      summary: `Disk r${bytesPerSec(m.diskBandwidthReadBytes)} w${bytesPerSec(m.diskBandwidthWriteBytes)}`,
    });
  }
  return out;
}

function bytesPerSec(n: number | null): string {
  if (n === null) return 'n/a';
  const units = ['B', 'K', 'M', 'G'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const shown = Number.isInteger(v) || v >= 10 ? String(Math.round(v)) : v.toFixed(1);
  return `${shown}${units[i]}/s`;
}
