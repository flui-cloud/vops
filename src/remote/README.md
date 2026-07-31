# Secure remote control — local implementation contract

The Phase 0 architecture review and the relay/PWA repository map live in
`vops-landing/docs/REMOTE_CONTROL_PHASE0.md`. The copy used during isolated
development is in the sibling `vops-landing-remote-control` worktree.

The local backend owns every authoritative record and decision. New remote
modules may:

- authenticate and decrypt a paired device message;
- build redacted snapshots and conversation responses;
- create proposals and approval requests;
- translate an allowlisted signed command to an existing domain service.

They may not:

- open an inbound network listener;
- expose the loopback API or MCP server through the relay;
- call SSH, provider clients, shell execution, or an executor directly;
- treat relay authentication or delivery as operational authorization;
- bypass `AgentSessionManager`, `PlanEngine`, `PolicyEngine`,
  `ApprovalManager`, or `ActionBroker`;
- send secrets, raw logs, full inventory, or cleartext operational content to
  the relay.

## Direct dependencies on the agent-first layer

| Remote concern | Existing local dependency |
|---|---|
| Governed chat scope | `AgentSessionManager` |
| Semantic operation vocabulary | `CapabilityRegistry` and MCP capability schemas |
| Mutation proposal | `PlanEngine` |
| Current authorization | `PolicyEngine` |
| Human decision lifecycle | `ApprovalManager` |
| Infrastructure execution | `ActionBroker` only |
| Durable operations | `OperationManager` and `AgentStore` |
| Credentials | `CredentialResolver` / encrypted `LocalConfigStore`; values never enter remote DTOs |
| Audit | append-only hash-chained `AgentStore.appendEvent` |

The protocol copies under `src/remote/protocol` must remain byte-for-byte
compatible with the schemas under `vops-landing/docs/protocol`. A future
published protocol package can replace this source distribution, but protocol
version 1 remains schema-defined rather than implementation-defined.

## Implemented local services

| Service | Responsibility |
|---|---|
| `RelayClient` | One outbound connection, short-lived tickets, heartbeat, bounded reconnect jitter, relay route reconciliation |
| `PairingService` / `DeviceRegistry` | Challenge proof, explicit local confirmation, roles/grants, suspension and irreversible revocation |
| `RemoteCryptoService` / `RemoteMessenger` | Node identity, X25519 key agreement, XChaCha20-Poly1305 envelopes, Ed25519 verification |
| `RemoteGateway` | Strict ingress validation, device/key binding, decrypt-then-ack, replay persistence and channel dispatch |
| `RemoteSyncService` | Compact role-scoped state without credentials, addresses, raw logs, or private inventory |
| `ConversationService` | Local-only conversations, authoritative cancellation and bounded encrypted response deltas |
| `RemoteAgentRegistry` / `RemoteAgentPolicyStore` | Cached provider health, explicit default, enablement and locally approved fallback order |
| `RemoteAgentToolsService` / `RemoteAgentMcpBridge` | One semantic tool contract through `ActionBroker`; per-turn bearer-authenticated loopback MCP leases |
| `CodexAppServerAdapter` | Existing Codex authentication, read-only app-server sandbox, dynamic vOps tools and `turn/interrupt` |
| `ClaudeCodeAdapter` | Strict-MCP, built-ins-disabled, non-persistent headless process using existing Claude authentication |
| `OpenCodeAdapter` | Ephemeral deny-by-default runtime config with only the vOps MCP tool namespace allowed |
| `AntigravityAdapter` | Headless AGY runtime that fails closed until its restrictive policy is explicitly accepted |
| `OpenAICompatibleAgentAdapter` | Explicit optional provider with bounded streaming tool loop and no implicit activation |
| `RemoteCommandHandler` | Canonical signed command validation, immutable plan binding and authoritative outcomes |
| `IntentService` | Deterministic catalog watcher and one-shot preauthorized execution through `ActionBroker` |

Unique message IDs, command IDs, and nonces are the replay authority. Sequence
numbers are retained as per-device high-water marks, not a strict delivery
order: relay priority queues may legitimately deliver a later high-priority
command before an earlier state message.

## Coding-agent selection and cancellation

The default provider and fallback order are local administrative policy:

```bash
vops agent provider status
vops agent provider enable --provider claude-code
vops agent provider default --provider claude-code
vops agent provider fallback --providers codex,opencode
```

Selecting a provider in the PWA never enables it. An unavailable explicit
selection may use only the fallback order already approved locally. The
OpenAI-compatible provider is neither enabled nor a fallback merely because it
is configured. The deterministic summary is non-model, read-only, and can be
disabled with `provider fallback --no-deterministic`.

The provider bearer protects only a short-lived `127.0.0.1` MCP lease and is
stored in a mode-0600 temporary config, never in a prompt or process argument.
The vOps session token remains in the parent process. Each provider receives
the same schemas and calls the same `RemoteAgentToolsService`; it cannot gain a
capability by changing runtimes.

`chat.cancel` is cooperative but authoritative. The PWA shows a stopping state,
the local adapter interrupts or terminates the runtime, pending delta buffers
are discarded, and only then does the node emit `chat.cancelled`. A cancellation
for an already terminal request is acknowledged as such and never replays work.

Antigravity is additionally gated because AGY automatically allows workspace
file access. It becomes ready only when
`VOPS_ANTIGRAVITY_REMOTE_POLICY=approved` and its user settings contain this
effective minimum (deny rules take precedence):

```json
{
  "permissions": {
    "deny": [
      "read_file(*)",
      "write_file(*)",
      "read_url(*)",
      "execute_url(*)",
      "command(*)",
      "unsandboxed(*)"
    ],
    "allow": ["mcp(vops/*)"]
  }
}
```

`mcp(*)` and `mcp(vops/*)` must not appear in the deny list. vOps verifies
these exact rules before every AGY turn and otherwise reports
`not_headless_capable`.

Device suspension pauses active intents. Device revocation revokes their
dedicated sessions and deletes their local intent credential. Relay route state
is reconciled before each outbound WebSocket connection, while the local device
record remains authoritative if the relay is unavailable.

See `vops-landing/docs/REMOTE_CONTROL_IMPLEMENTATION.md` for the full operator
flow, PWA behavior, security contract, verification command, and deferred
Phase 7 work.
