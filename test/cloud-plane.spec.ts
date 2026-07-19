import { cloudPowerFinding, hungGuestFinding, metricFindings } from '../src/host-ops/cloud-plane';

describe('cloud plane mappers', () => {
  it('maps provider power state to severities', () => {
    expect(cloudPowerFinding('running').severity).toBe('ok');
    expect(cloudPowerFinding('off').severity).toBe('warn');
    expect(cloudPowerFinding('error').severity).toBe('warn');
    expect(cloudPowerFinding('not-found').severity).toBe('fail');
    expect(cloudPowerFinding('initializing').severity).toBe('info');
    expect(cloudPowerFinding('weird').severity).toBe('info');
  });

  it('flags a hung guest only when SSH is down AND provider says running', () => {
    expect(hungGuestFinding('running')?.severity).toBe('warn');
    expect(hungGuestFinding('off')).toBeNull();
  });

  it('renders metric findings with human bandwidth, and CPU on the per-core scale', () => {
    const findings = metricFindings({
      serverId: '1', at: null,
      cpuPercent: 137, diskIopsRead: null, diskIopsWrite: null,
      diskBandwidthReadBytes: 2048, diskBandwidthWriteBytes: 0,
      netBandwidthInBytes: 1536, netBandwidthOutBytes: 5 * 1024 * 1024,
    });
    const by = Object.fromEntries(findings.map((f) => [f.id, f]));
    // The hypervisor scale is a share of one core (0-400% on a 4-vCPU server), so a
    // value over 100 is normal and must not raise a severity meant for 0-100.
    expect(by['cloud.cpu'].severity).toBe('info');
    expect(by['cloud.cpu'].summary).toContain('share of one core');
    expect(by['cloud.net'].summary).toContain('5M/s');
    expect(by['cloud.disk'].summary).toContain('2K/s');
  });

  it('omits metrics that the provider did not report', () => {
    const findings = metricFindings({
      serverId: '1', at: null, cpuPercent: null,
      diskIopsRead: null, diskIopsWrite: null,
      diskBandwidthReadBytes: null, diskBandwidthWriteBytes: null,
      netBandwidthInBytes: null, netBandwidthOutBytes: null,
    });
    expect(findings).toHaveLength(0);
  });
});
