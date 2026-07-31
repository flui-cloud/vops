import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Client, createClient } from '@libsql/client';
import { profileDir } from '../lib/profile';
import { stableStringify } from '../agent-api/plan-store';
import {
  AgentApproval,
  AgentAuditEvent,
  AgentOperation,
  AgentPlan,
  AgentSession,
} from './agent-model';
import { redactSecrets } from './redaction';

@Injectable()
export class AgentStore implements OnModuleDestroy {
  private client: Client | null = null;

  async saveSession(session: AgentSession, tokenHash?: string): Promise<void> {
    const db = await this.db();
    await db.execute({
      sql:
        'INSERT INTO agent_sessions (id, status, expires_at, token_hash, record) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET status=excluded.status, expires_at=excluded.expires_at, ' +
        'token_hash=COALESCE(excluded.token_hash, agent_sessions.token_hash), record=excluded.record',
      args: [session.id, session.status, session.limits.expiresAt, tokenHash ?? null, safeJson(session)],
    });
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return this.one<AgentSession>('SELECT record FROM agent_sessions WHERE id = ?', [id]);
  }

  async getSessionByTokenHash(tokenHash: string): Promise<AgentSession | null> {
    return this.one<AgentSession>('SELECT record FROM agent_sessions WHERE token_hash = ?', [tokenHash]);
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.many<AgentSession>("SELECT record FROM agent_sessions ORDER BY json_extract(record, '$.createdAt') DESC");
  }

  async savePlan(plan: AgentPlan): Promise<void> {
    await this.upsertRecord(
      'agent_plans',
      ['id', 'session_id', 'status', 'hash', 'record'],
      [plan.id, plan.sessionId, plan.status, plan.hash, safeJson(plan)],
      ['session_id', 'status', 'hash', 'record'],
    );
  }

  async getPlan(id: string): Promise<AgentPlan | null> {
    return this.one<AgentPlan>('SELECT record FROM agent_plans WHERE id = ?', [id]);
  }

  async listPlans(sessionId?: string): Promise<AgentPlan[]> {
    return sessionId
      ? this.many<AgentPlan>('SELECT record FROM agent_plans WHERE session_id = ? ORDER BY created_at DESC', [sessionId])
      : this.many<AgentPlan>('SELECT record FROM agent_plans ORDER BY created_at DESC');
  }

  async saveApproval(approval: AgentApproval): Promise<void> {
    await this.upsertRecord(
      'agent_approvals',
      ['id', 'session_id', 'status', 'expires_at', 'record'],
      [approval.id, approval.sessionId, approval.status, approval.expiresAt, safeJson(approval)],
      ['session_id', 'status', 'expires_at', 'record'],
    );
  }

  async getApproval(id: string): Promise<AgentApproval | null> {
    return this.one<AgentApproval>('SELECT record FROM agent_approvals WHERE id = ?', [id]);
  }

  async listApprovals(status?: string): Promise<AgentApproval[]> {
    return status
      ? this.many<AgentApproval>('SELECT record FROM agent_approvals WHERE status = ? ORDER BY requested_at DESC', [status])
      : this.many<AgentApproval>('SELECT record FROM agent_approvals ORDER BY requested_at DESC');
  }

  async saveOperation(operation: AgentOperation): Promise<void> {
    await this.upsertRecord(
      'agent_operations',
      ['id', 'session_id', 'plan_id', 'state', 'record'],
      [operation.id, operation.sessionId, operation.planId, operation.state, safeJson(operation)],
      ['session_id', 'plan_id', 'state', 'record'],
    );
  }

  async getOperation(id: string): Promise<AgentOperation | null> {
    return this.one<AgentOperation>('SELECT record FROM agent_operations WHERE id = ?', [id]);
  }

  async listOperations(sessionId?: string): Promise<AgentOperation[]> {
    return sessionId
      ? this.many<AgentOperation>('SELECT record FROM agent_operations WHERE session_id = ? ORDER BY created_at DESC', [sessionId])
      : this.many<AgentOperation>('SELECT record FROM agent_operations ORDER BY created_at DESC');
  }

  async appendEvent(event: Omit<AgentAuditEvent, 'hash' | 'previousHash' | 'redactionsApplied'>): Promise<AgentAuditEvent> {
    const db = await this.db();
    const previous = await db.execute('SELECT hash FROM agent_events ORDER BY sequence DESC LIMIT 1');
    const previousHash = previous.rows[0] ? String(previous.rows[0].hash) : undefined;
    const redacted = redactSecrets(event.detail);
    const payload = { ...event, detail: redacted.value, previousHash };
    const hash = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
    const stored: AgentAuditEvent = {
      ...payload,
      redactionsApplied: redacted.applied,
      hash,
    };
    await db.execute({
      sql:
        'INSERT INTO agent_events (event_id, ts, session_id, operation_id, event_type, capability, target, summary, previous_hash, hash, record) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        stored.eventId,
        stored.timestamp,
        stored.sessionId ?? null,
        stored.operationId ?? null,
        stored.eventType,
        stored.capability ?? null,
        stored.target ?? null,
        stored.summary,
        stored.previousHash ?? null,
        stored.hash,
        safeJson(stored),
      ],
    });
    return stored;
  }

  async listEvents(sessionId?: string, limit = 200): Promise<AgentAuditEvent[]> {
    const bounded = Math.max(1, Math.min(limit, 1000));
    return sessionId
      ? this.many<AgentAuditEvent>(
          'SELECT record FROM agent_events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?',
          [sessionId, bounded],
        )
      : this.many<AgentAuditEvent>('SELECT record FROM agent_events ORDER BY sequence DESC LIMIT ?', [bounded]);
  }

  /** One page of the audit log, newest first. `before` is the sequence of the oldest row
   * already shown, so paging never re-sends or skips a row as new events arrive on top. */
  async listEventPage(opts: { sessionId?: string; before?: number; limit?: number } = {}): Promise<{
    events: AgentAuditEvent[];
    nextCursor: number | null;
  }> {
    const bounded = Math.max(1, Math.min(opts.limit ?? 30, 200));
    const where = [
      ...(opts.sessionId ? ['session_id = ?'] : []),
      ...(opts.before === undefined ? [] : ['sequence < ?']),
    ];
    const params = [
      ...(opts.sessionId ? [opts.sessionId] : []),
      ...(opts.before === undefined ? [] : [opts.before]),
      bounded + 1,
    ];
    const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    // `sequence` is the table's own counter and is not part of the stored record, so the
    // page has to carry it out explicitly — it is the cursor.
    const result = await (await this.db()).execute({
      sql: `SELECT sequence, record FROM agent_events${filter} ORDER BY sequence DESC LIMIT ?`,
      args: params as any[],
    });
    const rows = result.rows.map((row) => ({
      ...(JSON.parse(String(row.record)) as AgentAuditEvent),
      sequence: Number(row.sequence),
    }));
    const events = rows.slice(0, bounded);
    const last = events.at(-1)?.sequence;
    return { events, nextCursor: rows.length > bounded && last !== undefined ? last : null };
  }

  async verifyEventChain(): Promise<{ valid: boolean; events: number; brokenAt?: string }> {
    const events = await this.many<AgentAuditEvent>('SELECT record FROM agent_events ORDER BY sequence ASC');
    let previousHash: string | undefined;
    for (const event of events) {
      const { hash, redactionsApplied: _redacted, ...payload } = event;
      const expected = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
      if (event.previousHash !== previousHash || hash !== expected) {
        return { valid: false, events: events.length, brokenAt: event.eventId };
      }
      previousHash = hash;
    }
    return { valid: true, events: events.length };
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const result = await (await this.db()).execute({
      sql: 'SELECT value FROM agent_settings WHERE key = ?',
      args: [key],
    });
    return result.rows[0] ? JSON.parse(String(result.rows[0].value)) as T : null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await (await this.db()).execute({
      sql:
        'INSERT INTO agent_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP',
      args: [key, safeJson(value)],
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.close();
    this.client = null;
  }

  private async one<T>(sql: string, args: unknown[]): Promise<T | null> {
    const result = await (await this.db()).execute({ sql, args: args as any[] });
    return result.rows[0] ? (JSON.parse(String(result.rows[0].record)) as T) : null;
  }

  private async many<T>(sql: string, args: unknown[] = []): Promise<T[]> {
    const result = await (await this.db()).execute({ sql, args: args as any[] });
    return result.rows.map((row) => JSON.parse(String(row.record)) as T);
  }

  private async upsertRecord(
    table: string,
    columns: string[],
    values: unknown[],
    updates: string[],
  ): Promise<void> {
    const placeholders = columns.map(() => '?').join(', ');
    const assignments = updates.map((column) => `${column}=excluded.${column}`).join(', ');
    await (await this.db()).execute({
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${assignments}`,
      args: values as any[],
    });
  }

  private async db(): Promise<Client> {
    if (this.client) return this.client;
    const dir = profileDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.client = createClient({ url: `file:${path.join(dir, 'vops.db')}` });
    await this.client.execute('PRAGMA journal_mode = WAL');
    await this.client.execute('PRAGMA busy_timeout = 5000');
    await migrate(this.client);
    return this.client;
  }
}

async function migrate(db: Client): Promise<void> {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS agent_sessions (
         id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at TEXT NOT NULL,
         token_hash TEXT UNIQUE, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS agent_plans (
         id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
         hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS agent_approvals (
         id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
         expires_at TEXT NOT NULL, requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS agent_operations (
         id TEXT PRIMARY KEY, session_id TEXT NOT NULL, plan_id TEXT NOT NULL,
         state TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS agent_events (
         sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, ts TEXT NOT NULL,
         session_id TEXT, operation_id TEXT, event_type TEXT NOT NULL, capability TEXT,
         target TEXT, summary TEXT NOT NULL, previous_hash TEXT, hash TEXT NOT NULL, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS agent_settings (
         key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
       )`,
      'CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status)',
      'CREATE INDEX IF NOT EXISTS idx_agent_approvals_status ON agent_approvals(status)',
      'CREATE INDEX IF NOT EXISTS idx_agent_operations_session ON agent_operations(session_id)',
      'CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id, sequence)',
    ],
    'write',
  );
}

function safeJson(value: unknown): string {
  return JSON.stringify(redactSecrets(value).value);
}
