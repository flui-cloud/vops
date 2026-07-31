import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConversationService } from '../src/remote/conversation.service';
import { RemoteAgentMcpBridge } from '../src/remote/remote-agent-mcp-bridge';
import { RemoteDevice } from '../src/remote/remote-model';

describe('remote agent governance boundaries', () => {
  let root: string;
  let previousConfig: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-agent-governance-'));
    previousConfig = process.env.VOPS_CONFIG_DIR;
    process.env.VOPS_CONFIG_DIR = root;
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exposes semantic tools only on an authenticated ephemeral loopback MCP lease', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: true,
      content: JSON.stringify({ targets: [] }),
    });
    const bridge = new RemoteAgentMcpBridge({
      definitions: () => [{
        name: 'vops_target_list',
        description: 'List targets.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      }],
      execute,
    } as any);
    const lease = await bridge.open({
      requestId: 'request_abcdefghijklmnop',
      sessionToken: 'private-session-token',
      prompt: 'List targets.',
      context: [],
      signal: new AbortController().signal,
      onDelta: () => undefined,
      onStatus: () => undefined,
    });
    try {
      const unauthorized = await fetch(lease.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(unauthorized.status).toBe(401);

      const client = new Client({ name: 'vops-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(lease.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${lease.bearerToken}` },
        },
      });
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'vops_target_list',
      ]);
      const result = await client.callTool({ name: 'vops_target_list', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(execute).toHaveBeenCalledWith(
        'vops_target_list',
        {},
        expect.objectContaining({ sessionToken: 'private-session-token' }),
      );
      await client.close();
    } finally {
      await lease.close();
    }
  });

  it('reports chat cancellation only after the local runtime observes abort', async () => {
    const sent: any[] = [];
    let sequence = 0;
    const router = {
      resolveProvider: jest.fn().mockResolvedValue('codex'),
      run: jest.fn().mockImplementation(
        async (_device, _requestId, turn) =>
          new Promise((_resolve, reject) => {
            turn.signal.addEventListener('abort', () => {
              const error = new Error('cancelled');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          }),
      ),
    };
    const service = new ConversationService(
      {
        saveConversation: jest.fn(),
        listConversationMessages: jest.fn().mockResolvedValue([]),
        nextConversationSequence: jest.fn().mockImplementation(async () => ++sequence),
        saveConversationMessage: jest.fn(),
      } as any,
      {
        send: jest.fn().mockImplementation(async (_device, _channel, payload) => {
          sent.push(payload);
        }),
      } as any,
      router as any,
      {
        create: jest.fn().mockResolvedValue({
          session: { id: 'session_remote' },
          token: 'session-token',
        }),
        authenticate: jest.fn().mockResolvedValue({ id: 'session_remote' }),
      } as any,
      { list: jest.fn().mockReturnValue([]) } as any,
      { appendEvent: jest.fn() } as any,
      {} as any,
    );
    const handling = service.handle(device(), {
      type: 'chat.user_message',
      request_id: 'chat_request_abcdefghijklmnop',
      content: 'Inspect targets.',
      provider: 'codex',
    });
    await until(() => router.run.mock.calls.length === 1);
    expect(sent.some((entry) => entry.type === 'chat.cancelled')).toBe(false);
    await service.cancel(device(), {
      type: 'chat.cancel',
      request_id: 'cancel_request_abcdefghijklmnop',
      target_request_id: 'chat_request_abcdefghijklmnop',
    });
    await handling;
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'chat.cancelled',
      request_id: 'cancel_request_abcdefghijklmnop',
      target_request_id: 'chat_request_abcdefghijklmnop',
      authoritative: true,
    }));
    expect(sent.some((entry) => entry.type === 'chat.failed')).toBe(false);
  });
});

function device(): RemoteDevice {
  return {
    id: 'device_abcdefghijklmnop',
    routeId: 'device_route_abcdefghijklmnop',
    label: 'test device',
    role: 'admin',
    status: 'active',
    signingPublicKey: 'sign',
    exchangePublicKey: 'exchange',
    keyId: 'key_abcdefghijklmnop',
    restrictions: {
      projects: [],
      targets: [],
      environments: ['development', 'staging'],
      maxRisk: 'medium',
      approvalKinds: ['plan'],
      maxProviderSpendEur: 0,
    },
    pairedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Condition was not reached.');
}
