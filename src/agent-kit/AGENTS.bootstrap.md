<!-- vops:managed:start -->
## vOps infrastructure operations

Use the `vops-deploy` skill for VPS discovery, planning, deployment and day-2
operations. Treat the local vOps MCP server as the authority for available
capabilities. Create a short-lived advisory session before reading private
inventory or proposing a mutation. Never request or print raw provider,
application, SSH or registry secrets. Mutations must use a plan and any approval
requested by vOps; do not bypass those gates with direct shell, SSH or provider
API calls.
<!-- vops:managed:end -->
