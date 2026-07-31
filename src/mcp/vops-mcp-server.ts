import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { INestApplicationContext } from '@nestjs/common';
import { ActionBroker } from '../agent-control/action-broker';
import { AgentSessionManager } from '../agent-control/agent-session-manager';
import { CapabilityRegistry } from '../agent-control/capability-registry';
import { OperationManager } from '../agent-control/operation-manager';
import { KnowledgeService } from '../agent-kit/knowledge.service';
import { errorEnvelope, okEnvelope, VopsMcpEnvelope } from '../agent-control/mcp-envelope';
import { AgentControlError } from '../agent-control/agent-control-error';
import { VopsSpecService } from '../spec/vops-spec.service';

const SERVER_INSTRUCTIONS =
  'vOps is a local control plane for agentless VPS servers. Call vops_get_started before the first infrastructure task. ' +
  'Infrastructure operations require an active session. Create and validate a plan before mutation. Never request provider ' +
  'or SSH credentials; use semantic vOps operations, not direct SSH. Verify failures before retrying. Put destructive actions in a separate explicit plan.';

export function createVopsMcpServer(app: INestApplicationContext): McpServer {
  const broker = app.get(ActionBroker);
  const sessions = app.get(AgentSessionManager);
  const registry = app.get(CapabilityRegistry);
  const operations = app.get(OperationManager);
  const knowledge = app.get(KnowledgeService);
  const spec = app.get(VopsSpecService);
  const server = new McpServer(
    { name: 'vops', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerTool(server, 'vops_get_started', 'Learn the vOps safety model and first steps.', {}, async () =>
    okEnvelope('vOps is ready for a locally governed infrastructure task.', {
      product: 'Local advisory control plane for agentless VPS servers.',
      mode: 'advisory',
      firstSteps: [
        'Ask the user to create a scoped session with vops agent session create.',
        'Search and read only the knowledge needed.',
        'List capabilities and inspect targets.',
        'Create and validate a plan before any mutation.',
      ],
      knowledge: knowledge.list(),
    }, { nextActions: ['Call vops_search_knowledge for the current workflow.'] }),
  );
  registerTool(server, 'vops_list_capabilities', 'List authoritative semantic capabilities.', {}, async () =>
    okEnvelope('Available vOps capabilities.', {
      schemaVersion: registry.schemaVersion,
      capabilities: registry.list({ includeUnavailable: true }),
    }),
  );
  registerTool(
    server,
    'vops_describe_capability',
    'Describe one capability, including schema, effects and risk.',
    { capability: z.string().min(1) },
    async ({ capability }) => okEnvelope(`Capability ${capability}.`, registry.describe(capability)),
  );
  registerTool(
    server,
    'vops_search_knowledge',
    'Search the bundled vOps knowledge index.',
    { query: z.string().min(1), limit: z.number().int().min(1).max(25).optional() },
    async ({ query, limit }) => okEnvelope('Knowledge search results.', knowledge.search(query, limit)),
  );
  registerTool(
    server,
    'vops_read_knowledge',
    'Read one published knowledge document returned by search.',
    { path: z.string().min(1) },
    async ({ path }) => okEnvelope(`Knowledge document ${path}.`, knowledge.read(path)),
  );
  registerTool(
    server,
    'vops_list_targets',
    'List registered targets inside the authenticated session.',
    { session_token: z.string().min(1) },
    async ({ session_token }) => {
      const result = await broker.invoke(session_token, 'target.list', {}, { objective: 'List eligible targets' });
      return okEnvelope('Eligible targets.', result.operation?.result ?? result, {
        capability: registry.describe('target.list'),
        operation: result.operation,
      });
    },
  );
  registerTool(
    server,
    'vops_inspect_target',
    'Inspect one scoped target using bounded read-only probes.',
    {
      session_token: z.string().min(1),
      target: z.string().min(1),
    },
    async ({ session_token, target }) => {
      const result = await broker.invoke(
        session_token,
        'target.inspect',
        { target },
        { objective: `Inspect target ${target}`, target },
      );
      return okEnvelope(`Target ${target}.`, result.operation?.result ?? result, {
        capability: registry.describe('target.inspect'),
        operation: result.operation,
      });
    },
  );
  registerTool(
    server,
    'vops_create_plan',
    'Create an immutable multi-step plan under a session.',
    {
      session_token: z.string().min(1),
      objective: z.string().min(1),
      environment: z.enum(['development', 'staging', 'production']).optional(),
      target: z.string().optional(),
      steps: z.array(z.object({
        capability: z.string().min(1),
        input: z.record(z.string(), z.unknown()).optional(),
      })).min(1),
      success_criteria: z.array(z.string()).optional(),
      excluded_effects: z.array(z.string()).optional(),
    },
    async (input) => {
      const result = await broker.createPlan(input.session_token, {
        objective: input.objective,
        environment: input.environment,
        target: input.target,
        steps: input.steps,
        successCriteria: input.success_criteria,
        excludedEffects: input.excluded_effects,
      });
      return okEnvelope('Plan created.', result, {
        approval: result.approval,
        nextActions: result.approval ? [`Ask the local user to approve ${result.approval.id}.`] : ['Execute the plan.'],
      });
    },
  );
  registerTool(
    server,
    'vops_validate_plan',
    'Validate a plan hash and all step inputs before execution.',
    { session_token: z.string().min(1), plan_id: z.string().min(1) },
    async ({ session_token, plan_id }) =>
      okEnvelope('Plan validation complete.', await broker.validatePlan(session_token, plan_id)),
  );
  registerTool(
    server,
    'vops_execute_plan',
    'Execute an unchanged plan after required local approval.',
    { session_token: z.string().min(1), plan_id: z.string().min(1) },
    async ({ session_token, plan_id }) => {
      const operation = await broker.executePlan(session_token, plan_id);
      return okEnvelope('Plan execution completed.', operation, { operation });
    },
  );
  registerTool(
    server,
    'vops_get_operation',
    'Read one operation belonging to the authenticated session.',
    { session_token: z.string().min(1), operation_id: z.string().min(1) },
    async ({ session_token, operation_id }) => {
      const session = await sessions.authenticate(session_token);
      const operation = await operations.get(operation_id);
      if (operation.sessionId !== session.id) throw new Error('The operation belongs to a different session.');
      return okEnvelope('Operation status.', operation, { operation });
    },
  );
  registerTool(
    server,
    'vops_cancel_operation',
    'Request cooperative cancellation of an operation.',
    { session_token: z.string().min(1), operation_id: z.string().min(1) },
    async ({ session_token, operation_id }) => {
      const session = await sessions.authenticate(session_token);
      const operation = await operations.get(operation_id);
      if (operation.sessionId !== session.id) throw new Error('The operation belongs to a different session.');
      const cancelled = await operations.requestCancel(operation_id);
      return okEnvelope('Cancellation requested.', cancelled, { operation: cancelled });
    },
  );
  registerTool(
    server,
    'vops_rollback_operation',
    'Request rollback only when the completed operation explicitly supports it.',
    { session_token: z.string().min(1), operation_id: z.string().min(1) },
    async ({ session_token, operation_id }) => {
      const session = await sessions.authenticate(session_token);
      const operation = await operations.get(operation_id);
      if (operation.sessionId !== session.id) throw new Error('The operation belongs to a different session.');
      if (!operation.rollbackAvailable || !registry.has('application.rollback')) {
        throw new AgentControlError(
          'VOPS_AGENT_UNSUPPORTED',
          'Rollback is not available for this operation in the current vOps build.',
          'failed',
          false,
        );
      }
      throw new AgentControlError('VOPS_AGENT_UNSUPPORTED', 'Rollback execution is not implemented.', 'failed');
    },
  );
  registerTool(
    server,
    'vops_get_session',
    'Show the session authenticated by the supplied token.',
    { session_token: z.string().min(1) },
    async ({ session_token }) => okEnvelope('Agent session status.', await sessions.authenticate(session_token)),
  );
  registerTool(
    server,
    'vops_request_scope_expansion',
    'Request a local-user decision for one capability outside the current grant.',
    {
      session_token: z.string().min(1),
      capability: z.string().min(1),
      reason: z.string().min(1),
      target: z.string().optional(),
      environment: z.enum(['development', 'staging', 'production']).optional(),
    },
    async (input) => {
      const approval = await broker.requestScopeExpansion(input.session_token, {
        capability: input.capability,
        reason: input.reason,
        target: input.target,
        environment: input.environment,
      });
      return okEnvelope('Scope expansion requires a local user decision.', approval, {
        approval,
        capability: registry.describe(input.capability),
        nextActions: [`Ask the user to approve or deny ${approval.id} locally.`],
      });
    },
  );

  server.registerResource('vops-knowledge-index', 'vops://knowledge/index', {
    title: 'vOps knowledge index',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(knowledge.list()) }],
  }));
  server.registerResource('vops-capability-registry', 'vops://capabilities/index', {
    title: 'vOps capability registry',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({ schemaVersion: registry.schemaVersion, capabilities: registry.list({ includeUnavailable: true }) }),
    }],
  }));
  for (const capability of registry.list({ includeUnavailable: true })) {
    server.registerResource(`vops-capability-${capability.id}`, `vops://capabilities/${capability.id}`, {
      title: capability.id,
      mimeType: 'application/json',
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(capability) }],
    }));
  }
  const knowledgeResources: Record<string, string> = {
    'vops://knowledge/concepts/flui-yml': 'skills/vops-deploy/references/flui-yml.md',
    'vops://knowledge/concepts/security-model': 'skills/vops-deploy/references/security-and-permissions.md',
    'vops://knowledge/workflows/deploy-repository': 'skills/vops-deploy/references/deploy-repository.md',
    'vops://knowledge/workflows/install-catalog-app': 'skills/vops-deploy/references/install-catalog-app.md',
    'vops://knowledge/workflows/diagnose-deployment': 'skills/vops-deploy/references/diagnose-deployment.md',
    'vops://knowledge/workflows/rollback': 'skills/vops-deploy/references/rollback.md',
  };
  for (const [uri, document] of Object.entries(knowledgeResources)) {
    server.registerResource(`vops-knowledge-${document}`, uri, {
      title: document.split('/').pop(),
      mimeType: 'text/markdown',
    }, async (resourceUri) => ({
      contents: [{ uri: resourceUri.href, mimeType: 'text/markdown', text: knowledge.read(document).content }],
    }));
  }
  server.registerResource('vops-flui-schema', 'vops://schemas/flui-yml', {
    title: 'flui.yml Application JSON Schema',
    mimeType: 'application/schema+json',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: JSON.stringify(spec.schema('Application')) }],
  }));
  server.registerResource('vops-current-session', 'vops://session/current', {
    title: 'Current vOps agent session',
    mimeType: 'text/plain',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/plain',
      text: 'Session state is private. Call vops_get_session with the short-lived session token.',
    }],
  }));
  return server;
}

export async function serveVopsMcpStdio(app: INestApplicationContext): Promise<void> {
  const server = createVopsMcpServer(app);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
  await server.connect(transport);
  await closed;
}

export async function serveVopsMcpHttp(
  app: INestApplicationContext,
  options: { port: number; bearerToken: string },
): Promise<http.Server> {
  if (!options.bearerToken) throw new Error('Loopback MCP requires a bearer token.');
  const expressApp = createMcpExpressApp({ host: '127.0.0.1' });
  expressApp.use((req, res, next) => {
    if (!isAuthorizedLoopbackRequest(
      req.headers.host,
      req.headers.authorization,
      options.port,
      options.bearerToken,
    )) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  expressApp.all('/mcp', async (req, res) => {
    const server = createVopsMcpServer(app);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    }
  });
  return new Promise((resolve, reject) => {
    const listener = expressApp.listen(options.port, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
}

export function isAuthorizedLoopbackRequest(
  host: string | undefined,
  authorization: string | undefined,
  port: number,
  expectedToken: string,
): boolean {
  const validHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  const supplied = String(authorization ?? '').replace(/^Bearer\s+/i, '');
  const validToken = supplied.length === expectedToken.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expectedToken));
  return validHost && validToken;
}

function registerTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: T,
  handler: (input: z.infer<z.ZodObject<T>>) => Promise<VopsMcpEnvelope> | VopsMcpEnvelope,
): void {
  const callback = async (input: z.infer<z.ZodObject<T>>): Promise<CallToolResult> => {
    try {
      const envelope = await handler(input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      };
    } catch (error) {
      const envelope = errorEnvelope(error);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      };
    }
  };
  server.registerTool(name, { description, inputSchema }, callback as any);
}
