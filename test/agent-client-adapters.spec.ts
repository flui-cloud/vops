import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentClientAdapters, SupportedAgentClient } from '../src/agent-clients/client-adapters';

describe('agent client adapters', () => {
  let project: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-client-'));
  });

  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it.each([
    ['codex', '.codex/config.toml'],
    ['claude-code', '.mcp.json'],
    ['opencode', 'opencode.json'],
    ['antigravity', '.agents/mcp_config.json'],
  ] as Array<[SupportedAgentClient, string]>)(
    'installs and validates %s project integration',
    (client, config) => {
      const adapters = new AgentClientAdapters();
      const installed = adapters.install(client, 'project', project);
      expect(fs.existsSync(path.join(project, config))).toBe(true);
      expect(adapters.status(client, 'project', project).installed).toBe(true);
      const second = adapters.install(client, 'project', project);
      expect(second.changed).toEqual([]);
    },
  );

  it('preserves unrelated JSON config and removes only managed entries', () => {
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
      custom: { keep: true },
      mcpServers: { other: { command: 'other' } },
    }));
    const adapters = new AgentClientAdapters();
    adapters.install('claude-code', 'project', project);
    const merged = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'));
    expect(merged.custom.keep).toBe(true);
    expect(merged.mcpServers.other.command).toBe('other');
    expect(merged.mcpServers.vops.command).toBe('vops');
    adapters.uninstall('claude-code', 'project', project);
    const after = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'));
    expect(after.custom.keep).toBe(true);
    expect(after.mcpServers.other.command).toBe('other');
    expect(after.mcpServers.vops).toBeUndefined();
  });

  it('refuses to overwrite an unmanaged skill', () => {
    const dir = path.join(project, '.agents/skills/vops-deploy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'user content');
    expect(() => new AgentClientAdapters().install('codex', 'project', project)).toThrow(/unmanaged skill/);
  });

  it('merges OpenCode JSONC without losing unrelated settings', () => {
    fs.writeFileSync(path.join(project, 'opencode.json'), `{
      // user-selected model
      model: 'example/model',
      theme: 'dark',
    }\n`);
    const adapters = new AgentClientAdapters();
    adapters.install('opencode', 'project', project);
    const merged = JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf8'));
    expect(merged).toMatchObject({ model: 'example/model', theme: 'dark' });
    expect(merged.mcp.servers.vops.type).toBe('local');
    expect(fs.existsSync(path.join(project, 'opencode.json.vops-backup'))).toBe(true);
  });
});
