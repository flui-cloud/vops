import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  authorizeRole,
  validateCommandTime,
  validateSignedCommandShape,
} from '../src/remote/remote-command.handler';
import { validateEnvelope } from '../src/remote/remote-gateway';
import { RemoteStore } from '../src/remote/remote-store';
import {
  RemoteDevice,
} from '../src/remote/remote-model';
import {
  SignedRemoteCommandPayload,
  SignedRemoteCommandV1,
} from '../src/remote/remote-message.types';
import { RemoteEnvelopeV1 } from '../src/remote/remote-transport.types';
import { AgentStore } from '../src/agent-control/agent-store';
import { AgentSafetyState } from '../src/agent-control/agent-safety-state';
import { CapabilityRegistry } from '../src/agent-control/capability-registry';
import { IntentService } from '../src/remote/intent.service';
import { OpenAICompatibleAgentAdapter } from '../src/remote/openai-compatible-agent.adapter';
import { OpenAICompatibleConfigStore } from '../src/remote/openai-compatible-config';
import { RemoteAgentToolsService } from '../src/remote/remote-agent-tools.service';

describe('remote-control protocol security', () => {
  let configDir: string;
  let previous: string | undefined;
  let store: RemoteStore;
  let agentStore: AgentStore;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-remote-security-'));
    previous = process.env.VOPS_CONFIG_DIR;
    process.env.VOPS_CONFIG_DIR = configDir;
    store = new RemoteStore();
    agentStore = new AgentStore();
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await agentStore.onModuleDestroy();
    if (previous === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = previous;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('bounds envelope lifetime, sequence, size, and protocol', () => {
    const valid = envelope();
    expect(() => validateEnvelope(valid)).not.toThrow();
    expect(() => validateEnvelope({ ...valid, sequence: 0 })).toThrow(/sequence/);
    expect(() => validateEnvelope({
      ...valid,
      expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
    })).toThrow(/lifetime/);
    expect(() => validateEnvelope({ ...valid, ciphertext: 'x'.repeat(512_001) })).toThrow(/length/);
  });

  it('deduplicates command IDs and nonces independently', async () => {
    expect(await store.rememberCommand('cmd_a', 'device_a', 'nonce_a', { state: 'received' })).toBe(true);
    expect(await store.rememberCommand('cmd_a', 'device_a', 'nonce_b', { state: 'received' })).toBe(false);
    expect(await store.rememberCommand('cmd_b', 'device_a', 'nonce_a', { state: 'received' })).toBe(false);
    await store.saveCommandResult('cmd_a', { state: 'executed' });
    expect(await store.getCommand('cmd_a')).toEqual({ state: 'executed' });
  });

  it('allows relay reordering but rejects a repeated message id', async () => {
    expect(await store.acceptInboundMessage('device_a', 'msg_high', 2, future())).toBe(true);
    expect(await store.acceptInboundMessage('device_a', 'msg_low', 1, future())).toBe(true);
    expect(await store.acceptInboundMessage('device_a', 'msg_low', 1, future())).toBe(false);
  });

  it('rejects expired, long-lived, malformed, or viewer-signed commands', () => {
    const payload = commandPayload();
    const signed: SignedRemoteCommandV1 = {
      payload,
      key_id: `key_${'a'.repeat(18)}`,
      signature: 'a'.repeat(86),
    };
    expect(() => validateSignedCommandShape(signed)).not.toThrow();
    expect(() => validateCommandTime(payload)).not.toThrow();
    expect(() => validateCommandTime({
      ...payload,
      issued_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      expires_at: new Date(Date.now() - 9 * 60_000).toISOString(),
    })).toThrow(/expired/);
    expect(() => authorizeRole(device('viewer'), payload)).toThrow(/Viewer/);
    expect(() => authorizeRole(device('approver'), {
      ...payload,
      type: 'agents.stop_all_request',
    })).toThrow(/admin/);
    expect(() => authorizeRole(device('admin'), {
      ...payload,
      type: 'agents.stop_all_request',
    })).not.toThrow();
  });

  it('persists the emergency-stop latch across service restarts', async () => {
    const first = new AgentSafetyState(agentStore);
    await first.onModuleInit();
    expect(first.current().active).toBe(false);
    await first.activate('remote_device:test', 'security test');
    const second = new AgentSafetyState(agentStore);
    await second.onModuleInit();
    expect(second.current()).toMatchObject({
      active: true,
      activatedBy: 'remote_device:test',
    });
    await second.clear('local_user', 'test cleanup');
    expect(second.current().active).toBe(false);
  });

  it('executes an approved availability intent deterministically without an agent turn', async () => {
    const sessions = {
      create: jest.fn().mockResolvedValue({
        session: { id: 'ses_intent' },
        token: 'intent-token',
      }),
      extendForConditionalIntent: jest.fn().mockResolvedValue({ id: 'ses_intent' }),
      revoke: jest.fn(),
    };
    const plan = {
      id: 'plan_intent',
      hash: 'a'.repeat(64),
    };
    const broker = {
      createPlan: jest.fn().mockResolvedValue({
        plan,
        approval: { id: 'apr_intent' },
      }),
      executePlan: jest.fn().mockResolvedValue({
        id: 'op_intent',
        state: 'succeeded',
      }),
    };
    const approvals = { approve: jest.fn().mockResolvedValue({ status: 'approved' }) };
    const catalog = {
      availability: jest.fn().mockResolvedValue({
        plans: [{ id: 'cx-test', name: 'cx-test', everywhere: true, locations: [] }],
      }),
    };
    const intents = new IntentService(
      store,
      sessions as any,
      new CapabilityRegistry(),
      broker as any,
      approvals as any,
      catalog as any,
      { send: jest.fn() } as any,
      agentStore,
    );
    const created = await intents.create(
      {
        ...device('admin'),
        restrictions: {
          ...device('admin').restrictions,
          maxRisk: 'high',
          maxProviderSpendEur: 10,
        },
      },
      {
        id: 'intent_abcdefghijklmnop',
        objective: 'Restart demo once cx-test is available.',
        trigger: {
          type: 'catalog.availability',
          provider: 'hetzner',
          serverType: 'cx-test',
        },
        action: {
          capability: 'application.restart',
          input: { name: 'demo' },
          environment: 'staging',
        },
        constraints: {
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          maxExecutions: 1,
          maxSpendEur: 0,
          failureBehavior: 'stop',
        },
      },
    );
    expect(created.status).toBe('active');
    expect(approvals.approve).toHaveBeenCalledWith(
      'apr_intent',
      expect.stringContaining('Pre-authorized'),
      expect.stringContaining('remote_device:'),
    );
    await intents.tick();
    expect(broker.executePlan).toHaveBeenCalledWith('intent-token', 'plan_intent');
    expect(await store.getIntent(created.id)).toMatchObject({
      status: 'succeeded',
      executionCount: 1,
      operationId: 'op_intent',
    });
  });

  it('uses a bounded OpenAI-compatible tool loop and rejects malformed tool arguments', async () => {
    let malformed = false;
    const requests: Array<{ authorization?: string; body: any }> = [];
    const server = http.createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"data":[{"id":"local-test"}]}');
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({
          authorization:
            typeof request.headers.authorization === 'string'
              ? request.headers.authorization
              : undefined,
          body,
        });
        const toolResult = body.messages.at(-1)?.role === 'tool';
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const probe = body.tools?.[0]?.function?.name === 'vops_probe';
        if (!toolResult) {
          const argumentsText = body.messages.at(-1)?.content.includes('malformed')
            ? '{bad'
            : '{}';
          response.write(sse({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_1',
                  function: {
                    name: probe ? 'vops_probe' : 'vops_target_list',
                    arguments: argumentsText,
                  },
                }],
              },
            }],
          }));
        } else {
          malformed = String(body.messages.at(-1)?.content).includes('Malformed tool arguments');
          response.write(sse({
            choices: [{
              delta: {
                content: malformed ? 'Malformed arguments were rejected.' : 'There are no targets.',
              },
            }],
          }));
        }
        response.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      new OpenAICompatibleConfigStore().save({
        displayName: 'Mock local provider',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'local-test',
        apiKey: 'local-secret',
        supportsToolCalls: true,
      });
      const broker = {
        invoke: jest.fn().mockResolvedValue({
          operation: { result: [] },
        }),
      };
      const adapter = new OpenAICompatibleAgentAdapter(
        new RemoteAgentToolsService(new CapabilityRegistry(), broker as any),
      );
      await expect(adapter.test()).resolves.toMatchObject({
        ok: true,
        model: 'local-test',
        structuredToolCallsDetected: true,
      });
      const deltas: string[] = [];
      const result = await adapter.run({
        requestId: 'request_openai_1',
        sessionToken: 'session-token',
        prompt: 'List targets.',
        context: [],
        signal: new AbortController().signal,
        onStatus: async () => undefined,
        onDelta: async (delta) => {
          deltas.push(delta);
        },
      });
      expect(result).toMatchObject({
        provider: 'openai-compatible',
        text: 'There are no targets.',
      });
      expect(broker.invoke).toHaveBeenCalledWith(
        'session-token',
        'target.list',
        {},
        expect.any(Object),
      );

      broker.invoke.mockClear();
      const rejected = await adapter.run({
        requestId: 'request_openai_2',
        sessionToken: 'session-token',
        prompt: 'Try malformed tool arguments.',
        context: [],
        signal: new AbortController().signal,
        onStatus: async () => undefined,
        onDelta: async (delta) => {
          deltas.push(delta);
        },
      });
      expect(rejected.text).toBe('Malformed arguments were rejected.');
      expect(malformed).toBe(true);
      expect(broker.invoke).not.toHaveBeenCalled();
      expect(requests.every((entry) => entry.authorization === 'Bearer local-secret')).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

function envelope(): RemoteEnvelopeV1 {
  const now = new Date();
  return {
    protocol_version: 1,
    message_id: 'msg_abcdefghijklmnop',
    sender_id: 'device_abcdefghijklmnop',
    recipient_id: 'node_abcdefghijklmnop',
    channel: 'remote_command',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 2 * 60_000).toISOString(),
    key_id: 'key_abcdefghijklmnop',
    sequence: 1,
    ciphertext: 'a'.repeat(64),
  };
}

function commandPayload(): SignedRemoteCommandPayload {
  const now = new Date();
  return {
    protocol_version: 1,
    command_id: 'cmd_abcdefghijklmnop',
    device_id: 'device_abcdefghijklmnop',
    node_id: 'node_abcdefghijklmnop',
    type: 'agent.pause_request',
    subject: { kind: 'agent_session', id: 'session_a', version: 1 },
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 2 * 60_000).toISOString(),
    nonce: 'abcdefghijklmnop',
    parameters: {},
  };
}

function device(role: RemoteDevice['role']): RemoteDevice {
  return {
    id: 'device_abcdefghijklmnop',
    routeId: 'device_route_abcdefghijklmnop',
    label: 'test',
    role,
    status: 'active',
    signingPublicKey: 'a',
    exchangePublicKey: 'b',
    keyId: 'key_abcdefghijklmnop',
    restrictions: {
      projects: [],
      targets: [],
      environments: ['development', 'staging'],
      maxRisk: 'medium',
      approvalKinds: ['plan', 'operation'],
      maxProviderSpendEur: 0,
    },
    pairedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function future(): string {
  return new Date(Date.now() + 2 * 60_000).toISOString();
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
