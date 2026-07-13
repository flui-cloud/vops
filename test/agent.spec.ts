import { agentArchFor } from '../src/agent/agent-manifest';
import { agentFindings } from '../src/agent/vops-agent.service';

describe('agent manifest arch mapping', () => {
  it('maps uname -m to amd64/arm64, null otherwise', () => {
    expect(agentArchFor('x86_64')).toBe('amd64');
    expect(agentArchFor('aarch64')).toBe('arm64');
    expect(agentArchFor('armv7l')).toBeNull();
  });
});

describe('agentFindings', () => {
  it('maps a snapshot to agent.* findings with the right severities', () => {
    const findings = agentFindings({
      cpu: { usagePercent: 95, load1: 4, cores: 2 },
      mem: { usedPercent: 40 },
      disks: [
        { mount: '/', usedPercent: 60 },
        { mount: '/data', usedPercent: 97 },
      ],
    });
    const by = Object.fromEntries(findings.map((f) => [f.id, f]));
    expect(by['agent.cpu'].severity).toBe('warn'); // 95 > 90
    expect(by['agent.mem'].severity).toBe('ok'); // 40% used
    expect(by['agent.disk'].severity).toBe('fail'); // worst mount 97 > 95
    expect(by['agent.disk'].summary).toContain('/data');
  });

  it('omits sections the snapshot did not report', () => {
    expect(agentFindings({})).toHaveLength(0);
  });
});
