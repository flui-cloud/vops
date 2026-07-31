import { Command, Flags } from '@oclif/core';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { serveVopsMcpHttp, serveVopsMcpStdio } from '../../mcp/vops-mcp-server';

export default class McpServe extends Command {
  static readonly description = 'Serve the local vOps MCP control plane over stdio or authenticated loopback HTTP.';
  static readonly flags = {
    transport: Flags.string({ options: ['stdio', 'http'], default: 'stdio' }),
    port: Flags.integer({ default: 4737, min: 1, max: 65535 }),
    token: Flags.string({ description: 'HTTP bearer token (prefer VOPS_MCP_HTTP_TOKEN)' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(McpServe);
    const app = await getVopsApp();
    try {
      if (flags.transport === 'stdio') {
        await serveVopsMcpStdio(app);
        return;
      }
      const token = flags.token ?? process.env.VOPS_MCP_HTTP_TOKEN;
      if (!token) this.error('HTTP transport requires --token or VOPS_MCP_HTTP_TOKEN.', { exit: 2 });
      const server = await serveVopsMcpHttp(app, { port: flags.port, bearerToken: token });
      this.log(`vOps MCP listening on http://127.0.0.1:${flags.port}/mcp`);
      await waitForSignal(server);
    } finally {
      await closeVopsApp();
    }
  }
}

function waitForSignal(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve) => {
    const close = () => server.close(() => resolve());
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
