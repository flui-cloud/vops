import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cloudPowerFinding, hungGuestFinding, metricFindings } from '../src/host-ops/cloud-plane';
import { CloudClient } from '../src/lib/cloud-client';
import { AgentBadRequest } from '../src/agent-api/agent-http-errors';
import { ExitCode } from '../src/agent-api/agent-envelope';

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

// `fetch failed` gives an agent no way to tell "you never set this up" from "the service is
// down". The two are different exit codes, and the endpoint is named in the second.
describe('CloudClient — a missing relay and a dead relay are different failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-relay-'));

  beforeEach(() => {
    process.env.VOPS_CONFIG_DIR = dir;
    process.env.VOPS_PROFILE = 'relay-test';
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.VOPS_CONFIG_DIR;
    delete process.env.VOPS_PROFILE;
  });

  it('not configured → missing prerequisite (exit 4) naming `vops watch login`', async () => {
    const err = await new CloudClient().listWatches().catch((e) => e);
    expect(err).toBeInstanceOf(AgentBadRequest);
    expect(err.agent.code).toBe('VOPS_RELAY_NOT_CONNECTED');
    expect(err.agent.category).toBe('prerequisite');
    expect(err.exitCode).toBe(ExitCode.MISSING_PREREQUISITE);
    expect(err.agent.suggestedAction).toContain('vops watch login');
  });

  it('configured but unreachable → operational failure (exit 1) naming the endpoint', async () => {
    const client = new CloudClient();
    client.connect('http://127.0.0.1:9');
    const err = await client.listWatches().catch((e) => e);
    expect(err).toBeInstanceOf(AgentBadRequest);
    expect(err.agent.code).toBe('VOPS_RELAY_UNREACHABLE');
    expect(err.exitCode).toBe(ExitCode.FAILURE);
    expect(err.agent.message).toContain('http://127.0.0.1:9');
  });
});
