import Fastify, { type FastifyLoggerOptions, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { Store, id, messageColumns, getMessage, toConversation, type BotRecord, type ConversationRecord, type WebHookRecord } from './store.js';
import { AppError, Vault, hashToken, newToken, passwordHash, passwordMatches } from './security.js';
import { Gateway } from './gateway.js';
import { WechatAdapter, PlatformError, type PlatformAdapter } from './ilink.js';
import type { WebHookMessage, WebHookMessagePage, Message, Overview } from '../shared/types.js';
import { IMAGE_BODY_LIMIT, notificationFingerprint, notificationSummary, parseNotification, type ImageDownloader } from './images.js';
import { SEND_WINDOW_CODE, SEND_WINDOW_MESSAGE } from './send-window.js';

const name = z.string().trim().min(1).max(80);
const textBody = z.object({ text: z.string().trim().min(1, '消息不能为空').max(4000, '消息最多 4000 个字符') });
const accountBody = z.object({ username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_.@-]+$/), password: z.string().min(10, '密码至少 10 位').max(128) });
const params = (request: FastifyRequest) => request.params as Record<string, string>;
const query = (request: FastifyRequest) => request.query as Record<string, string | undefined>;
const COOKIE = 'ilinker_session';
const SESSION_MS = 7 * 86_400_000;
export interface AppOptions {
  dataDir: string; encryptionKey?: string; publicOrigin?: string; cookieSecure?: boolean; localCliToken?: string;
  logger?: false | Pick<FastifyLoggerOptions, 'stream'>;
  adapter?: PlatformAdapter; startWorkers?: boolean; webDir?: string; imageDownloader?: ImageDownloader;
}

export async function createApp(options: AppOptions) {
  const app = Fastify({
    logger: options.logger === false ? false : {
      ...options.logger,
      level: 'info',
      serializers: {
        // Route templates omit tokens, path parameters, queries, headers and bodies.
        req: request => ({ method: request.method, url: request.routeOptions?.url || '[unmatched]', remoteAddress: request.ip }),
        res: reply => ({ statusCode: reply.statusCode }),
      },
    },
    bodyLimit: 32 * 1024, trustProxy: false,
  });
  const store = new Store(options.dataDir);
  const vault = new Vault(options.dataDir, options.encryptionKey);
  const gateway = new Gateway(store, vault, options.adapter || new WechatAdapter(), options.imageDownloader);
  const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin).origin : undefined;
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 10, timeWindow: '1 minute', errorResponseBuilder: () => ({ code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' }) });

  const requireBot = (botId: string) => {
    const bot = store.get<BotRecord>('SELECT * FROM bots WHERE id=? AND deleted_at IS NULL', botId);
    if (!bot) throw new AppError(404, 'BOT_NOT_FOUND', '机器人不存在');
    return bot;
  };
  const requireConversation = (botId: string) => {
    requireBot(botId);
    const conversation = store.conversation(botId);
    if (!conversation) throw new AppError(409, 'CONTEXT_REQUIRED', '请先在微信中给机器人发送消息');
    return conversation;
  };
  const requireWebHook = (webhookId: string) => {
    const webhook = store.get<WebHookRecord>('SELECT * FROM webhooks WHERE id=?', webhookId);
    if (!webhook) throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Webhooks 不存在');
    return webhook;
  };
  const sessionValid = (raw?: string) => !!raw && !!store.get('SELECT hash FROM sessions WHERE hash=? AND expires_at>?', hashToken(raw), Date.now());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite === 'cross-site') throw new AppError(403, 'INVALID_ORIGIN', '不允许跨站请求');
      // Browser-provided fetch metadata survives HTTPS termination and Host rewrites.
      const browserSameOrigin = !publicOrigin && origin !== 'null' && fetchSite === 'same-origin';
      if (origin && !browserSameOrigin) {
        const expected = publicOrigin || `${request.protocol}://${request.headers.host}`;
        if (origin !== expected) throw new AppError(403, 'INVALID_ORIGIN', '请求来源不匹配');
      }
    }
    const publicPaths = ['/api/v1/auth/status', '/api/v1/auth/setup', '/api/v1/auth/login'];
    const localCli = options.localCliToken &&
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) &&
      !request.headers.origin && !request.headers['sec-fetch-site'] &&
      /^\/api\/v1\/(bots|webhooks)(\/|$)/.test(path) &&
      typeof request.headers['x-ilinker-local-cli'] === 'string' &&
      hashToken(request.headers['x-ilinker-local-cli']) === hashToken(options.localCliToken);
    if (!publicPaths.includes(path) && !localCli && !sessionValid(request.cookies[COOKIE])) throw new AppError(401, 'UNAUTHENTICATED', '请先登录后台');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION_ERROR', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error instanceof PlatformError) return reply.code(502).send({ code: 'PLATFORM_ERROR', message: error.message });
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ code: 'INVALID_REQUEST', message: statusCode === 413 ? '请求内容过大' : '请求格式不正确' });
    }
    request.log.error({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'request failed');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务处理失败，请稍后重试' });
  });

  app.get('/healthz', async () => { store.get('SELECT 1'); return { status: 'ok' }; });
  app.get('/api/v1/auth/status', async () => ({ setupRequired: !store.get('SELECT id FROM admins WHERE id=1') }));
  app.post('/api/v1/auth/setup', { config: { rateLimit: { max: 5 } } }, async (request, reply) => {
    if (store.get('SELECT id FROM admins WHERE id=1')) throw new AppError(409, 'ALREADY_INITIALIZED', '管理员已经初始化');
    const body = accountBody.parse(request.body);
    const encoded = await passwordHash(body.password);
    // Recheck after asynchronous password hashing to avoid two simultaneous initializations.
    if (store.get('SELECT id FROM admins WHERE id=1')) throw new AppError(409, 'ALREADY_INITIALIZED', '管理员已经初始化');
    store.run('INSERT INTO admins VALUES (1,?,?)', body.username, encoded);
    return reply.code(201).send({ username: body.username });
  });
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10 } } }, async (request, reply) => {
    const body = z.object({ username: z.string().trim().min(1).max(80), password: z.string().max(128) }).parse(request.body);
    const admin = store.get<{ username: string; password_hash: string }>('SELECT * FROM admins WHERE id=1');
    // Always perform password derivation, including for unknown accounts.
    const encoded = admin?.password_hash || `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await passwordMatches(body.password, encoded);
    if (!admin || admin.username !== body.username || !valid) throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
    const token = newToken();
    store.run('DELETE FROM sessions WHERE expires_at<?', Date.now());
    store.run('INSERT INTO sessions VALUES (?,?)', hashToken(token), Date.now() + SESSION_MS);
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: options.cookieSecure ?? publicOrigin?.startsWith('https:') ?? false, maxAge: SESSION_MS / 1000 });
    return { username: admin.username };
  });
  app.get('/api/v1/auth/me', async () => store.get<{ username: string }>('SELECT username FROM admins WHERE id=1'));
  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.cookies[COOKIE]) store.run('DELETE FROM sessions WHERE hash=?', hashToken(request.cookies[COOKIE]));
    reply.clearCookie(COOKIE, { path: '/' }); return { ok: true };
  });
  app.patch('/api/v1/auth/password', async (request, reply) => {
    const body = z.object({ currentPassword: z.string().max(128), newPassword: z.string().min(10).max(128) }).parse(request.body);
    const admin = store.get<{ password_hash: string }>('SELECT password_hash FROM admins WHERE id=1')!;
    if (!await passwordMatches(body.currentPassword, admin.password_hash)) throw new AppError(400, 'INVALID_PASSWORD', '当前密码不正确');
    const encoded = await passwordHash(body.newPassword);
    store.transaction(() => { store.run('UPDATE admins SET password_hash=? WHERE id=1', encoded); store.run('DELETE FROM sessions'); });
    reply.clearCookie(COOKIE, { path: '/' }); return { ok: true };
  });

  app.get('/api/v1/platforms', async () => [{ id: 'wechat_ilink', name: '微信 iLink', loginMethod: 'qrcode', capabilities: { receive: ['text', 'media_summary'], send: ['text', 'image'], groups: false } }]);
  app.get('/api/v1/bots', async () => store.bots());
  app.post('/api/v1/bots', async (request, reply) => {
    const body = z.object({ name, platform: z.literal('wechat_ilink').default('wechat_ilink'), note: z.string().max(500).default('') }).parse(request.body);
    const botId = id('bot');
    store.run('INSERT INTO bots (id,name,platform,note,created_at) VALUES (?,?,?,?,?)', botId, body.name, body.platform, body.note, Date.now());
    gateway.changed(botId); return reply.code(201).send(store.bots().find(b => b.id === botId));
  });
  app.get('/api/v1/bots/:botId', async request => { requireBot(params(request).botId); return store.bots().find(b => b.id === params(request).botId); });
  app.patch('/api/v1/bots/:botId', async request => {
    const bot = requireBot(params(request).botId);
    const body = z.object({ name: name.optional(), note: z.string().max(500).optional() }).strict().parse(request.body);
    store.run('UPDATE bots SET name=?,note=? WHERE id=?', body.name ?? bot.name, body.note ?? bot.note, bot.id);
    gateway.changed(bot.id); return store.bots().find(b => b.id === bot.id);
  });
  app.post('/api/v1/bots/:botId/login-sessions', async (request, reply) => {
    const bot = requireBot(params(request).botId); return reply.code(201).send(await gateway.createLogin(bot.id));
  });
  app.get('/api/v1/bots/:botId/login-sessions/:sessionId', async request => {
    const p = params(request); requireBot(p.botId); return gateway.login(p.botId, p.sessionId);
  });
  app.post('/api/v1/bots/:botId/login-sessions/:sessionId/verify', async request => {
    const p = params(request); requireBot(p.botId);
    const { code } = z.object({ code: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9-]+$/) }).parse(request.body);
    gateway.verify(p.botId, p.sessionId, code); return { ok: true };
  });
  app.post('/api/v1/bots/:botId/connect', async request => { const bot = requireBot(params(request).botId); gateway.connect(bot.id); return { ok: true }; });
  app.post('/api/v1/bots/:botId/disconnect', async request => { const bot = requireBot(params(request).botId); gateway.disconnect(bot.id); return { ok: true }; });
  app.delete('/api/v1/bots/:botId/credentials', async request => { const bot = requireBot(params(request).botId); gateway.disconnect(bot.id, true); return { ok: true }; });
  app.delete('/api/v1/bots/:botId', async request => {
    const bot = requireBot(params(request).botId); gateway.disconnect(bot.id, true);
    store.transaction(() => { store.run('UPDATE bots SET deleted_at=? WHERE id=?', Date.now(), bot.id); store.run('UPDATE webhooks SET enabled=0 WHERE bot_id=?', bot.id); });
    gateway.changed(bot.id); return { ok: true };
  });
  app.get('/api/v1/bots/:botId/logs', async request => {
    requireBot(params(request).botId);
    return store.all('SELECT id,level,event,detail,created_at createdAt FROM bot_logs WHERE bot_id=? ORDER BY created_at DESC LIMIT 100', params(request).botId);
  });

  const conversationPath = '/api/v1/bots/:botId/conversation';
  app.get(conversationPath, async request => {
    const bot = requireBot(params(request).botId);
    const conversation = store.conversation(bot.id);
    return conversation ? toConversation(conversation) : null;
  });
  app.patch(`${conversationPath}`, async request => {
    const p = params(request); const conversation = requireConversation(p.botId);
    const body = z.object({ remark: z.string().max(80) }).strict().parse(request.body);
    store.run('UPDATE conversations SET remark=? WHERE id=?', body.remark, conversation.id);
    gateway.changed(p.botId); return toConversation(store.get<ConversationRecord>('SELECT * FROM conversations WHERE id=?', conversation.id)!);
  });
  app.post(`${conversationPath}/read`, async request => {
    const p = params(request); const conversation = requireConversation(p.botId);
    store.run('UPDATE conversations SET unread=0 WHERE id=?', conversation.id); gateway.changed(p.botId); return { ok: true };
  });
  app.get(`${conversationPath}/messages`, async request => {
    const p = params(request); const conversation = requireConversation(p.botId);
    const q = query(request);
    const limit = z.coerce.number().int().min(1).max(100).default(40).parse(q.limit);
    let before = Number.MAX_SAFE_INTEGER;
    if (q.before) {
      const cursor = store.get<{ seq: number }>('SELECT seq FROM messages WHERE id=? AND conversation_id=?', q.before, conversation.id);
      if (!cursor) throw new AppError(400, 'INVALID_CURSOR', '分页游标无效');
      before = cursor.seq;
    }
    const rows = store.all<Message>(`SELECT ${messageColumns} FROM messages WHERE bot_id=? AND conversation_id=? AND seq<?
      AND text LIKE ? ORDER BY seq DESC LIMIT ?`, p.botId, conversation.id, before, `%${(q.search || '').slice(0, 100)}%`, limit + 1);
    const hasMore = rows.length > limit; const items = rows.slice(0, limit).reverse();
    return { items, nextCursor: hasMore ? items[0]?.id : null };
  });
  app.post(`${conversationPath}/messages`, async (request, reply) => {
    const p = params(request); const conversation = requireConversation(p.botId);
    const body = textBody.parse(request.body);
    return reply.code(202).send(gateway.enqueue(p.botId, body.text, '后台管理员'));
  });
  app.get('/api/v1/messages/:messageId', async request => {
    const message = getMessage(store, params(request).messageId);
    if (!message) throw new AppError(404, 'MESSAGE_NOT_FOUND', '消息不存在'); return message;
  });
  app.get('/api/v1/messages/:messageId/image', async (request, reply) => {
    const media = store.get<{ data: Uint8Array; mime: string }>('SELECT data,mime FROM message_images WHERE message_id=? AND data IS NOT NULL', params(request).messageId);
    if (!media) throw new AppError(404, 'IMAGE_NOT_FOUND', '图片尚未准备好或不存在');
    return reply.type(media.mime).header('Content-Security-Policy', "default-src 'none'; sandbox").send(Buffer.from(media.data));
  });
  app.post('/api/v1/messages/:messageId/retry', async (request, reply) => {
    const message = getMessage(store, params(request).messageId);
    if (!message || message.direction !== 'out') throw new AppError(404, 'MESSAGE_NOT_FOUND', '消息不存在');
    if (message.status !== 'failed') throw new AppError(409, 'RETRY_NOT_ALLOWED', '仅明确发送失败的消息可以重试');
    requireBot(message.botId);
    // Retry the existing task, preserving the original stable client_id and WebHook association.
    const bot = requireBot(message.botId);
    const conversation = requireConversation(bot.id);
    if (!bot.enabled || !conversation.context) throw new AppError(409, 'BOT_UNAVAILABLE', '机器人未连接或会话上下文已失效');
    gateway.assertSendWindow(conversation.id);
    store.run("UPDATE messages SET status='queued',error=NULL,updated_at=? WHERE id=?", Date.now(), message.id);
    gateway.changed(message.botId); return reply.code(202).send(getMessage(store, message.id));
  });

  app.get('/api/v1/webhooks', async () => store.webhooks());
  const webhookBody = z.object({ name, botId: z.string(), rateLimit: z.number().int().min(1).max(600).default(60), expiresAt: z.number().int().positive().nullable().default(null) }).strict();
  app.post('/api/v1/webhooks', async (request, reply) => {
    const body = webhookBody.parse(request.body); requireBot(body.botId);
    const token = newToken('hk_'), webhookId = id('webhook');
    store.run(`INSERT INTO webhooks (id,name,bot_id,token_hash,token_hint,rate_limit,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      webhookId, body.name, body.botId, hashToken(token), token.slice(0, 9), body.rateLimit, body.expiresAt, Date.now());
    gateway.changed(); return reply.code(201).send({ webhook: store.webhooks().find(h => h.id === webhookId), token, path: `/webhook/message/${token}` });
  });
  app.get('/api/v1/webhooks/:webhookId', async request => { requireWebHook(params(request).webhookId); return store.webhooks().find(h => h.id === params(request).webhookId); });
  app.get('/api/v1/webhooks/:webhookId/messages', async (request): Promise<WebHookMessagePage> => {
    const webhook = requireWebHook(params(request).webhookId);
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      before: z.string().min(1).optional(), search: z.string().trim().max(100).default(''),
      type: z.enum(['text', 'image']).optional(),
      status: z.enum(['queued', 'sending', 'provider_accepted', 'failed', 'unknown']).optional(),
    }).parse(request.query);
    const conditions = ["messages.webhook_id=?", "messages.direction='out'"];
    const values: (string | number)[] = [webhook.id];
    if (q.search) { conditions.push("messages.text LIKE ? ESCAPE '\\'"); values.push(`%${q.search.replace(/[\\%_]/g, '\\$&')}%`); }
    if (q.type) { conditions.push('messages.type=?'); values.push(q.type); }
    if (q.status) { conditions.push('messages.status=?'); values.push(q.status); }
    const where = conditions.join(' AND ');
    const total = store.get<{ count: number }>(`SELECT COUNT(*) count FROM messages WHERE ${where}`, ...values)!.count;
    let before = Number.MAX_SAFE_INTEGER;
    if (q.before) {
      const cursor = store.get<{ seq: number }>("SELECT seq FROM messages WHERE id=? AND webhook_id=? AND direction='out'", q.before, webhook.id);
      if (!cursor) throw new AppError(400, 'INVALID_CURSOR', '分页游标无效或不属于该 Webhooks');
      before = cursor.seq;
    }
    const rows = store.all<Omit<WebHookMessage, 'botDeleted'> & { botDeleted: number }>(`SELECT ${messageColumns},
      b.name botName, COALESCE(NULLIF(c.remark,''),c.name) conversationName, c.peer_id peerId,
      (b.deleted_at IS NOT NULL) botDeleted FROM messages JOIN bots b ON b.id=messages.bot_id
      JOIN conversations c ON c.id=messages.conversation_id
      WHERE ${where} AND messages.seq<? ORDER BY messages.seq DESC LIMIT ?`, ...values, before, q.limit + 1);
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).reverse().map(row => ({ ...row, botDeleted: !!row.botDeleted }));
    return { items, nextCursor: hasMore ? items[0]?.id : null, total };
  });
  app.patch('/api/v1/webhooks/:webhookId', async request => {
    const webhook = requireWebHook(params(request).webhookId);
    const body = z.object({ name: name.optional(), botId: z.string().optional(), rateLimit: z.number().int().min(1).max(600).optional(),
      expiresAt: z.number().int().positive().nullable().optional(), enabled: z.boolean().optional() }).strict().parse(request.body);
    if (body.botId !== undefined) requireBot(body.botId);
    store.run('UPDATE webhooks SET name=?,bot_id=?,rate_limit=?,expires_at=?,enabled=? WHERE id=?',
      body.name ?? webhook.name, body.botId ?? webhook.bot_id, body.rateLimit ?? webhook.rate_limit,
      body.expiresAt === undefined ? webhook.expires_at : body.expiresAt, Number(body.enabled ?? !!webhook.enabled), webhook.id);
    gateway.changed(); return store.webhooks().find(h => h.id === webhook.id);
  });
  app.post('/api/v1/webhooks/:webhookId/rotate-token', async request => {
    const webhook = requireWebHook(params(request).webhookId), token = newToken('hk_');
    store.run('UPDATE webhooks SET token_hash=?,token_hint=? WHERE id=?', hashToken(token), token.slice(0, 9), webhook.id);
    gateway.changed(); return { token, path: `/webhook/message/${token}` };
  });
  app.delete('/api/v1/webhooks/:webhookId', async request => {
    const webhook = requireWebHook(params(request).webhookId);
    store.transaction(() => {
      store.run('DELETE FROM idempotency WHERE webhook_id=?', webhook.id); store.run('DELETE FROM webhook_requests WHERE webhook_id=?', webhook.id);
      store.run('DELETE FROM webhooks WHERE id=?', webhook.id);
    }); gateway.changed(); return { ok: true };
  });
  app.post('/api/v1/webhooks/:webhookId/test', { bodyLimit: IMAGE_BODY_LIMIT }, async (request, reply) => {
    const webhook = requireWebHook(params(request).webhookId);
    if (!webhook.enabled) throw new AppError(403, 'WEBHOOK_DISABLED', 'Webhooks 已停用');
    if (webhook.expires_at && webhook.expires_at <= Date.now()) throw new AppError(410, 'WEBHOOK_EXPIRED', 'Webhooks 已过期');
    const body = parseNotification(request.body);
    const { message, requestId } = store.transaction(() => {
      const message = gateway.enqueueWebhook(webhook, body, `Webhooks · ${webhook.name}（后台测试）`);
      const requestId = id('req');
      store.run('INSERT INTO webhook_requests VALUES (?,?,?,?,?,?,?,?)', requestId, webhook.id, message.id, 'queued', notificationSummary(body).slice(0, 120), null, request.ip, Date.now());
      return { message, requestId };
    });
    return reply.code(202).send({ requestId, messageId: message.id, status: message.status });
  });
  app.get('/api/v1/webhooks/:webhookId/requests', async request => { requireWebHook(params(request).webhookId); return store.requests(params(request).webhookId); });
  app.get('/api/v1/webhook-requests', async () => store.requests());

  const authenticateWebHook = (token: string) => {
    if (!/^hk_[a-zA-Z0-9_-]{43}$/.test(token)) throw new AppError(404, 'INVALID_WEBHOOK', 'Webhooks 地址无效');
    const webhook = store.get<WebHookRecord>('SELECT * FROM webhooks WHERE token_hash=?', hashToken(token));
    if (!webhook) throw new AppError(404, 'INVALID_WEBHOOK', 'Webhooks 地址无效');
    if (!webhook.enabled) throw new AppError(403, 'WEBHOOK_DISABLED', 'Webhooks 已停用');
    if (webhook.expires_at && webhook.expires_at <= Date.now()) throw new AppError(410, 'WEBHOOK_EXPIRED', 'Webhooks 已过期');
    return webhook;
  };
  app.post('/webhook/message/:token', { bodyLimit: IMAGE_BODY_LIMIT,
    onRequest: async request => { authenticateWebHook(params(request).token); },
    config: { rateLimit: { max: 300, keyGenerator: req => req.ip } } }, async (request, reply) => {
    const webhook = authenticateWebHook(params(request).token);
    let summary = '';
    try {
      const body = parseNotification(request.body); summary = notificationSummary(body).slice(0, 120);
      const key = z.string().min(1).max(128).optional().parse(request.headers['idempotency-key']);
      const fingerprint = notificationFingerprint(body);
      const existing = key && store.get<{ fingerprint: string; message_id: string; request_id: string }>('SELECT * FROM idempotency WHERE webhook_id=? AND key=? AND created_at>?', webhook.id, key, Date.now() - 86_400_000);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一个幂等键不能用于不同消息');
        const message = getMessage(store, existing.message_id);
        return reply.code(202).send({ requestId: existing.request_id, messageId: existing.message_id, status: message?.status,
          ...(message?.error ? { error: message.error, code: message.error === SEND_WINDOW_MESSAGE ? SEND_WINDOW_CODE : null } : {}) });
      }
      const count = store.get<{ count: number }>("SELECT COUNT(*) count FROM webhook_requests WHERE webhook_id=? AND created_at>? AND status<>'rejected'", webhook.id, Date.now() - 60_000)!.count;
      if (count >= webhook.rate_limit) { reply.header('Retry-After', '60'); throw new AppError(429, 'WEBHOOK_RATE_LIMITED', 'Webhooks 调用频率超过限制'); }
      const result = store.transaction(() => {
        const message = gateway.enqueueWebhook(webhook, body, `Webhooks · ${webhook.name}`);
        const requestId = id('req');
        store.run('INSERT INTO webhook_requests VALUES (?,?,?,?,?,?,?,?)', requestId, webhook.id, message.id, 'queued', summary, null, request.ip, Date.now());
        if (key) store.run('INSERT OR REPLACE INTO idempotency VALUES (?,?,?,?,?,?)', webhook.id, key, fingerprint, message.id, requestId, Date.now());
        return { requestId, messageId: message.id, status: 'queued' };
      });
      gateway.changed(webhook.bot_id); return reply.code(202).send(result);
    } catch (error) {
      store.run('INSERT INTO webhook_requests VALUES (?,?,?,?,?,?,?,?)', id('req'), webhook.id, null, 'rejected', summary,
        error instanceof AppError ? error.message : '请求内容不正确', request.ip, Date.now());
      throw error;
    }
  });
  app.get('/webhook/message/:token/status/:messageId', { config: { rateLimit: { max: 120 } } }, async request => {
    const webhook = authenticateWebHook(params(request).token), message = getMessage(store, params(request).messageId);
    if (!message || message.webhookId !== webhook.id) throw new AppError(404, 'MESSAGE_NOT_FOUND', '消息不存在');
    return { messageId: message.id, status: message.status, error: message.error,
      code: message.error === SEND_WINDOW_MESSAGE ? SEND_WINDOW_CODE : null, updatedAt: message.updatedAt };
  });

  app.get('/api/v1/overview', async (): Promise<Overview> => {
    const now = Date.now();
    const shanghaiDate = (time: number) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
    const today = Date.parse(`${shanghaiDate(now)}T00:00:00+08:00`);
    const count = (sql: string, ...values: (string | number)[]) => store.get<{ count: number }>(sql, ...values)!.count;
    const bots = store.bots();
    return {
      bots: bots.length, onlineBots: bots.filter(b => b.status === 'online').length,
      receivedToday: count("SELECT COUNT(*) count FROM messages WHERE direction='in' AND created_at>=?", today),
      sentToday: count("SELECT COUNT(*) count FROM messages WHERE direction='out' AND status='provider_accepted' AND created_at>=?", today),
      failedToday: count("SELECT COUNT(*) count FROM messages WHERE status IN ('failed','unknown') AND created_at>=?", today),
      queued: count("SELECT COUNT(*) count FROM messages WHERE status IN ('queued','sending')"), webhooks: count('SELECT COUNT(*) count FROM webhooks WHERE enabled=1'),
      recentMessages: store.all(`SELECT m.id,m.bot_id botId,m.conversation_id conversationId,m.direction,m.type,m.text,m.status,m.source,
        m.webhook_id webhookId,m.error,m.created_at createdAt,m.updated_at updatedAt,b.name botName,COALESCE(NULLIF(c.remark,''),c.name) conversationName
        FROM messages m JOIN bots b ON b.id=m.bot_id JOIN conversations c ON c.id=m.conversation_id WHERE b.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 8`),
      activity: Array.from({ length: 7 }, (_, index) => {
        const start = today - (6 - index) * 86_400_000;
        return { date: shanghaiDate(start), incoming: count("SELECT COUNT(*) count FROM messages WHERE direction='in' AND created_at>=? AND created_at<?", start, start + 86_400_000),
          outgoing: count("SELECT COUNT(*) count FROM messages WHERE direction='out' AND status='provider_accepted' AND created_at>=? AND created_at<?", start, start + 86_400_000) };
      }),
    };
  });

  app.get('/api/v1/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    const write = (data: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); };
    write({ connected: true });
    const close = () => { if (!reply.raw.destroyed) reply.raw.end(); };
    const heartbeat = setInterval(() => { if (!sessionValid(request.cookies[COOKIE])) close(); else if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 20_000);
    heartbeat.unref();
    gateway.events.on('change', write); gateway.events.on('shutdown', close);
    reply.raw.on('close', () => { clearInterval(heartbeat); gateway.events.off('change', write); gateway.events.off('shutdown', close); });
  });

  const webDir = options.webDir || resolve('dist/web');
  const hasWeb = existsSync(webDir);
  if (hasWeb) {
    await app.register(staticPlugin, { root: webDir, maxAge: 0 });
  }
  // Fastify's default 404 log includes the raw URL, which can contain a token.
  app.setNotFoundHandler((request, reply) => {
    if (hasWeb && request.method === 'GET' && request.url.split('?')[0] === '/') return reply.sendFile('index.html');
    return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' });
  });
  app.addHook('preClose', async () => { await gateway.close(); });
  app.addHook('onClose', async () => { store.close(); });
  if (options.startWorkers !== false) gateway.start();
  return { app, store, gateway, vault };
}
