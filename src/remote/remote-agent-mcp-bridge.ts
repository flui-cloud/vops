import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { RemoteAgentToolsService } from './remote-agent-tools.service';
import { RemoteAgentTurn } from './remote-agent.types';

export interface RemoteAgentMcpLease {
  url: string;
  bearerToken: string;
  close(): Promise<void>;
}

@Injectable()
export class RemoteAgentMcpBridge {
  constructor(private readonly tools: RemoteAgentToolsService) {}

  async open(turn: RemoteAgentTurn): Promise<RemoteAgentMcpLease> {
    const bearerToken = crypto.randomBytes(32).toString('base64url');
    const app = createMcpExpressApp({ host: '127.0.0.1' });
    const active = new Set<{ server: McpServer; transport: StreamableHTTPServerTransport }>();
    let port = 0;

    app.use((request, response, next) => {
      if (!authorized(request.headers.host, request.headers.authorization, port, bearerToken)) {
        response.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    });
    app.all('/mcp', async (request, response) => {
      const server = this.createServer(turn);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const entry = { server, transport };
      active.add(entry);
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } finally {
        active.delete(entry);
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    });

    const listener = await listen(app);
    port = (listener.address() as AddressInfo).port;
    const close = async () => {
      for (const entry of active) {
        await entry.transport.close().catch(() => undefined);
        await entry.server.close().catch(() => undefined);
      }
      active.clear();
      await closeServer(listener);
    };
    turn.signal.addEventListener('abort', () => void close(), { once: true });
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      bearerToken,
      close,
    };
  }

  private createServer(turn: RemoteAgentTurn): McpServer {
    const server = new McpServer(
      { name: 'vops-remote', version: '1.0.0' },
      {
        instructions:
          'This is a short-lived governed vOps surface. Use only these semantic tools. ' +
          'Plans and intents are proposals; they never imply approval or execution.',
      },
    );
    for (const definition of this.tools.definitions()) {
      server.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: z.fromJSONSchema(definition.inputSchema as any),
          annotations: {
            readOnlyHint: !definition.name.includes('propose'),
            destructiveHint: false,
            idempotentHint: !definition.name.includes('propose'),
            openWorldHint: false,
          },
        },
        (async (input: unknown) => {
          const result = await this.tools.execute(definition.name, input, turn);
          return {
            isError: !result.success,
            content: [{ type: 'text' as const, text: result.content }],
          };
        }) as any,
      );
    }
    return server;
  }
}

function authorized(
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

function listen(app: ReturnType<typeof createMcpExpressApp>): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
