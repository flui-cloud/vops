import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Client, createClient } from '@libsql/client';
import { profileDir } from '../lib/profile';
import {
  RemoteConversation,
  RemoteConversationMessage,
  RemoteDevice,
  RemoteIntent,
  RemotePairingSession,
} from './remote-model';

@Injectable()
export class RemoteStore implements OnModuleDestroy {
  private client: Client | null = null;

  async saveDevice(device: RemoteDevice): Promise<void> {
    await this.upsert(
      'remote_devices',
      ['id', 'route_id', 'status', 'role', 'record'],
      [device.id, device.routeId, device.status, device.role, JSON.stringify(device)],
      ['route_id', 'status', 'role', 'record'],
    );
  }

  getDevice(id: string): Promise<RemoteDevice | null> {
    return this.one('SELECT record FROM remote_devices WHERE id = ?', [id]);
  }

  getDeviceByRoute(routeId: string): Promise<RemoteDevice | null> {
    return this.one('SELECT record FROM remote_devices WHERE route_id = ?', [routeId]);
  }

  listDevices(): Promise<RemoteDevice[]> {
    return this.many("SELECT record FROM remote_devices ORDER BY json_extract(record, '$.pairedAt') DESC");
  }

  async savePairing(pairing: RemotePairingSession): Promise<void> {
    await this.upsert(
      'remote_pairings',
      ['id', 'status', 'expires_at', 'record'],
      [pairing.id, pairing.status, pairing.expiresAt, JSON.stringify(pairing)],
      ['status', 'expires_at', 'record'],
    );
  }

  getPairing(id: string): Promise<RemotePairingSession | null> {
    return this.one('SELECT record FROM remote_pairings WHERE id = ?', [id]);
  }

  listPairings(): Promise<RemotePairingSession[]> {
    return this.many("SELECT record FROM remote_pairings ORDER BY json_extract(record, '$.createdAt') DESC");
  }

  async nextOutboundSequence(deviceId: string): Promise<number> {
    const db = await this.db();
    await db.execute({
      sql:
        'INSERT INTO remote_device_counters (device_id, outbound_sequence, inbound_sequence) VALUES (?, 1, 0) ' +
        'ON CONFLICT(device_id) DO UPDATE SET outbound_sequence=outbound_sequence+1',
      args: [deviceId],
    });
    const result = await db.execute({
      sql: 'SELECT outbound_sequence FROM remote_device_counters WHERE device_id = ?',
      args: [deviceId],
    });
    return Number(result.rows[0]?.outbound_sequence ?? 1);
  }

  async acceptInboundMessage(
    deviceId: string,
    messageId: string,
    sequence: number,
    expiresAt: string,
  ): Promise<boolean> {
    const db = await this.db();
    try {
      await db.batch(
        [
          {
            sql:
              'INSERT INTO remote_replay_messages (message_id, device_id, sequence, expires_at) ' +
              'VALUES (?, ?, ?, ?)',
            args: [messageId, deviceId, sequence, expiresAt],
          },
          {
            sql:
              'INSERT INTO remote_device_counters (device_id, outbound_sequence, inbound_sequence) VALUES (?, 0, ?) ' +
              'ON CONFLICT(device_id) DO UPDATE SET inbound_sequence=' +
              'MAX(remote_device_counters.inbound_sequence, excluded.inbound_sequence)',
            args: [deviceId, sequence],
          },
        ],
        'write',
      );
      // The unique message id is the replay authority. Relay priority queues may
      // legitimately deliver adjacent sequence numbers out of order, so the
      // counter is diagnostic/high-water state rather than a strict gate.
      return true;
    } catch {
      return false;
    }
  }

  async rememberCommand(
    commandId: string,
    deviceId: string,
    nonce: string,
    record: unknown,
  ): Promise<boolean> {
    try {
      await (await this.db()).batch(
        [
          {
            sql:
              'INSERT INTO remote_commands (command_id, device_id, received_at, record) ' +
              'VALUES (?, ?, CURRENT_TIMESTAMP, ?)',
            args: [commandId, deviceId, JSON.stringify(record)],
          },
          {
            sql:
              'INSERT INTO remote_command_nonces (nonce, command_id, device_id, received_at) ' +
              'VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
            args: [nonce, commandId, deviceId],
          },
        ],
        'write',
      );
      return true;
    } catch {
      return false;
    }
  }

  async saveCommandResult(commandId: string, record: unknown): Promise<void> {
    await (await this.db()).execute({
      sql: 'UPDATE remote_commands SET record = ? WHERE command_id = ?',
      args: [JSON.stringify(record), commandId],
    });
  }

  getCommand<T>(commandId: string): Promise<T | null> {
    return this.one('SELECT record FROM remote_commands WHERE command_id = ?', [commandId]);
  }

  async saveConversation(conversation: RemoteConversation): Promise<void> {
    await this.upsert(
      'remote_conversations',
      ['id', 'device_id', 'status', 'updated_at', 'record'],
      [
        conversation.id,
        conversation.deviceId,
        conversation.status,
        conversation.updatedAt,
        JSON.stringify(conversation),
      ],
      ['device_id', 'status', 'updated_at', 'record'],
    );
  }

  getConversation(id: string): Promise<RemoteConversation | null> {
    return this.one('SELECT record FROM remote_conversations WHERE id = ?', [id]);
  }

  listConversations(deviceId: string): Promise<RemoteConversation[]> {
    return this.many(
      'SELECT record FROM remote_conversations WHERE device_id = ? ORDER BY updated_at DESC',
      [deviceId],
    );
  }

  async saveConversationMessage(message: RemoteConversationMessage): Promise<void> {
    await (await this.db()).execute({
      sql:
        'INSERT INTO remote_conversation_messages (id, conversation_id, sequence, created_at, record) ' +
        'VALUES (?, ?, ?, ?, ?)',
      args: [
        message.id,
        message.conversationId,
        message.sequence,
        message.createdAt,
        JSON.stringify(message),
      ],
    });
  }

  listConversationMessages(
    conversationId: string,
    limit = 200,
  ): Promise<RemoteConversationMessage[]> {
    return this.many<RemoteConversationMessage>(
      'SELECT record FROM remote_conversation_messages WHERE conversation_id = ? ' +
        'ORDER BY sequence DESC LIMIT ?',
      [conversationId, Math.max(1, Math.min(limit, 500))],
    ).then((rows) => rows.reverse());
  }

  async nextConversationSequence(conversationId: string): Promise<number> {
    const result = await (await this.db()).execute({
      sql:
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence ' +
        'FROM remote_conversation_messages WHERE conversation_id = ?',
      args: [conversationId],
    });
    return Number(result.rows[0]?.next_sequence ?? 1);
  }

  async saveIntent(intent: RemoteIntent): Promise<void> {
    await this.upsert(
      'remote_intents',
      ['id', 'device_id', 'status', 'expires_at', 'updated_at', 'record'],
      [
        intent.id,
        intent.deviceId,
        intent.status,
        intent.constraints.expiresAt,
        intent.updatedAt,
        JSON.stringify(intent),
      ],
      ['device_id', 'status', 'expires_at', 'updated_at', 'record'],
    );
  }

  getIntent(id: string): Promise<RemoteIntent | null> {
    return this.one('SELECT record FROM remote_intents WHERE id = ?', [id]);
  }

  listIntents(deviceId?: string): Promise<RemoteIntent[]> {
    return deviceId
      ? this.many<RemoteIntent>(
          'SELECT record FROM remote_intents WHERE device_id = ? ORDER BY updated_at DESC',
          [deviceId],
        )
      : this.many<RemoteIntent>('SELECT record FROM remote_intents ORDER BY updated_at DESC');
  }

  async pruneReplay(now = new Date().toISOString()): Promise<void> {
    await (await this.db()).execute({
      sql: 'DELETE FROM remote_replay_messages WHERE expires_at < ?',
      args: [now],
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

  private async upsert(
    table: string,
    columns: string[],
    values: unknown[],
    updates: string[],
  ): Promise<void> {
    const placeholders = columns.map(() => '?').join(', ');
    const assignments = updates.map((column) => `${column}=excluded.${column}`).join(', ');
    await (await this.db()).execute({
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ` +
        `ON CONFLICT(id) DO UPDATE SET ${assignments}`,
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
      `CREATE TABLE IF NOT EXISTS remote_devices (
         id TEXT PRIMARY KEY, route_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL,
         role TEXT NOT NULL, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS remote_pairings (
         id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at TEXT NOT NULL, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS remote_device_counters (
         device_id TEXT PRIMARY KEY, outbound_sequence INTEGER NOT NULL DEFAULT 0,
         inbound_sequence INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE IF NOT EXISTS remote_replay_messages (
         message_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, sequence INTEGER NOT NULL,
         expires_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS remote_commands (
         command_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, received_at TEXT NOT NULL,
         record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS remote_command_nonces (
         nonce TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL,
         received_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS remote_conversations (
         id TEXT PRIMARY KEY, device_id TEXT NOT NULL, status TEXT NOT NULL,
         updated_at TEXT NOT NULL, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS remote_conversation_messages (
         id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
         created_at TEXT NOT NULL, record TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS remote_intents (
         id TEXT PRIMARY KEY, device_id TEXT NOT NULL, status TEXT NOT NULL,
         expires_at TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL
       )`,
      'CREATE INDEX IF NOT EXISTS idx_remote_devices_status ON remote_devices(status)',
      'CREATE INDEX IF NOT EXISTS idx_remote_pairings_status ON remote_pairings(status, expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_remote_replay_expiry ON remote_replay_messages(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_remote_conversations_device ON remote_conversations(device_id, updated_at)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_message_sequence ON remote_conversation_messages(conversation_id, sequence)',
      'CREATE INDEX IF NOT EXISTS idx_remote_intents_status ON remote_intents(status, expires_at)',
    ],
    'write',
  );
}
