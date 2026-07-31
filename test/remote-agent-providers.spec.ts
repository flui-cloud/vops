import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AntigravityAdapter } from '../src/remote/antigravity.adapter';
import { ClaudeCodeAdapter } from '../src/remote/claude-code.adapter';
import { CodexAppServerAdapter } from '../src/remote/codex-app-server.adapter';
import { OpenCodeAdapter } from '../src/remote/opencode.adapter';
import { RemoteAgentPolicyStore } from '../src/remote/remote-agent-policy';
import { RemoteAgentRegistry } from '../src/remote/remote-agent-registry';
import { RemoteAgentRouter } from '../src/remote/remote-agent-router';
import { RemoteAgentTurn } from '../src/remote/remote-agent.types';

describe('remote coding-agent providers', () => {
  let root: string;
  let previousConfig: string | undefined;
  let previousWorkspace: string | undefined;
  let previousHome: string | undefined;
  const envKeys = [
    'VOPS_CLAUDE_CODE_BIN',
    'VOPS_OPENCODE_BIN',
    'VOPS_ANTIGRAVITY_BIN',
    'VOPS_CODEX_BIN',
    'VOPS_ANTIGRAVITY_REMOTE_POLICY',
  ];
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-provider-eval-'));
    previousConfig = process.env.VOPS_CONFIG_DIR;
    previousWorkspace = process.env.VOPS_REMOTE_AGENT_WORKSPACE;
    previousHome = process.env.HOME;
    process.env.VOPS_CONFIG_DIR = root;
    process.env.VOPS_REMOTE_AGENT_WORKSPACE = path.join(root, 'workspace');
    process.env.HOME = root;
    for (const key of envKeys) previousEnv.set(key, process.env[key]);
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = previousConfig;
    if (previousWorkspace === undefined) delete process.env.VOPS_REMOTE_AGENT_WORKSPACE;
    else process.env.VOPS_REMOTE_AGENT_WORKSPACE = previousWorkspace;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs Claude Code with strict MCP-only headless arguments', async () => {
    const log = path.join(root, 'claude-args.json');
    process.env.VOPS_CLAUDE_CODE_BIN = fakeBinary('claude', `
      const fs = require('node:fs');
      if (process.argv.includes('--version')) { console.log('2.1.test'); process.exit(0); }
      if (process.argv.includes('auth')) { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
      fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
      process.stdin.resume();
      process.stdin.on('end', () => console.log(JSON.stringify({
        type:'assistant', message:{content:[{type:'text',text:'Claude governed answer.'}]}
      })));
    `);
    const adapter = new ClaudeCodeAdapter(bridge() as any);
    await expect(adapter.status()).resolves.toMatchObject({ state: 'ready', authenticated: true });
    await expect(adapter.run(turn())).resolves.toEqual({
      provider: 'claude-code',
      text: 'Claude governed answer.',
    });
    const args = JSON.parse(fs.readFileSync(log, 'utf8'));
    expect(args).toEqual(expect.arrayContaining([
      '--strict-mcp-config',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
    ]));
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(JSON.stringify(args)).not.toContain('bridge-secret');
  });

  it('runs OpenCode with an inline deny-by-default policy', async () => {
    const log = path.join(root, 'opencode-config.json');
    process.env.VOPS_OPENCODE_BIN = fakeBinary('opencode', `
      const fs = require('node:fs');
      if (process.argv.includes('--version')) { console.log('1.1.test'); process.exit(0); }
      if (process.argv.includes('auth')) { console.log('anthropic configured'); process.exit(0); }
      if (process.argv.includes('debug')) {
        console.log(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(log)}, fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
      process.stdin.resume();
      process.stdin.on('end', () => {
        console.log(JSON.stringify({type:'tool_use',part:{tool:'vops_target_list'}}));
        console.log(JSON.stringify({type:'text',part:{text:'OpenCode governed answer.'}}));
      });
    `);
    const statuses: string[] = [];
    const adapter = new OpenCodeAdapter(bridge() as any);
    const result = await adapter.run(turn({
      onStatus: async (_status, detail) => {
        statuses.push(detail ?? '');
      },
    }));
    expect(result.text).toBe('OpenCode governed answer.');
    expect(statuses).toContain('target list');
    const config = JSON.parse(fs.readFileSync(log, 'utf8'));
    expect(config).toMatchObject({
      share: 'disabled',
      snapshot: false,
      permission: { '*': 'deny', 'vops_*': 'allow' },
      tools: { bash: false, read: false, edit: false, webfetch: false },
    });
    expect(config.mcp.vops.url).toBe('http://127.0.0.1:12345/mcp');
  });

  it('refuses OpenCode when its resolved policy is broader than the contract', async () => {
    process.env.VOPS_OPENCODE_BIN = fakeBinary('opencode-unsafe', `
      if (process.argv.includes('debug')) {
        console.log(JSON.stringify({
          share: 'disabled',
          plugin: [],
          permission: {'*': 'allow', 'vops_*': 'allow'},
          mcp: {vops: {url: 'http://127.0.0.1:12345/mcp'}}
        }));
        process.exit(0);
      }
    `);
    const adapter = new OpenCodeAdapter(bridge() as any);
    await expect(adapter.run(turn())).rejects.toThrow(/broader than the vOps remote contract/);
  });

  it('fails Antigravity closed until its headless policy is explicitly approved', async () => {
    process.env.VOPS_ANTIGRAVITY_BIN = fakeBinary('agy', `
      if (process.argv.includes('--version')) { console.log('1.1.4'); process.exit(0); }
      if (process.argv.includes('--help')) { console.log('usage: agy -p, --print'); process.exit(0); }
      process.stdin.resume();
      process.stdin.on('end', () => console.log('Antigravity governed answer.'));
    `);
    const adapter = new AntigravityAdapter(bridge() as any);
    await expect(adapter.status()).resolves.toMatchObject({ state: 'not_headless_capable' });
    await expect(adapter.run(turn())).rejects.toThrow(/not explicitly approved/);
    process.env.VOPS_ANTIGRAVITY_REMOTE_POLICY = 'approved';
    const settings = path.join(root, '.gemini', 'antigravity-cli');
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({
      permissions: {
        deny: [
          'read_file(*)',
          'write_file(*)',
          'read_url(*)',
          'execute_url(*)',
          'command(*)',
          'unsandboxed(*)',
        ],
        allow: ['mcp(vops/*)'],
      },
    }));
    await expect(adapter.status()).resolves.toMatchObject({ state: 'ready' });
    await expect(adapter.run(turn())).resolves.toMatchObject({
      provider: 'antigravity',
      text: 'Antigravity governed answer.',
    });
  });

  it('drives Codex app-server with dynamic tools and supports a bounded turn', async () => {
    process.env.VOPS_CODEX_BIN = fakeBinary('codex', `
      if (process.argv.includes('--version')) { console.log('codex-cli test'); process.exit(0); }
      if (process.argv.includes('login')) { console.log('Logged in using test'); process.exit(0); }
      const readline = require('node:readline');
      const rl = readline.createInterface({input:process.stdin});
      rl.on('line', (line) => {
        const row = JSON.parse(line);
        if (row.method === 'initialized') return;
        if (row.method === 'initialize') {
          console.log(JSON.stringify({id:row.id,result:{}}));
          return;
        }
        if (row.method === 'thread/start') {
          console.log(JSON.stringify({id:row.id,result:{thread:{id:'thread_test'}}}));
          return;
        }
        if (row.method === 'turn/start') {
          console.log(JSON.stringify({id:row.id,result:{turn:{id:'turn_test'}}}));
          if (!row.params.input[0].text.includes('wait for cancellation')) {
            setTimeout(() => {
              console.log(JSON.stringify({method:'item/agentMessage/delta',params:{
                threadId:'thread_test',itemId:'item_test',delta:'Codex governed answer.'
              }}));
              console.log(JSON.stringify({method:'turn/completed',params:{
                threadId:'thread_test',turn:{status:'completed'}
              }}));
            }, 10);
          }
          return;
        }
        if (row.method === 'turn/interrupt') {
          console.log(JSON.stringify({id:row.id,result:{}}));
          console.log(JSON.stringify({method:'turn/completed',params:{
            threadId:'thread_test',turn:{status:'interrupted'}
          }}));
        }
      });
    `);
    const adapter = new CodexAppServerAdapter({
      definitions: () => [],
      execute: jest.fn(),
    } as any);
    await expect(adapter.status()).resolves.toMatchObject({ state: 'ready', authenticated: true });
    await expect(adapter.run(turn())).resolves.toEqual({
      provider: 'codex',
      text: 'Codex governed answer.',
    });
    const controller = new AbortController();
    const cancelled = adapter.run(turn({
      prompt: 'wait for cancellation',
      signal: controller.signal,
    }));
    setTimeout(() => controller.abort(), 30);
    await expect(cancelled).rejects.toThrow(/interrupted|cancelled/i);
    await adapter.onModuleDestroy();
  });

  it('routes only through explicitly approved fallbacks', async () => {
    const policy = new RemoteAgentPolicyStore();
    const codex = adapter('codex', 'unavailable', true);
    const claude = adapter('claude-code', 'ready');
    const registry = new RemoteAgentRegistry(
      codex as any,
      claude as any,
      adapter('opencode', 'not_installed') as any,
      adapter('antigravity', 'not_installed') as any,
      adapter('openai-compatible', 'unavailable') as any,
      policy,
    );
    const snapshot = {
      targets: [],
      applications: [],
      operations: [],
      approvals: [],
    };
    const router = new RemoteAgentRouter(registry, {
      snapshot: jest.fn().mockResolvedValue(snapshot),
    } as any);
    await expect(router.run({} as any, 'request', turn())).resolves.toMatchObject({
      provider: 'deterministic',
    });
    expect(claude.run).not.toHaveBeenCalled();

    policy.setFallbackOrder(['claude-code']);
    await expect(router.run({} as any, 'request', turn())).resolves.toEqual({
      provider: 'claude-code',
      text: 'claude-code answer',
    });
    expect(claude.run).toHaveBeenCalledTimes(1);
  });
});

function turn(overrides: Partial<RemoteAgentTurn> = {}): RemoteAgentTurn {
  return {
    requestId: 'request_abcdefghijklmnop',
    sessionToken: 'session-token',
    prompt: 'Inspect vOps.',
    context: [],
    signal: new AbortController().signal,
    onDelta: async () => undefined,
    onStatus: async () => undefined,
    ...overrides,
  };
}

function bridge() {
  return {
    open: jest.fn().mockResolvedValue({
      url: 'http://127.0.0.1:12345/mcp',
      bearerToken: 'bridge-secret',
      close: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

function adapter(id: string, state: string, fail = false) {
  return {
    id,
    status: jest.fn().mockResolvedValue({
      id,
      displayName: id,
      kind: id === 'openai-compatible' ? 'openai-compatible' : 'coding-agent',
      state,
      installed: state !== 'not_installed',
      authenticated: state === 'ready',
      headless: state === 'ready',
      capabilities: {},
    }),
    run: jest.fn().mockImplementation(async () => {
      if (fail) throw new Error(`${id} failed`);
      return { provider: id, text: `${id} answer` };
    }),
  };
}

function fakeBinary(name: string, body: string): string {
  const file = path.join(process.env.VOPS_CONFIG_DIR!, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  return file;
}
