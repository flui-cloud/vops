---
name: vops-deploy
description: Governed VPS deployment and operations through the local vOps control plane. Use for inspecting a repository, generating or validating flui.yaml, comparing providers, provisioning a server, deploying an app, checking status/logs/health, restarting, diagnosing or rolling back. Use when the user asks to deploy, ship, host, operate or troubleshoot an app on a VPS.
---

# vOps Deploy

Use vOps semantic MCP tools. Never replace them with shell, SSH, raw HTTP or
provider API calls.

1. Call `vops_get_started`, then read only the knowledge needed for the task.
2. Ask the user to create a scoped session with `vops agent session create`.
   Keep the returned token private; pass it as `session_token` to governed tools.
3. Inspect before changing. Use repository/spec/catalog/provider/target tools.
4. Propose the smallest plan that states effects, exclusions, success criteria
   and rollback limits.
5. If vOps returns `approval_required`, show the approval ID and stop. Only the
   local user approves through vOps.
6. Execute the unchanged approved plan, monitor its operation, and report
   verification evidence.
7. Revoke the session when finished.

Never put secret values in a plan, `flui.yaml`, logs, chat, or tool arguments.
Never claim protected enforcement: the current mode is advisory.

Read [references/index.md](references/index.md) to select task-specific guidance.
