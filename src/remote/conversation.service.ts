import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { AgentSessionManager } from '../agent-control/agent-session-manager';
import { AgentStore } from '../agent-control/agent-store';
import { CapabilityRegistry } from '../agent-control/capability-registry';
import { localId } from '../agent-control/ids';
import { AgentClient } from '../agent-control/agent-model';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { profileDir } from '../lib/profile';
import { REMOTE_CHAT_CAPABILITIES } from './remote-agent-tools.service';
import { RemoteAgentRouter } from './remote-agent-router';
import {
  RemoteChatCancelMessage,
  RemoteChatUserMessage,
} from './remote-message.types';
import {
  RemoteConversation,
  RemoteConversationMessage,
  RemoteDevice,
} from './remote-model';
import { RemoteMessenger } from './remote-messenger';
import { RemoteStore } from './remote-store';
import { RemoteSyncService } from './remote-sync.service';

const MAX_CONTEXT_MESSAGES = 12;
const STREAM_BATCH_MS = 180;
const STREAM_BATCH_CHARS = 480;

@Injectable()
export class ConversationService {
  private readonly secrets = new LocalConfigStore();
  private readonly activeTurns = new Map<string, {
    controller: AbortController;
    conversationId?: string;
    cancelRequestId?: string;
  }>();

  constructor(
    private readonly store: RemoteStore,
    private readonly messenger: RemoteMessenger,
    private readonly router: RemoteAgentRouter,
    private readonly sessions: AgentSessionManager,
    private readonly capabilities: CapabilityRegistry,
    private readonly audit: AgentStore,
    private readonly sync: RemoteSyncService,
  ) {}

  async handle(device: RemoteDevice, request: RemoteChatUserMessage): Promise<void> {
    let conversation: RemoteConversation | undefined;
    let stream: RemoteChatStream | undefined;
    const controller = new AbortController();
    const activeKey = turnKey(device.id, request.request_id);
    if (this.activeTurns.has(activeKey)) return;
    this.activeTurns.set(activeKey, { controller });
    try {
      const selectedProvider = await this.router.resolveProvider(request.provider);
      conversation = await this.resolveConversation(device, request, selectedProvider);
      this.activeTurns.get(activeKey)!.conversationId = conversation.id;
      const sessionToken = await this.requireSessionToken(conversation, device);
      await this.saveMessage(conversation, request.request_id, 'user', request.content);
      await this.messenger.send(device, 'chat_stream', {
        type: 'chat.accepted',
        request_id: request.request_id,
        conversation_id: conversation.id,
        provider: selectedProvider,
      }, 5 * 60_000);

      const previous = (await this.store.listConversationMessages(
        conversation.id,
        MAX_CONTEXT_MESSAGES + 1,
      ))
        .filter((entry) => entry.role !== 'status' && entry.requestId !== request.request_id)
        .slice(-MAX_CONTEXT_MESSAGES)
        .map((entry) => ({
          role: entry.role as 'user' | 'assistant',
          content: entry.content,
        }));
      stream = new RemoteChatStream(
        device,
        conversation.id,
        request.request_id,
        this.messenger,
      );
      const result = await this.router.run(device, request.request_id, {
        requestId: request.request_id,
        sessionToken,
        prompt: request.content,
        context: previous,
        signal: controller.signal,
        onDelta: (delta) => stream.push(delta),
        onStatus: async (status, detail) => {
          await this.messenger.send(device, 'chat_stream', {
            type: 'chat.status',
            request_id: request.request_id,
            conversation_id: conversation!.id,
            status,
            ...(detail ? { detail } : {}),
          }, 5 * 60_000);
        },
        onApproval: async () => {
          await this.messenger.send(
            device,
            'state_sync',
            await this.sync.snapshot(device, request.request_id),
            5 * 60_000,
          );
        },
        onIntentProposal: async (proposal) => {
          await this.messenger.send(device, 'chat_stream', {
            type: 'chat.intent_proposed',
            request_id: request.request_id,
            conversation_id: conversation!.id,
            proposal,
          }, 10 * 60_000);
        },
      }, request.provider);
      if (controller.signal.aborted) throw cancelledError();
      const finalSequence = await stream.flush();
      if (controller.signal.aborted) throw cancelledError();
      const assistant = await this.saveMessage(
        conversation,
        request.request_id,
        'assistant',
        result.text,
      );
      conversation = {
        ...conversation,
        agentProvider: result.provider,
        summary: compactSummary(result.text),
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveConversation(conversation);
      await this.messenger.send(device, 'chat_stream', {
        type: 'chat.completed',
        request_id: request.request_id,
        conversation_id: conversation.id,
        message_id: assistant.id,
        final_sequence: finalSequence,
        provider: result.provider,
      }, 5 * 60_000);
      await this.event(
        conversation,
        'remote.chat.completed',
        `Completed remote chat request with ${result.provider}.`,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        await stream?.cancel();
        const active = this.activeTurns.get(activeKey);
        await this.messenger.send(device, 'chat_stream', {
          type: 'chat.cancelled',
          request_id: active?.cancelRequestId ?? request.request_id,
          target_request_id: request.request_id,
          ...(conversation ? { conversation_id: conversation.id } : {}),
          authoritative: true,
        }, 5 * 60_000).catch(() => undefined);
        if (conversation) {
          await this.event(
            conversation,
            'remote.chat.cancelled',
            'Remote chat turn stopped locally.',
          );
        }
        return;
      }
      await this.messenger.send(device, 'chat_stream', {
        type: 'chat.failed',
        request_id: request.request_id,
        ...(conversation ? { conversation_id: conversation.id } : {}),
        code: remoteErrorCode(error),
        message: safeRemoteError(error),
        recoverable: true,
      }, 5 * 60_000).catch(() => undefined);
      if (conversation) {
        await this.event(conversation, 'remote.chat.failed', 'Remote chat request failed.');
      }
    } finally {
      this.activeTurns.delete(activeKey);
    }
  }

  async cancel(device: RemoteDevice, request: RemoteChatCancelMessage): Promise<void> {
    const active = this.activeTurns.get(turnKey(device.id, request.target_request_id));
    if (!active || (request.conversation_id &&
      active.conversationId &&
      request.conversation_id !== active.conversationId)) {
      await this.messenger.send(device, 'chat_stream', {
        type: 'chat.cancelled',
        request_id: request.request_id,
        target_request_id: request.target_request_id,
        ...(request.conversation_id ? { conversation_id: request.conversation_id } : {}),
        authoritative: true,
        already_terminal: true,
      }, 5 * 60_000);
      return;
    }
    active.cancelRequestId = request.request_id;
    active.controller.abort();
  }

  private async resolveConversation(
    device: RemoteDevice,
    request: RemoteChatUserMessage,
    selectedProvider: string,
  ): Promise<RemoteConversation> {
    if (request.conversation_id) {
      const existing = await this.store.getConversation(request.conversation_id);
      if (!existing || existing.deviceId !== device.id || existing.status !== 'active') {
        throw new Error('Remote conversation is unavailable to this device.');
      }
      return existing;
    }
    const { session, token } = await this.createSession(
      device,
      request.content,
      selectedProvider,
    );
    const now = new Date().toISOString();
    const conversation: RemoteConversation = {
      id: localId('conversation'),
      deviceId: device.id,
      title: titleFrom(request.content),
      status: 'active',
      agentProvider: selectedProvider,
      agentSessionId: session.id,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveConversation(conversation);
    this.secrets.setCredentials(secretKey(conversation.id), { token });
    await this.event(conversation, 'remote.chat.created', 'Created governed remote conversation.');
    return conversation;
  }

  private async requireSessionToken(
    conversation: RemoteConversation,
    device: RemoteDevice,
  ): Promise<string> {
    const token = this.secrets.getCredentials(secretKey(conversation.id))?.token;
    if (token) {
      try {
        await this.sessions.authenticate(token);
        return token;
      } catch {
        // Expired or revoked conversation sessions are replaced locally with
        // the same least-privilege contract; the old token remains unusable.
      }
    }
    const created = await this.createSession(
      device,
      `Continue remote conversation ${conversation.id}`,
      conversation.agentProvider,
    );
    conversation.agentSessionId = created.session.id;
    conversation.updatedAt = new Date().toISOString();
    await this.store.saveConversation(conversation);
    this.secrets.setCredentials(secretKey(conversation.id), { token: created.token });
    return created.token;
  }

  private createSession(device: RemoteDevice, objective: string, provider: string) {
    const workspace = path.join(profileDir(), 'remote-agent-workspace');
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const all = this.capabilities.list({ includeUnavailable: true }).map((entry) => entry.id);
    const allow = all.filter((entry) => REMOTE_CHAT_CAPABILITIES.has(entry));
    const mutations = device.role === 'viewer'
      ? []
      : this.capabilities
          .list()
          .filter((entry) =>
            entry.access !== 'read' &&
            entry.supportsPlan &&
            entry.risk !== 'destructive' &&
            riskRank(entry.risk) <= riskRank(device.restrictions.maxRisk),
          )
          .map((entry) => entry.id);
    return this.sessions.create({
      client: agentClient(provider),
      displayName: `Remote assistant for ${device.label}`,
      objective: `Read-only remote support: ${objective.slice(0, 240)}`,
      repository: workspace,
      mode: 'advisory',
      targets: device.restrictions.targets,
      environments: device.restrictions.environments,
      permissions: {
        allow,
        allowWithinApprovedPlan: mutations,
        requireApproval: [],
        deny: all.filter((entry) =>
          !REMOTE_CHAT_CAPABILITIES.has(entry) && !mutations.includes(entry),
        ),
      },
      expiresInMinutes: 12 * 60,
      maxOperations: 200,
      maxProviderSpendEur: device.restrictions.maxProviderSpendEur,
    });
  }

  private async saveMessage(
    conversation: RemoteConversation,
    requestId: string,
    role: RemoteConversationMessage['role'],
    content: string,
  ): Promise<RemoteConversationMessage> {
    const message: RemoteConversationMessage = {
      id: `remote_message_${crypto.randomBytes(16).toString('base64url')}`,
      conversationId: conversation.id,
      requestId,
      sequence: await this.store.nextConversationSequence(conversation.id),
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveConversationMessage(message);
    return message;
  }

  private async event(
    conversation: RemoteConversation,
    eventType: string,
    summary: string,
  ): Promise<void> {
    await this.audit.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      sessionId: conversation.agentSessionId,
      actor: 'remote_device',
      eventType,
      summary,
      detail: {
        conversationId: conversation.id,
        deviceId: conversation.deviceId,
        provider: conversation.agentProvider,
      },
    });
  }
}

class RemoteChatStream {
  private buffer = '';
  private sequence = 0;
  private timer?: NodeJS.Timeout;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly device: RemoteDevice,
    private readonly conversationId: string,
    private readonly requestId: string,
    private readonly messenger: RemoteMessenger,
  ) {}

  push(delta: string): void {
    this.buffer += delta;
    if (this.buffer.length >= STREAM_BATCH_CHARS) {
      this.queueFlush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.queueFlush(), STREAM_BATCH_MS);
      this.timer.unref();
    }
  }

  async flush(): Promise<number> {
    this.queueFlush();
    await this.sending;
    return this.sequence;
  }

  async cancel(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.buffer = '';
    await this.sending;
  }

  private queueFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const delta = this.buffer;
    if (!delta) return;
    this.buffer = '';
    const sequence = ++this.sequence;
    this.sending = this.sending.then(async () => {
      await this.messenger.send(this.device, 'chat_stream', {
        type: 'chat.text_delta',
        request_id: this.requestId,
        conversation_id: this.conversationId,
        sequence,
        delta,
      }, 5 * 60_000);
    });
  }
}

function secretKey(conversationId: string): string {
  return `vops-remote-conversation-${conversationId}`;
}

function turnKey(deviceId: string, requestId: string): string {
  return `${deviceId}:${requestId}`;
}

function agentClient(provider: string): AgentClient {
  return ['codex', 'claude-code', 'opencode', 'antigravity'].includes(provider)
    ? provider as AgentClient
    : 'other';
}

function titleFrom(content: string): string {
  const title = content.replace(/\s+/g, ' ').trim();
  return title.length > 72 ? `${title.slice(0, 69)}…` : title;
}

function compactSummary(content: string): string {
  const summary = content.replace(/\s+/g, ' ').trim();
  return summary.length > 500 ? `${summary.slice(0, 497)}…` : summary;
}

function safeRemoteError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Remote assistant failed.';
  if (/token|credential|secret|key/i.test(message)) return 'The local assistant could not complete this request.';
  return message.slice(0, 500);
}

function remoteErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/Codex CLI is not available/i.test(message)) return 'VOPS_REMOTE_AGENT_UNAVAILABLE';
  if (/timed out/i.test(message)) return 'VOPS_REMOTE_AGENT_TIMEOUT';
  return 'VOPS_REMOTE_CHAT_FAILED';
}

function cancelledError(): Error {
  const error = new Error('Remote agent turn was cancelled.');
  error.name = 'AbortError';
  return error;
}

function riskRank(risk: string): number {
  return ['read_only', 'low', 'medium', 'high', 'destructive'].indexOf(risk);
}
