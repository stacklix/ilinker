import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.js';
import { toConversation } from './store.js';
import { PlatformError, type PlatformAdapter, type IncomingMessage, type Credentials, type LoginResult } from './ilink.js';
import { hashToken, passwordHash } from './security.js';
import type { Bot, Conversation, WebHook, WebHookMessagePage, Message } from '../shared/types.js';
import { type ImageDownloader, validateImage } from './images.js';

const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8x8AAAAASUVORK5CYII=';
const imageBytes = Buffer.from(imageBase64, 'base64');

class TestAdapter implements PlatformAdapter {
  sent: { text: string; peerId: string; context: string; clientId: string }[] = [];
  sentImages: { image: Buffer; peerId: string; context: string; clientId: string }[] = [];
  incoming: IncomingMessage[] = [];
  failure?: Error;
  loginResult: LoginResult = { status: 'wait' };
  async createLogin() { return { qrcode: 'qr-test', qrcode_img_content: 'https://example.com/test-qr' }; }
  async pollLogin(_qr: string, _base: string, _code: string | undefined, signal: AbortSignal) { await delay(20, undefined, { signal }); return this.loginResult; }
  async updates(_credentials: Credentials, _cursor: string, signal: AbortSignal) {
    await delay(30, undefined, { signal }); const msgs = this.incoming.splice(0);
    return { msgs, get_updates_buf: 'persisted-cursor' };
  }
  async send(_credentials: Credentials, data: { text: string; peerId: string; context: string; clientId: string }) {
    this.sent.push(data); if (this.failure) throw this.failure;
  }
  async notify() {}
  async sendImage(_credentials: Credentials, data: { image: Buffer; peerId: string; context: string; clientId: string }) {
    this.sentImages.push(data); if (this.failure) throw this.failure;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: { app: Awaited<ReturnType<typeof createApp>>['app']; dir: string }[] = [];
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.app.close(); assert.ok(item.dir.startsWith(join(tmpdir(), 'ilinker-test-'))); await rm(item.dir, { recursive: true, force: true }); } });
async function fixture(workers = false, imageDownloader?: ImageDownloader, publicOrigin?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ilinker-test-'));
  const adapter = new TestAdapter();
  const result = await createApp({ dataDir: dir, adapter, imageDownloader, publicOrigin, startWorkers: workers, webDir: join(dir, 'no-web') });
  fixtures.push({ app: result.app, dir });
  const session = 'test-admin-session';
  result.store.run('INSERT INTO admins VALUES (1,?,?)', 'admin', await passwordHash('correct-password-123'));
  result.store.run('INSERT INTO sessions VALUES (?,?)', hashToken(session), Date.now() + 60_000);
  const headers = { cookie: `ilinker_session=${session}` };
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => result.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  const createBot = async (name = '测试机器人') => {
    const response = await request('POST', '/api/v1/bots', { name });
    assert.equal(response.statusCode, 201);
    return response.json<Bot>();
  };
  const connect = (bot: Bot, peer = 'user@im.wechat') => {
    result.store.run("UPDATE bots SET credentials=?,base_url=?,account_id=?,peer_id=?,enabled=1,status='online' WHERE id=?",
      result.vault.seal('wechat-secret-token'), 'https://ilinkai.weixin.qq.com', bot.id, peer, bot.id);
  };
  const incoming = (bot: Bot, peer = 'user@im.wechat', key = 'msg-1', text = '你好') => {
    result.gateway.ingest(bot.id, { message_id: key, from_user_id: peer, context_token: `context-${bot.id}`, message_type: 1,
      create_time_ms: Date.now() - 100, item_list: [{ type: 1, text_item: { text } }] });
    return toConversation(result.store.conversation(bot.id)!);
  };
  const createWebHook = async (bot: Bot, _conversation: unknown, rateLimit = 60) => {
    const response = await request('POST', '/api/v1/webhooks', { name: '服务器告警', botId: bot.id, rateLimit });
    assert.equal(response.statusCode, 201);
    return response.json<{ webhook: WebHook; path: string; token: string }>();
  };
  return { ...result, dir, adapter, request, headers, createBot, connect, incoming, createWebHook };
}
async function eventually(check: () => boolean, timeout = 4000) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) assert.fail('condition timed out'); await delay(20); }
}

test('first-run setup is one-time; passwords and sessions are not stored as plaintext', async () => {
  const f = await fixture(); f.store.run('DELETE FROM admins');
  assert.deepEqual((await f.app.inject('/api/v1/auth/status')).json(), { setupRequired: true });
  const setup = await f.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'owner', password: 'very-good-password' } });
  assert.equal(setup.statusCode, 201);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'other', password: 'another-password' } })).statusCode, 409);
  const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner', password: 'very-good-password' } });
  assert.equal(login.statusCode, 200); assert.match(String(login.headers['set-cookie']), /HttpOnly/); assert.match(String(login.headers['set-cookie']), /SameSite=Strict/i);
  assert.notEqual(f.store.get<{ password_hash: string }>('SELECT password_hash FROM admins')!.password_hash, 'very-good-password');
  const token = login.cookies[0].value;
  assert.ok(f.store.get('SELECT hash FROM sessions WHERE hash=?', hashToken(token)));
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner', password: 'wrong' } })).statusCode, 401);
});
test('protected routes require login and cross-origin writes are rejected', async () => {
  const f = await fixture();
  assert.equal((await f.app.inject('/api/v1/bots')).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/bots', headers: { ...f.headers, origin: 'https://attacker.example' }, payload: { name: 'bad' } })).statusCode, 403);
  assert.equal((await f.request('POST', '/api/v1/auth/logout')).statusCode, 200);
  assert.equal((await f.request('GET', '/api/v1/auth/me')).statusCode, 401);
});
test('same-origin browser requests support setup and login behind an HTTPS proxy without a public origin', async () => {
  const f = await fixture(); f.store.run('DELETE FROM admins');
  const headers = { host: 'ilinker:3000', origin: 'https://notify.example.com', 'sec-fetch-site': 'same-origin' };
  const payload = { username: 'owner', password: 'very-good-password' };
  const setup = await f.app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers, payload });
  assert.equal(setup.statusCode, 201);
  const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload });
  assert.equal(login.statusCode, 200);
  const createBot = (cookie?: string) => f.app.inject({ method: 'POST', url: '/api/v1/bots', headers: { ...headers, ...(cookie ? { cookie } : {}) }, payload: { name: 'proxy bot' } });
  assert.equal((await createBot()).statusCode, 401);
  assert.equal((await createBot(`ilinker_session=${login.cookies[0].value}`)).statusCode, 201);
});

test('cross-site and unverified mismatched origins remain blocked while direct HTTP still works', async () => {
  const f = await fixture();
  const rejectedHeaders: Record<string, string>[] = [
    { origin: 'https://attacker.example' },
    { origin: 'https://attacker.example', 'sec-fetch-site': 'same-site' },
    { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
    { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
    { origin: 'http://localhost:80', 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of rejectedHeaders) {
    const response = await f.app.inject({ method: 'POST', url: '/api/v1/bots', headers: { ...f.headers, ...headers }, payload: { name: 'blocked' } });
    assert.equal(response.statusCode, 403, JSON.stringify(headers));
    assert.equal(response.json().code, 'INVALID_ORIGIN');
  }
  const direct = await f.app.inject({ method: 'POST', url: '/api/v1/bots', headers: { ...f.headers, host: '192.168.0.10:3000', origin: 'http://192.168.0.10:3000' }, payload: { name: 'direct HTTP' } });
  assert.equal(direct.statusCode, 201);
});

test('a configured public origin is enforced even for same-origin browser requests', async () => {
  const f = await fixture(false, undefined, 'https://notify.example.com');
  const headers = { ...f.headers, host: 'ilinker:3000', 'sec-fetch-site': 'same-origin' };
  const wrong = await f.app.inject({ method: 'POST', url: '/api/v1/bots', headers: { ...headers, origin: 'https://other.example.com' }, payload: { name: 'blocked' } });
  assert.equal(wrong.statusCode, 403);
  const valid = await f.app.inject({ method: 'POST', url: '/api/v1/bots', headers: { ...headers, origin: 'https://notify.example.com' }, payload: { name: 'configured origin' } });
  assert.equal(valid.statusCode, 201);
});

test('changing password revokes all sessions and requires the current password', async () => {
  const f = await fixture();
  assert.equal((await f.request('PATCH', '/api/v1/auth/password', { currentPassword: 'wrong', newPassword: 'new-password-123' })).statusCode, 400);
  assert.equal((await f.request('PATCH', '/api/v1/auth/password', { currentPassword: 'correct-password-123', newPassword: 'new-password-123' })).statusCode, 200);
  assert.equal((await f.request('GET', '/api/v1/auth/me')).statusCode, 401);
});
test('conversations, contexts, deduplication and unread counts are scoped to each bot', async () => {
  const f = await fixture(), a = await f.createBot('A'), b = await f.createBot('B');
  f.connect(a); f.connect(b);
  const ca = f.incoming(a), cb = f.incoming(b);
  f.incoming(a);
  assert.notEqual(ca.id, cb.id);
  assert.equal(f.store.conversation(a.id)!.unread, 1);
  assert.equal(f.store.conversation(a.id)!.last_message, '你好');
  const otherMessage = f.store.get<{ id: string }>('SELECT id FROM messages WHERE bot_id=?', b.id)!;
  assert.equal((await f.request('GET', `/api/v1/bots/${a.id}/conversation/messages?before=${otherMessage.id}`)).statusCode, 400);
  assert.equal((await f.request('POST', '/api/v1/webhooks', { name: 'bad', botId: a.id, conversationId: cb.id })).statusCode, 400);
  assert.equal((await f.request('POST', `/api/v1/bots/${a.id}/conversation/read`)).statusCode, 200);
  assert.equal(f.store.conversation(a.id)!.unread, 0);
  const storedContext = f.store.get<{ context: string }>('SELECT context FROM conversations WHERE id=?', ca.id)!.context;
  assert.notEqual(storedContext, `context-${a.id}`); assert.equal(f.vault.open(storedContext), `context-${a.id}`);
});
test('history uses stable cursors without losing messages with identical timestamps', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot, 'peer');
  let conversation!: Conversation;
  for (let index = 0; index < 7; index++) conversation = f.incoming(bot, 'peer', String(index), `text-${index}`);
  const path = `/api/v1/bots/${bot.id}/conversation/messages`;
  const first = (await f.request('GET', `${path}?limit=3`)).json<{ items: Message[]; nextCursor: string }>();
  assert.deepEqual(first.items.map(m => m.text), ['text-4', 'text-5', 'text-6']);
  const second = (await f.request('GET', `${path}?limit=3&before=${first.nextCursor}`)).json<{ items: Message[]; nextCursor: string }>();
  assert.deepEqual(second.items.map(m => m.text), ['text-1', 'text-2', 'text-3']);
  assert.equal((await f.request('GET', `${path}?before=invalid`)).statusCode, 400);
  assert.equal((await f.request('GET', `${path}?search=text-2`)).json<{ items: Message[] }>().items.length, 1);
});
test('path token sends without a login cookie or Authorization header and is stored only as a hash', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot);
  const conversation = f.incoming(bot), webhook = await f.createWebHook(bot, conversation);
  assert.match(webhook.path, /^\/webhook\/message\/hk_[A-Za-z0-9_-]{43}$/);
  const response = await f.app.inject({ method: 'POST', url: webhook.path, payload: { text: '通知' } });
  assert.equal(response.statusCode, 202);
  const message = (await f.request('GET', `/api/v1/messages/${response.json().messageId}`)).json<Message>();
  assert.equal(message.botId, bot.id); assert.equal(message.conversationId, conversation.id); assert.equal(message.webhookId, webhook.webhook.id);
  assert.equal(f.store.get<{ token_hash: string }>('SELECT token_hash FROM webhooks')!.token_hash, hashToken(webhook.token));
  assert.ok(!JSON.stringify((await f.request('GET', '/api/v1/webhooks')).json()).includes(webhook.token));
  assert.equal((await f.app.inject({ method: 'POST', url: '/webhook/message/invalid', payload: { text: 'x' } })).statusCode, 404);
});
test('idempotency avoids duplicate sends and rejects changed content with the same key', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const webhook = await f.createWebHook(bot, f.incoming(bot));
  const send = (text: string) => f.app.inject({ method: 'POST', url: webhook.path, headers: { 'idempotency-key': 'event-1' }, payload: { text } });
  const first = await send('hello'), second = await send('hello');
  assert.equal(first.statusCode, 202); assert.deepEqual(first.json(), second.json());
  assert.equal((await send('different')).statusCode, 409);
  assert.equal(f.store.get<{ count: number }>("SELECT COUNT(*) count FROM messages WHERE direction='out'")!.count, 1);
});
test('WebHook rate limits, expiration, disabling and token rotation take effect', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const webhook = await f.createWebHook(bot, f.incoming(bot), 1);
  const send = (path = webhook.path) => f.app.inject({ method: 'POST', url: path, payload: { text: 'hello' } });
  assert.equal((await send()).statusCode, 202); assert.equal((await send()).statusCode, 429);
  assert.equal(f.store.requests(webhook.webhook.id).length, 2);
  await f.request('PATCH', `/api/v1/webhooks/${webhook.webhook.id}`, { enabled: false }); assert.equal((await send()).statusCode, 403);
  await f.request('PATCH', `/api/v1/webhooks/${webhook.webhook.id}`, { enabled: true, expiresAt: Date.now() - 1 }); assert.equal((await send()).statusCode, 410);
  await f.request('PATCH', `/api/v1/webhooks/${webhook.webhook.id}`, { expiresAt: null });
  const rotated = (await f.request('POST', `/api/v1/webhooks/${webhook.webhook.id}/rotate-token`)).json<{ path: string }>();
  assert.notEqual(rotated.path, webhook.path); assert.equal((await send()).statusCode, 404);
  assert.equal((await send(rotated.path)).statusCode, 429);
});
test('a WebHook can query only messages it produced', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot);
  const a = await f.createWebHook(bot, conversation), b = await f.createWebHook(bot, conversation);
  const messageId = (await f.app.inject({ method: 'POST', url: a.path, payload: { text: 'a' } })).json().messageId;
  assert.equal((await f.app.inject(`${a.path}/status/${messageId}`)).statusCode, 200);
  assert.equal((await f.app.inject(`${b.path}/status/${messageId}`)).statusCode, 404);
});
test('invalid bodies and missing contexts fail explicitly and are recorded in request logs', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot), webhook = await f.createWebHook(bot, conversation);
  assert.equal((await f.app.inject({ method: 'POST', url: webhook.path, payload: { text: ' ' } })).statusCode, 400);
  f.store.run('UPDATE conversations SET context=NULL WHERE id=?', conversation.id);
  const response = await f.app.inject({ method: 'POST', url: webhook.path, payload: { text: 'hello' } });
  assert.equal(response.statusCode, 409); assert.equal(response.json().code, 'CONTEXT_REQUIRED');
  assert.equal(f.store.requests(webhook.webhook.id).length, 2);
});
test('the worker sends queued messages with the correct bot context and stable client id', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot);
  const response = await f.request('POST', `/api/v1/bots/${bot.id}/conversation/messages`, { text: 'worker test' });
  const message = response.json<Message>();
  f.gateway.start();
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', message.id)?.status === 'provider_accepted');
  assert.deepEqual(f.adapter.sent[0], { text: 'worker test', peerId: conversation.peerId, context: `context-${bot.id}`, clientId: message.id });
  assert.equal(f.store.get<{ cursor: string }>('SELECT cursor FROM bots WHERE id=?', bot.id)?.cursor, 'persisted-cursor');
});
test('uncertain send failures are never retried automatically or manually', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot);
  f.adapter.failure = new PlatformError('network timeout', false);
  const response = await f.request('POST', `/api/v1/bots/${bot.id}/conversation/messages`, { text: 'uncertain' });
  f.gateway.start(); const message = response.json<Message>();
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', message.id)?.status === 'unknown');
  assert.equal((await f.request('POST', `/api/v1/messages/${message.id}/retry`)).statusCode, 409);
  await delay(700); assert.equal(f.adapter.sent.length, 1);
});
test('explicit failures may be retried with the same task id', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot);
  f.adapter.failure = new PlatformError('provider rejected', true);
  const message = (await f.request('POST', `/api/v1/bots/${bot.id}/conversation/messages`, { text: 'retry me' })).json<Message>();
  f.gateway.start();
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', message.id)?.status === 'failed');
  f.adapter.failure = undefined;
  assert.equal((await f.request('POST', `/api/v1/messages/${message.id}/retry`)).statusCode, 202);
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', message.id)?.status === 'provider_accepted');
  assert.equal(f.adapter.sent[0].clientId, f.adapter.sent[1].clientId);
});
test('expired authorization invalidates contexts and blocks queued sends', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot);
  const message = (await f.request('POST', `/api/v1/bots/${bot.id}/conversation/messages`, { text: 'pending' })).json<Message>();
  f.gateway.expire(bot.id);
  assert.equal(f.store.bots()[0].status, 'expired'); assert.equal(f.store.conversation(bot.id)!.context, null);
  assert.equal((await f.request('GET', `/api/v1/messages/${message.id}`)).json<Message>().status, 'failed');
});
test('deleting a bot disables its Hooks while retaining historical messages', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot), webhook = await f.createWebHook(bot, conversation);
  assert.equal((await f.request('DELETE', `/api/v1/bots/${bot.id}`)).statusCode, 200);
  assert.equal(f.store.bots().length, 0);
  assert.equal(f.store.get<{ count: number }>('SELECT COUNT(*) count FROM messages')!.count, 1);
  assert.equal((await f.app.inject({ method: 'POST', url: webhook.path, payload: { text: 'no' } })).statusCode, 403);
});
test('restart marks in-flight sends unknown and preserves encryption keys and messages', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot);
  const message = f.gateway.enqueue(bot.id, 'in-flight', '后台管理员');
  f.store.run("UPDATE messages SET status='sending' WHERE id=?", message.id);
  await f.app.close(); fixtures.splice(fixtures.findIndex(item => item.app === f.app), 1);
  const restarted = await createApp({ dataDir: f.dir, adapter: new TestAdapter(), startWorkers: true });
  fixtures.push({ app: restarted.app, dir: f.dir });
  assert.equal(restarted.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', message.id)?.status, 'unknown');
  assert.equal(restarted.vault.open(restarted.store.get<{ credentials: string }>('SELECT credentials FROM bots WHERE id=?', bot.id)!.credentials), 'wechat-secret-token');
});
test('QR login creates a real QR image and stores confirmed credentials encrypted', async () => {
  const f = await fixture(), bot = await f.createBot();
  f.adapter.loginResult = { status: 'confirmed', bot_token: 'new-secret', ilink_bot_id: 'account-id', ilink_user_id: 'user@im.wechat', baseurl: 'https://ilinkai.weixin.qq.com' };
  const response = await f.request('POST', `/api/v1/bots/${bot.id}/login-sessions`);
  assert.equal(response.statusCode, 201); assert.match(response.json().qrImage, /^data:image\/png;base64,/);
  await eventually(() => f.store.bots()[0].hasCredentials);
  const record = f.store.get<{ credentials: string }>('SELECT credentials FROM bots WHERE id=?', bot.id)!;
  assert.notEqual(record.credentials, 'new-secret'); assert.equal(f.vault.open(record.credentials), 'new-secret');
});

test('image WebHook persists Base64, deduplicates equivalent data URIs and protects local previews', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot), webhook = await f.createWebHook(bot, conversation);
  const send = (base64: string) => f.app.inject({ method: 'POST', url: webhook.path, headers: { 'idempotency-key': 'image-event' }, payload: { type: 'image', image: { base64 } } });
  const first = await send(imageBase64), second = await send(`data:image/png;base64,${imageBase64}`);
  assert.equal(first.statusCode, 202); assert.deepEqual(first.json(), second.json());
  const messageId = first.json().messageId;
  const message = (await f.request('GET', `/api/v1/messages/${messageId}`)).json<Message>();
  assert.equal(message.type, 'image'); assert.equal(message.text, '[图片]'); assert.ok(message.imageUrl);
  assert.equal((await f.app.inject(message.imageUrl!)).statusCode, 401);
  const image = await f.request('GET', message.imageUrl!);
  assert.equal(image.headers['content-type'], 'image/png'); assert.deepEqual(image.rawPayload, imageBytes);
  assert.equal(f.store.requests(webhook.webhook.id)[0].summary, '[图片]');
  f.gateway.start();
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', messageId)?.status === 'provider_accepted');
  assert.deepEqual(f.adapter.sentImages[0], { image: imageBytes, peerId: conversation.peerId, context: `context-${bot.id}`, clientId: messageId });
  assert.equal(f.adapter.sent.length, 0);
});

test('URL images download asynchronously, seal their source URL and persist bytes for retries', async () => {
  const downloads: string[] = [];
  const f = await fixture(false, async url => { downloads.push(url); return validateImage(imageBytes); });
  const bot = await f.createBot(); f.connect(bot); const webhook = await f.createWebHook(bot, f.incoming(bot));
  const url = 'https://images.example.com/private.png?signature=test-secret';
  const response = await f.app.inject({ method: 'POST', url: webhook.path, payload: { type: 'image', image: { url } } });
  assert.equal(response.statusCode, 202); assert.equal(downloads.length, 0);
  const messageId = response.json().messageId;
  const stored = f.store.get<{ source_url: string }>('SELECT source_url FROM message_images WHERE message_id=?', messageId)!;
  assert.notEqual(stored.source_url, url); assert.equal(f.vault.open(stored.source_url), url);
  assert.ok(!JSON.stringify(f.store.requests()).includes('test-secret'));
  f.adapter.failure = new PlatformError('explicit failure', true); f.gateway.start();
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', messageId)?.status === 'failed');
  f.adapter.failure = undefined;
  assert.equal((await f.request('POST', `/api/v1/messages/${messageId}/retry`)).statusCode, 202);
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', messageId)?.status === 'provider_accepted');
  assert.deepEqual(downloads, [url]); assert.equal(f.adapter.sentImages.length, 2);
});

test('image validation rejects unsafe URLs, invalid Base64 and unsupported files without creating tasks', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const webhook = await f.createWebHook(bot, f.incoming(bot));
  for (const image of [{ url: 'https://127.0.0.1/a.png' }, { url: 'http://example.com/a.png' }, { base64: 'not base64!' },
    { base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>').toString('base64') },
    { url: 'https://example.com/a.png', base64: imageBase64 }, {}]) {
    assert.equal((await f.app.inject({ method: 'POST', url: webhook.path, payload: { type: 'image', image } })).statusCode, 400);
  }
  assert.equal(f.store.get<{ count: number }>("SELECT COUNT(*) count FROM messages WHERE direction='out'")!.count, 0);
  assert.equal((await f.request('GET', '/api/v1/platforms')).json()[0].capabilities.send.includes('image'), true);
});

test('oversize images are rejected, while valid image bodies larger than the text request limit are accepted', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const webhook = await f.createWebHook(bot, f.incoming(bot));
  const large = Buffer.concat([imageBytes, Buffer.alloc(40_000)]).toString('base64');
  assert.equal((await f.app.inject({ method: 'POST', url: webhook.path, payload: { type: 'image', image: { base64: large } } })).statusCode, 202);
  const oversized = Buffer.concat([imageBytes, Buffer.alloc(8 * 1024 * 1024)]).toString('base64');
  assert.equal((await f.app.inject({ method: 'POST', url: webhook.path, payload: { type: 'image', image: { base64: oversized } } })).statusCode, 413);
});

test('download failures are marked failed before submitting a chat message', async () => {
  const f = await fixture(false, async () => { throw new Error('download interrupted'); });
  const bot = await f.createBot(); f.connect(bot); const webhook = await f.createWebHook(bot, f.incoming(bot));
  const response = await f.app.inject({ method: 'POST', url: webhook.path, payload: { type: 'image', image: { url: 'https://example.com/a.png' } } });
  const messageId = response.json().messageId; f.gateway.start();
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', messageId)?.status === 'failed');
  assert.equal(f.adapter.sentImages.length, 0);
});

test('backend WebHook tests accept images and queued images survive a database reopen', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const webhook = await f.createWebHook(bot, f.incoming(bot));
  const response = await f.request('POST', `/api/v1/webhooks/${webhook.webhook.id}/test`, { type: 'image', image: { base64: imageBase64 } });
  assert.equal(response.statusCode, 202);
  const messageId = response.json().messageId;
  await f.app.close(); fixtures.splice(fixtures.findIndex(item => item.app === f.app), 1);
  const adapter = new TestAdapter();
  const reopened = await createApp({ dataDir: f.dir, adapter, startWorkers: true });
  fixtures.push({ app: reopened.app, dir: f.dir });
  await eventually(() => adapter.sentImages.length === 1);
  assert.deepEqual(adapter.sentImages[0].image, imageBytes);
  assert.equal(adapter.sentImages[0].clientId, messageId);
});

test('WebHook history isolates Hooks sharing the same conversation and includes images and backend tests', async () => {
  const f = await fixture(), bot = await f.createBot('通知助手'); f.connect(bot);
  const conversation = f.incoming(bot), a = await f.createWebHook(bot, conversation), b = await f.createWebHook(bot, conversation);
  await f.request('PATCH', `/api/v1/bots/${bot.id}/conversation`, { remark: '通知接收人' });
  const text = await f.app.inject({ method: 'POST', url: a.path, payload: { text: 'A 的通知' } });
  const image = await f.request('POST', `/api/v1/webhooks/${a.webhook.id}/test`, { type: 'image', image: { base64: imageBase64 } });
  await f.app.inject({ method: 'POST', url: b.path, payload: { text: 'B 的通知' } });
  f.gateway.enqueue(bot.id, '管理员手动消息', '后台管理员');
  const page = (await f.request('GET', `/api/v1/webhooks/${a.webhook.id}/messages`)).json<WebHookMessagePage>();
  assert.equal(page.total, 2); assert.equal(page.nextCursor, null);
  assert.deepEqual(page.items.map(m => m.id), [text.json().messageId, image.json().messageId]);
  assert.deepEqual(page.items.map(m => m.type), ['text', 'image']);
  assert.equal(page.items[1].imageUrl, `/api/v1/messages/${image.json().messageId}/image`);
  for (const item of page.items) {
    assert.equal(item.webhookId, a.webhook.id); assert.equal(item.direction, 'out');
    assert.equal(item.botName, '通知助手'); assert.equal(item.conversationName, '通知接收人');
    assert.equal(item.peerId, conversation.peerId); assert.equal(item.botDeleted, false);
  }
});

test('WebHook history uses stable pagination and supports type, status and literal keyword filters', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot);
  const conversation = f.incoming(bot), webhook = await f.createWebHook(bot, conversation);
  const ids: string[] = [];
  for (let index = 0; index < 7; index++) ids.push(f.gateway.enqueue(bot.id, `任务 ${index} 完成 100%`, `WebHook · ${webhook.webhook.name}`, webhook.webhook.id).id);
  f.store.run("UPDATE messages SET status='failed',error='测试失败',created_at=1000 WHERE webhook_id=?", webhook.webhook.id);
  f.store.run("UPDATE messages SET status='provider_accepted',error=NULL WHERE id=?", ids[5]);
  const path = `/api/v1/webhooks/${webhook.webhook.id}/messages`;
  const first = (await f.request('GET', `${path}?limit=3`)).json<WebHookMessagePage>();
  assert.equal(first.total, 7); assert.deepEqual(first.items.map(m => m.id), ids.slice(4));
  const older = (await f.request('GET', `${path}?limit=3&before=${first.nextCursor}`)).json<WebHookMessagePage>();
  assert.equal(older.total, 7); assert.deepEqual(older.items.map(m => m.id), ids.slice(1, 4));
  const oldest = (await f.request('GET', `${path}?limit=3&before=${older.nextCursor}`)).json<WebHookMessagePage>();
  assert.deepEqual(oldest.items.map(m => m.id), [ids[0]]); assert.equal(oldest.nextCursor, null);
  const accepted = (await f.request('GET', `${path}?type=text&status=provider_accepted&search=${encodeURIComponent('100%')}`)).json<WebHookMessagePage>();
  assert.equal(accepted.total, 1); assert.equal(accepted.items[0].id, ids[5]);
  assert.equal((await f.request('GET', `${path}?type=image`)).json<WebHookMessagePage>().total, 0);
  assert.equal((await f.request('GET', `${path}?search=${encodeURIComponent('10_%')}`)).json<WebHookMessagePage>().total, 0);
  const foreign = await f.createWebHook(bot, conversation);
  const otherMessage = f.gateway.enqueue(bot.id, 'other', 'WebHook', foreign.webhook.id);
  assert.equal((await f.request('GET', `${path}?before=${otherMessage.id}`)).statusCode, 400);
  assert.equal((await f.request('GET', `${path}?status=received`)).statusCode, 400);
  assert.equal((await f.request('GET', `${path}?limit=101`)).statusCode, 400);
});

test('WebHook changes its bot for new sends while queued and historical destinations stay unchanged', async () => {
  const f = await fixture(), bot = await f.createBot(), other = await f.createBot('other'); f.connect(bot); f.connect(other, 'other-user');
  const conversation = f.incoming(bot), otherConversation = f.incoming(other, 'other-user');
  const webhook = await f.createWebHook(bot, conversation);
  const original = (await f.app.inject({ method: 'POST', url: webhook.path, payload: { text: '原消息' } })).json().messageId;
  assert.equal((await f.request('PATCH', `/api/v1/webhooks/${webhook.webhook.id}`, { botId: 'missing' })).statusCode, 404);
  assert.equal((await f.request('PATCH', `/api/v1/webhooks/${webhook.webhook.id}`, { name: '新名称', botId: other.id })).statusCode, 200);
  const current = (await f.app.inject({ method: 'POST', url: webhook.path, payload: { text: '新消息' } })).json().messageId;
  await f.request('POST', `/api/v1/webhooks/${webhook.webhook.id}/rotate-token`);
  await f.request('DELETE', `/api/v1/bots/${bot.id}`);
  const page = (await f.request('GET', `/api/v1/webhooks/${webhook.webhook.id}/messages`)).json<WebHookMessagePage>();
  assert.equal(page.total, 2); assert.deepEqual(page.items.map(m => m.id), [original, current]);
  assert.equal(page.items[0].botId, bot.id); assert.equal(page.items[0].botDeleted, true);
  assert.equal(page.items[0].conversationId, conversation.id);
  assert.equal(page.items[1].botId, other.id); assert.equal(page.items[1].conversationId, otherConversation.id);
});

test('WebHook history requires a backend session, validates WebHook existence and handles empty results', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot);
  const webhook = await f.createWebHook(bot, f.incoming(bot));
  const path = `/api/v1/webhooks/${webhook.webhook.id}/messages`;
  assert.equal((await f.app.inject(path)).statusCode, 401);
  assert.equal((await f.app.inject({ url: path, headers: { authorization: `Bearer ${webhook.token}` } })).statusCode, 401);
  assert.equal((await f.request('GET', '/api/v1/webhooks/nonexistent/messages')).statusCode, 404);
  assert.deepEqual((await f.request('GET', path)).json(), { items: [], nextCursor: null, total: 0 });
});

test('a WebHook can be created with just a bot before any conversation exists', async () => {
  const f = await fixture(), bot = await f.createBot();
  const created = await f.request('POST', '/api/v1/webhooks', { name: '只绑定机器人', botId: bot.id });
  assert.equal(created.statusCode, 201);
  const webhook = created.json<{ webhook: WebHook; path: string }>();
  assert.equal(webhook.webhook.conversationId, null);
  assert.equal((await f.request('GET', '/api/v1/webhooks')).json().length, 1);
  const send = await f.app.inject({ method: 'POST', url: webhook.path, payload: { text: '需要先建立会话' } });
  assert.equal(send.statusCode, 409); assert.equal(send.json().code, 'CONTEXT_REQUIRED');
});

test('a bot accepts only its bound peer and has exactly one database conversation', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot);
  f.gateway.ingest(bot.id, { message_id: 'foreign-before', from_user_id: 'foreign', context_token: 'bad', message_type: 1 });
  assert.equal(f.store.conversation(bot.id), undefined);
  const conversation = f.incoming(bot);
  const webhook = await f.createWebHook(bot, conversation);
  f.gateway.ingest(bot.id, { message_id: 'foreign-after', from_user_id: 'foreign', context_token: 'bad', message_type: 1 });
  assert.equal(f.store.get<{ count: number }>('SELECT COUNT(*) count FROM conversations WHERE bot_id=?', bot.id)!.count, 1);
  assert.equal(f.store.conversation(bot.id)!.unread, 1);
  assert.throws(() => f.store.run('INSERT INTO conversations(id,bot_id,peer_id,name,last_message_at) VALUES (?,?,?,?,?)', 'second', bot.id, 'foreign', 'foreign', Date.now()), /UNIQUE/);
  const sent = await f.app.inject({ method: 'POST', url: webhook.path, payload: { text: '唯一接收人' } });
  assert.equal(sent.statusCode, 202);
  assert.equal((await f.request('GET', `/api/v1/messages/${sent.json().messageId}`)).json<Message>().conversationId, conversation.id);
  assert.equal((await f.request('PATCH', `/api/v1/bots/${bot.id}`, { defaultConversationId: conversation.id })).statusCode, 400);
});

test('clearing credentials preserves the binding and rejects a different QR account', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot);
  await f.request('DELETE', `/api/v1/bots/${bot.id}/credentials`);
  assert.equal(f.store.bots()[0].accountId, bot.id); assert.equal(f.store.bots()[0].hasCredentials, false);
  assert.equal(f.store.conversation(bot.id)!.id, conversation.id);
  f.adapter.loginResult = { status: 'confirmed', bot_token: 'replacement', ilink_bot_id: 'another-account', ilink_user_id: 'another-user' };
  const login = (await f.request('POST', `/api/v1/bots/${bot.id}/login-sessions`)).json<{ id: string }>();
  await eventually(() => f.gateway.login(bot.id, login.id).status === 'error');
  assert.match(f.gateway.login(bot.id, login.id).error!, /不支持换绑/);
  assert.equal(f.store.bots()[0].accountId, bot.id); assert.equal(f.store.bots()[0].hasCredentials, false);
});

test('QR reconnection with the original account preserves its only conversation', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot); const conversation = f.incoming(bot);
  await f.request('DELETE', `/api/v1/bots/${bot.id}/credentials`);
  f.adapter.loginResult = { status: 'confirmed', bot_token: 'renewed', ilink_bot_id: bot.id, ilink_user_id: 'user@im.wechat' };
  const login = (await f.request('POST', `/api/v1/bots/${bot.id}/login-sessions`)).json<{ id: string }>();
  await eventually(() => f.gateway.login(bot.id, login.id).status === 'confirmed' && f.store.bots()[0].hasCredentials);
  assert.equal(f.store.conversation(bot.id)!.id, conversation.id);
  f.incoming(bot, 'user@im.wechat', 'after-reconnect');
  assert.equal(f.store.get<{ count: number }>('SELECT COUNT(*) count FROM conversations WHERE bot_id=?', bot.id)!.count, 1);
});

test('obsolete routes and removed request fields are rejected', async () => {
  const f = await fixture(), bot = await f.createBot();
  assert.equal((await f.request('GET', '/api/v1/hooks')).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'POST', url: '/hook/message/hk_' + 't'.repeat(43), payload: { text: 'obsolete' } })).statusCode, 404);
  assert.equal((await f.request('GET', `/api/v1/bots/${bot.id}/conversations`)).statusCode, 404);
  assert.equal((await f.request('POST', '/api/v1/webhooks', { name: 'bad', botId: bot.id, conversationId: 'removed' })).statusCode, 400);
});

test('Webhooks rejects text and images outside the inbound 24 hour window and recovers after a user message', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot);
  const conversation = f.incoming(bot), hook = await f.createWebHook(bot, conversation);
  f.gateway.enqueue(bot.id, 'recent outgoing message', '后台管理员');
  f.store.run("UPDATE messages SET created_at=? WHERE conversation_id=? AND direction='in'", Date.now() - 86_400_001, conversation.id);
  for (const payload of [{ text: 'expired' }, { type: 'image', image: { base64: imageBase64 } }]) {
    const response = await f.app.inject({ method: 'POST', url: hook.path, payload });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'WECHAT_SEND_WINDOW_EXPIRED');
    assert.match(response.json().message, /24 小时.*给机器人发送一条消息/);
  }
  assert.equal(f.adapter.sent.length, 0); assert.equal(f.adapter.sentImages.length, 0);
  assert.equal(f.store.requests(hook.webhook.id).filter(r => r.status === 'rejected').length, 2);
  f.incoming(bot, 'user@im.wechat', 'new-inbound');
  assert.equal((await f.app.inject({ method: 'POST', url: hook.path, payload: { text: 'recovered' } })).statusCode, 202);
});

test('queued messages expiring before delivery expose the reason through Webhook status and idempotent replay', async () => {
  const f = await fixture(), bot = await f.createBot(); f.connect(bot);
  const conversation = f.incoming(bot), hook = await f.createWebHook(bot, conversation);
  const request = { method: 'POST' as const, url: hook.path, headers: { 'idempotency-key': 'window-test' }, payload: { text: 'queued' } };
  const queued = (await f.app.inject(request)).json();
  f.store.run("UPDATE messages SET created_at=? WHERE conversation_id=? AND direction='in'", Date.now() - 86_400_000, conversation.id);
  f.gateway.start();
  await eventually(() => f.store.get<{ status: string }>('SELECT status FROM messages WHERE id=?', queued.messageId)?.status === 'failed');
  const status = (await f.app.inject(`${hook.path}/status/${queued.messageId}`)).json();
  assert.equal(status.code, 'WECHAT_SEND_WINDOW_EXPIRED'); assert.match(status.error, /24 小时/);
  const replay = (await f.app.inject(request)).json();
  assert.equal(replay.messageId, queued.messageId); assert.equal(replay.code, status.code); assert.equal(replay.error, status.error);
  const retry = await f.request('POST', `/api/v1/messages/${queued.messageId}/retry`);
  assert.equal(retry.statusCode, 409); assert.equal(retry.json().code, status.code);
  assert.equal(f.adapter.sent.length, 0);
});
