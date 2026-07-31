import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSON5 from 'json5';
import { AgentClient } from '../agent-control/agent-model';
import { bootstrapFile, canonicalSkillDir } from '../agent-kit/agent-kit-paths';

export type SupportedAgentClient = Exclude<AgentClient, 'other'>;
export type ClientInstallScope = 'project' | 'user';

export interface AgentClientInstallation {
  client: SupportedAgentClient;
  scope: ClientInstallScope;
  root: string;
  skillDir: string;
  configFile: string;
  bootstrapFile: string;
  changed: string[];
  backups: string[];
}

export interface AgentClientStatus {
  client: SupportedAgentClient;
  detected: boolean;
  installed: boolean;
  skill: boolean;
  mcp: boolean;
  bootstrap: boolean;
  paths: { skillDir: string; configFile: string; bootstrapFile: string };
  issues: string[];
}

interface ClientPaths {
  root: string;
  skillDir: string;
  configFile: string;
  bootstrapFile: string;
}

const CLIENTS: SupportedAgentClient[] = ['codex', 'claude-code', 'opencode', 'antigravity'];
const MANAGED_START = '<!-- vops:managed:start -->';
const MANAGED_END = '<!-- vops:managed:end -->';
const TOML_START = '# vops:managed:start';
const TOML_END = '# vops:managed:end';

export class AgentClientAdapters {
  clients(): SupportedAgentClient[] {
    return [...CLIENTS];
  }

  detect(project = process.cwd()): AgentClientStatus[] {
    return CLIENTS.map((client) => this.status(client, 'project', project));
  }

  install(client: SupportedAgentClient, scope: ClientInstallScope, project = process.cwd()): AgentClientInstallation {
    assertClient(client);
    const paths = clientPaths(client, scope, project);
    const changed: string[] = [];
    const backups: string[] = [];

    if (copySkill(paths.skillDir)) changed.push(paths.skillDir);
    const config = installMcp(client, paths.configFile, backups);
    if (config) changed.push(paths.configFile);
    const bootstrap = installBootstrap(paths.bootstrapFile, backups);
    if (bootstrap) changed.push(paths.bootstrapFile);

    return { client, scope, ...paths, changed, backups };
  }

  uninstall(client: SupportedAgentClient, scope: ClientInstallScope, project = process.cwd()): AgentClientInstallation {
    assertClient(client);
    const paths = clientPaths(client, scope, project);
    const changed: string[] = [];
    const backups: string[] = [];
    const marker = path.join(paths.skillDir, '.vops-managed.json');
    if (fs.existsSync(marker)) {
      fs.rmSync(paths.skillDir, { recursive: true, force: true });
      changed.push(paths.skillDir);
    }
    if (uninstallMcp(client, paths.configFile, backups)) changed.push(paths.configFile);
    if (removeManagedBlock(paths.bootstrapFile, MANAGED_START, MANAGED_END, backups)) {
      changed.push(paths.bootstrapFile);
    }
    return { client, scope, ...paths, changed, backups };
  }

  status(client: SupportedAgentClient, scope: ClientInstallScope, project = process.cwd()): AgentClientStatus {
    assertClient(client);
    const paths = clientPaths(client, scope, project);
    const skill = fs.existsSync(path.join(paths.skillDir, 'SKILL.md'));
    const bootstrap = fileHas(paths.bootstrapFile, MANAGED_START);
    let mcp = false;
    const issues: string[] = [];
    try {
      mcp = hasMcp(client, paths.configFile);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    return {
      client,
      // Probe the root this scope actually reads: `~` for user scope, the repository
      // for project scope. Probing the project root for both reported every user-wide
      // install as undetected, because `.codex`/`.claude`/`.gemini` live in $HOME.
      detected: detectClient(client, paths.root),
      installed: skill && mcp && bootstrap,
      skill,
      mcp,
      bootstrap,
      paths: {
        skillDir: paths.skillDir,
        configFile: paths.configFile,
        bootstrapFile: paths.bootstrapFile,
      },
      issues,
    };
  }
}

function clientPaths(client: SupportedAgentClient, scope: ClientInstallScope, project: string): ClientPaths {
  const root = scope === 'project' ? fs.realpathSync(path.resolve(project)) : os.homedir();
  const definitions: Record<SupportedAgentClient, Record<ClientInstallScope, Omit<ClientPaths, 'root'>>> = {
    codex: {
      project: {
        skillDir: path.join(root, '.agents/skills/vops-deploy'),
        configFile: path.join(root, '.codex/config.toml'),
        bootstrapFile: path.join(root, 'AGENTS.md'),
      },
      user: {
        skillDir: path.join(root, '.agents/skills/vops-deploy'),
        configFile: path.join(root, '.codex/config.toml'),
        bootstrapFile: path.join(root, '.codex/AGENTS.md'),
      },
    },
    'claude-code': {
      project: {
        skillDir: path.join(root, '.claude/skills/vops-deploy'),
        configFile: path.join(root, '.mcp.json'),
        bootstrapFile: path.join(root, 'CLAUDE.md'),
      },
      user: {
        skillDir: path.join(root, '.claude/skills/vops-deploy'),
        configFile: path.join(root, '.claude.json'),
        bootstrapFile: path.join(root, '.claude/CLAUDE.md'),
      },
    },
    opencode: {
      project: {
        skillDir: path.join(root, '.opencode/skills/vops-deploy'),
        configFile: path.join(root, 'opencode.json'),
        bootstrapFile: path.join(root, 'AGENTS.md'),
      },
      user: {
        skillDir: path.join(root, '.config/opencode/skills/vops-deploy'),
        configFile: path.join(root, '.config/opencode/opencode.json'),
        bootstrapFile: path.join(root, '.config/opencode/AGENTS.md'),
      },
    },
    antigravity: {
      project: {
        skillDir: path.join(root, '.agents/skills/vops-deploy'),
        configFile: path.join(root, '.agents/mcp_config.json'),
        bootstrapFile: path.join(root, 'GEMINI.md'),
      },
      user: {
        skillDir: path.join(root, '.gemini/config/skills/vops-deploy'),
        configFile: path.join(root, '.gemini/config/mcp_config.json'),
        bootstrapFile: path.join(root, '.gemini/GEMINI.md'),
      },
    },
  };
  return { root, ...definitions[client][scope] };
}

function copySkill(destination: string): boolean {
  const marker = path.join(destination, '.vops-managed.json');
  if (fs.existsSync(destination) && !fs.existsSync(marker)) {
    throw new Error(`Refusing to replace unmanaged skill at ${destination}.`);
  }
  if (fs.existsSync(marker) && treesEqual(canonicalSkillDir(), destination)) return false;
  const staging = `${destination}.vops-staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(canonicalSkillDir(), staging, { recursive: true });
  fs.writeFileSync(path.join(staging, '.vops-managed.json'), '{"managedBy":"vops","version":1}\n', { mode: 0o600 });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(staging, destination);
  return true;
}

function treesEqual(source: string, destination: string): boolean {
  const sourceFiles = relativeFiles(source);
  const destinationFiles = relativeFiles(destination).filter((file) => file !== '.vops-managed.json');
  if (sourceFiles.join('\n') !== destinationFiles.join('\n')) return false;
  return sourceFiles.every((file) =>
    fs.readFileSync(path.join(source, file)).equals(fs.readFileSync(path.join(destination, file))),
  );
}

function relativeFiles(root: string, prefix = ''): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? relativeFiles(path.join(root, entry.name), relative) : [relative];
  }).sort();
}

function installMcp(client: SupportedAgentClient, file: string, backups: string[]): boolean {
  if (client === 'codex') {
    return replaceManagedBlock(
      file,
      TOML_START,
      TOML_END,
      `${TOML_START}\n[mcp_servers.vops]\ncommand = "vops"\nargs = ["mcp", "serve", "--transport", "stdio"]\n${TOML_END}`,
      backups,
    );
  }
  const config = readJsonConfig(file);
  if (client === 'opencode') {
    const mcp = objectValue(config.mcp);
    const servers = objectValue(mcp.servers);
    servers.vops = { type: 'local', command: ['vops', 'mcp', 'serve', '--transport', 'stdio'], enabled: true };
    mcp.servers = servers;
    config.mcp = mcp;
  } else {
    const servers = objectValue(config.mcpServers);
    servers.vops = { command: 'vops', args: ['mcp', 'serve', '--transport', 'stdio'] };
    config.mcpServers = servers;
  }
  return writeJsonIfChanged(file, config, backups);
}

function uninstallMcp(client: SupportedAgentClient, file: string, backups: string[]): boolean {
  if (client === 'codex') return removeManagedBlock(file, TOML_START, TOML_END, backups);
  if (!fs.existsSync(file)) return false;
  const config = readJsonConfig(file);
  const parent = client === 'opencode' ? objectValue(config.mcp) : config;
  const key = client === 'opencode' ? 'servers' : 'mcpServers';
  const servers = objectValue(parent[key]);
  if (!hasOwn(servers, 'vops')) return false;
  delete servers.vops;
  parent[key] = servers;
  if (client === 'opencode') config.mcp = parent;
  // A config whose only content was the vOps entry was created by this installer.
  // Leaving `{"mcpServers":{}}` behind is litter, not preserved user configuration.
  if (isEmptyMcpConfig(config, key)) {
    backup(file, backups);
    fs.rmSync(file, { force: true });
    return true;
  }
  return writeJsonIfChanged(file, config, backups);
}

function isEmptyMcpConfig(config: Record<string, unknown>, key: string): boolean {
  const entries = Object.entries(config).filter(([name]) => name !== key && name !== 'mcp');
  if (entries.length) return false;
  const nested = objectValue(config[key] ?? objectValue(config.mcp)[key]);
  return Object.keys(nested).length === 0;
}

function hasMcp(client: SupportedAgentClient, file: string): boolean {
  if (!fs.existsSync(file)) return false;
  if (client === 'codex') return fileHas(file, TOML_START) && fileHas(file, '[mcp_servers.vops]');
  const config = readJsonConfig(file);
  return client === 'opencode'
    ? hasOwn(objectValue(objectValue(config.mcp).servers), 'vops')
    : hasOwn(objectValue(config.mcpServers), 'vops');
}

function installBootstrap(file: string, backups: string[]): boolean {
  const block = fs.readFileSync(bootstrapFile(), 'utf8').trim();
  return replaceManagedBlock(file, MANAGED_START, MANAGED_END, block, backups);
}

function replaceManagedBlock(
  file: string,
  start: string,
  end: string,
  replacement: string,
  backups: string[],
): boolean {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const pattern = managedPattern(start, end);
  const updated = pattern.test(before)
    ? before.replace(pattern, replacement)
    : `${before.trimEnd()}${before.trim() ? '\n\n' : ''}${replacement}\n`;
  const after = updated.trimEnd() ? `${updated.trimEnd()}\n` : '';
  return writeTextIfChanged(file, after, backups);
}

function removeManagedBlock(file: string, start: string, end: string, backups: string[]): boolean {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(managedPattern(start, end), '').replace(/\n{3,}/g, '\n\n').trimEnd();
  return writeTextIfChanged(file, after ? `${after}\n` : '', backups);
}

function managedPattern(start: string, end: string): RegExp {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'm');
}

function writeTextIfChanged(file: string, content: string, backups: string[]): boolean {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  if (before === content) return false;
  backup(file, backups);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.vops-staging-${process.pid}`;
  fs.writeFileSync(staging, content, { mode: 0o600 });
  fs.renameSync(staging, file);
  return true;
}

function readJsonConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON5.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`Cannot safely merge invalid JSON/JSONC config ${file}.`);
  }
}

function writeJsonIfChanged(file: string, value: Record<string, unknown>, backups: string[]): boolean {
  return writeTextIfChanged(file, `${JSON.stringify(value, null, 2)}\n`, backups);
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function backup(file: string, backups: string[]): void {
  if (!fs.existsSync(file)) return;
  const destination = `${file}.vops-backup`;
  fs.copyFileSync(file, destination);
  backups.push(destination);
}

function fileHas(file: string, value: string): boolean {
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(value);
}

function detectClient(client: SupportedAgentClient, project: string): boolean {
  const names: Record<SupportedAgentClient, string[]> = {
    codex: ['.codex', '.agents'],
    'claude-code': ['.claude', 'CLAUDE.md'],
    opencode: ['.opencode', 'opencode.json'],
    antigravity: ['.gemini', 'GEMINI.md'],
  };
  return names[client].some((name) => fs.existsSync(path.join(project, name)));
}

function assertClient(client: string): asserts client is SupportedAgentClient {
  if (!CLIENTS.includes(client as SupportedAgentClient)) {
    throw new Error(`Unsupported agent client '${client}'.`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
