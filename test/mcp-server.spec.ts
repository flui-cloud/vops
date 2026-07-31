import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INestApplicationContext } from '@nestjs/common';
import { createVopsMcpServer, isAuthorizedLoopbackRequest } from '../src/mcp/vops-mcp-server';
import { ActionBroker } from '../src/agent-control/action-broker';
import { AgentSessionManager } from '../src/agent-control/agent-session-manager';
import { CapabilityRegistry } from '../src/agent-control/capability-registry';
import { OperationManager } from '../src/agent-control/operation-manager';
import { KnowledgeService } from '../src/agent-kit/knowledge.service';
import { VopsSpecService } from '../src/spec/vops-spec.service';

describe('vOps MCP server', () => {
  it('requires both a loopback Host header and the exact bearer token', () => {
    expect(isAuthorizedLoopbackRequest('127.0.0.1:4737', 'Bearer secret-token', 4737, 'secret-token')).toBe(true);
    expect(isAuthorizedLoopbackRequest('localhost:4737', 'Bearer secret-token', 4737, 'secret-token')).toBe(true);
    expect(isAuthorizedLoopbackRequest('attacker.example', 'Bearer secret-token', 4737, 'secret-token')).toBe(false);
    expect(isAuthorizedLoopbackRequest('127.0.0.1:4737', 'Bearer wrong', 4737, 'secret-token')).toBe(false);
    expect(isAuthorizedLoopbackRequest('127.0.0.1:4737', undefined, 4737, 'secret-token')).toBe(false);
  });

  it('initializes, discovers a compact surface and serves public capabilities', async () => {
    const registry = new CapabilityRegistry();
    const services = new Map<unknown, unknown>([
      [CapabilityRegistry, registry],
      [KnowledgeService, new KnowledgeService()],
      [VopsSpecService, new VopsSpecService()],
      [ActionBroker, {}],
      [AgentSessionManager, {}],
      [OperationManager, {}],
    ]);
    const app = {
      get(token: unknown) {
        return services.get(token);
      },
    } as INestApplicationContext;
    const server = createVopsMcpServer(app);
    const client = new Client({ name: 'vops-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual([
        'vops_get_started',
        'vops_list_capabilities',
        'vops_describe_capability',
        'vops_search_knowledge',
        'vops_read_knowledge',
        'vops_list_targets',
        'vops_inspect_target',
        'vops_create_plan',
        'vops_validate_plan',
        'vops_execute_plan',
        'vops_get_operation',
        'vops_cancel_operation',
        'vops_rollback_operation',
        'vops_get_session',
        'vops_request_scope_expansion',
      ]);

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(['vops://knowledge/index', 'vops://capabilities/index']),
      );
      const response = await client.callTool({ name: 'vops_list_capabilities', arguments: {} });
      const text = (response.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text)).toMatchObject({ status: 'ok', data: { schemaVersion: 1 } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
