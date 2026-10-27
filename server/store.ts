import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, Conversation, WebHook, Message, WebHookRequest } from '../shared/types.js';

export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export interface BotRecord {
  id: string; name: string; platform: string; status: Bot['status']; note: string;
  credentials: string | null; base_url: string | null; account_id: string | null; peer_id: string | null;
  cursor: string; enabled: number; last_error: string | null; last_seen_at: number | null; created_at: number;
}
export interface ConversationRecord {
  id: string; bot_id: string; peer_id: string; name: string; remark: string;
  context: string | null; unread: number;
  last_message: string; last_message_at: number;
}
export interface WebHookRecord {
  id: string; name: string; bot_id: string; enabled: number;
  token_hash: string; token_hint: string; rate_limit: number; expires_at: number | null; created_at: number;
}

export class Store {
  db: DatabaseSync;
  private transactionDepth = 0;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'ilinker.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        note TEXT NOT NULL DEFAULT '', credentials TEXT, base_url TEXT, account_id TEXT, peer_id TEXT,
        cursor TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        last_seen_at INTEGER, created_at INTEGER NOT NULL, deleted_at INTEGER,
        CHECK ((account_id IS NULL) = (peer_id IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bots_account ON bots(platform, account_id) WHERE account_id IS NOT NULL AND deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id), peer_id TEXT NOT NULL,
        name TEXT NOT NULL, remark TEXT NOT NULL DEFAULT '', context TEXT,
        unread INTEGER NOT NULL DEFAULT 0,
        last_message TEXT NOT NULL DEFAULT '', last_message_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id),
        enabled INTEGER NOT NULL DEFAULT 1,
        token_hash TEXT NOT NULL UNIQUE, token_hint TEXT NOT NULL, rate_limit INTEGER NOT NULL DEFAULT 60,
        expires_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
        direction TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL,
        status TEXT NOT NULL, source TEXT NOT NULL, webhook_id TEXT,
        provider_key TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(bot_id, provider_key)
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
      CREATE INDEX IF NOT EXISTS messages_queue ON messages(status, seq);
      CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
      CREATE INDEX IF NOT EXISTS messages_webhook ON messages(webhook_id, seq);
      CREATE TABLE IF NOT EXISTS message_images (
        message_id TEXT PRIMARY KEY REFERENCES messages(id), source_url TEXT, data BLOB, mime TEXT
      );
      CREATE TABLE IF NOT EXISTS webhook_requests (
        id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id), message_id TEXT,
        status TEXT NOT NULL, summary TEXT NOT NULL, error TEXT, ip TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_webhook ON webhook_requests(webhook_id, created_at);
      CREATE TABLE IF NOT EXISTS idempotency (
        webhook_id TEXT NOT NULL REFERENCES webhooks(id), key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        message_id TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(webhook_id, key)
      );
      CREATE TABLE IF NOT EXISTS bot_logs (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), level TEXT NOT NULL,
        event TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  }
  conversation(botId: string): ConversationRecord | undefined {
    return this.get<ConversationRecord>('SELECT * FROM conversations WHERE bot_id=?', botId);
  }
  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  transaction<T>(callback: () => T): T {
    const depth = this.transactionDepth++;
    const savepoint = `ilinker_tx_${depth}`;
    try {
      this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      try { const value = callback(); this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT'); return value; }
      catch (error) { this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw error; }
    } finally { this.transactionDepth--; }
  }
  bots(): Bot[] {
    return this.all<BotRecord & { unread: number; webhookCount: number; conversationId: string | null; conversationName: string | null }>(`
      SELECT b.*, COALESCE(c.unread,0) unread,c.id conversationId,
      COALESCE(NULLIF(c.remark,''),c.name) conversationName,
      (SELECT COUNT(*) FROM webhooks WHERE bot_id=b.id) webhookCount
      FROM bots b LEFT JOIN conversations c ON c.bot_id=b.id
      WHERE b.deleted_at IS NULL ORDER BY b.created_at DESC`).map(b => ({
        id: b.id, name: b.name, platform: b.platform, status: b.status, note: b.note,
        accountId: b.account_id, lastError: b.last_error, lastSeenAt: b.last_seen_at,
        createdAt: b.created_at, hasCredentials: !!b.credentials, unread: b.unread,
        webhookCount: b.webhookCount, conversationId: b.conversationId, conversationName: b.conversationName,
      }));
  }
  webhooks(): WebHook[] {
    return this.all<WebHookRecord & { botName: string; conversationId: string | null; conversationName: string | null; requestCount: number; failureCount: number; lastUsedAt: number | null }>(`
      SELECT h.*, b.name botName,c.id conversationId,COALESCE(NULLIF(c.remark,''),c.name) conversationName,
      (SELECT COUNT(*) FROM webhook_requests r WHERE r.webhook_id=h.id) requestCount,
      (SELECT COUNT(*) FROM webhook_requests r LEFT JOIN messages m ON m.id=r.message_id
        WHERE r.webhook_id=h.id AND (r.status='rejected' OR m.status IN ('failed','unknown'))) failureCount,
      (SELECT MAX(created_at) FROM webhook_requests r WHERE r.webhook_id=h.id) lastUsedAt
      FROM webhooks h JOIN bots b ON b.id=h.bot_id LEFT JOIN conversations c ON c.bot_id=h.bot_id
      ORDER BY h.created_at DESC`).map(h => ({
        id: h.id, name: h.name, botId: h.bot_id, conversationId: h.conversationId,
        enabled: !!h.enabled, tokenHint: h.token_hint, rateLimit: h.rate_limit,
        expiresAt: h.expires_at, createdAt: h.created_at, botName: h.botName,
        conversationName: h.conversationName, requestCount: h.requestCount,
        failureCount: h.failureCount, lastUsedAt: h.lastUsedAt,
      }));
  }
  log(botId: string, event: string, detail: string, level = 'info') {
    this.run('INSERT INTO bot_logs VALUES (?,?,?,?,?,?)', id('log'), botId, level, event, detail, Date.now());
  }
  requests(webhookId?: string): WebHookRequest[] {
    return this.all<WebHookRequest>(`SELECT r.id,r.webhook_id webhookId,r.message_id messageId,
      COALESCE(m.status,r.status) status,r.summary,COALESCE(m.error,r.error) error,r.ip,r.created_at createdAt
      FROM webhook_requests r LEFT JOIN messages m ON m.id=r.message_id ${webhookId ? 'WHERE r.webhook_id=?' : ''}
      ORDER BY r.created_at DESC LIMIT 100`, ...(webhookId ? [webhookId] : []));
  }
  close() { this.db.close(); }
}

export const messageColumns = `messages.id,messages.bot_id botId,messages.conversation_id conversationId,messages.direction,messages.type,messages.text,messages.status,messages.source,messages.webhook_id webhookId,messages.error,messages.created_at createdAt,messages.updated_at updatedAt,
  CASE WHEN EXISTS (SELECT 1 FROM message_images media WHERE media.message_id=messages.id AND media.data IS NOT NULL)
    THEN '/api/v1/messages/' || messages.id || '/image' ELSE NULL END imageUrl`;
export function toConversation(c: ConversationRecord): Conversation {
  return { id: c.id, botId: c.bot_id, peerId: c.peer_id, name: c.name, remark: c.remark,
    unread: c.unread, lastMessage: c.last_message,
    lastMessageAt: c.last_message_at, hasContext: !!c.context };
}
export const getMessage = (store: Store, messageId: string) => store.get<Message>(`SELECT ${messageColumns} FROM messages WHERE id=?`, messageId);
