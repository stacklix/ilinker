import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Gateway } from './gateway.js';
import { Store } from './store.js';
import { Vault } from './security.js';
import type { PlatformAdapter } from './ilink.js';
import { SEND_WINDOW_MS, SEND_WINDOW_REMINDER_LEAD_MS, SEND_WINDOW_REMINDER_SOURCE } from './send-window.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.gateway.close(); f.store.close(); assert.ok(f.dir.startsWith(join(tmpdir(), 'ilinker-reminder-'))); await rm(f.dir, { recursive: true, force: true }); } });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ilinker-reminder-'));
  const state = { sent: [] as string[], failure: undefined as Error | undefined };
  const adapter: PlatformAdapter = {
    async createLogin() { throw new Error('not used'); }, async pollLogin() { throw new Error('not used'); },
    async updates(_credentials, _cursor, signal) { await delay(50, undefined, { signal }); return { msgs: [] }; },
    async send(_credentials, message) { state.sent.push(message.text); if (state.failure) throw state.failure; },
    async notify() {},
  };
  const store = new Store(dir), vault = new Vault(dir), gateway = new Gateway(store, vault, adapter);
  const f = { dir, store, vault, gateway, adapter, state, count: 0 };
  fixtures.push(f); return f;
}
function addBot(f: Fixture, lastAt: number | null) {
  const id = `bot_${++f.count}`, peer = `peer_${id}`;
  f.store.run("INSERT INTO bots (id,name,platform,credentials,base_url,account_id,peer_id,enabled,status,created_at) VALUES (?,?,?,?,?,?,?,1,'online',?)", id, id, 'wechat_ilink', f.vault.seal('test-platform-credential'), 'https://ilinkai.weixin.qq.com', `account_${id}`, peer, Date.now());
  if (lastAt !== null) f.gateway.ingest(id, { message_id: `inbound_${id}`, from_user_id: peer, message_type: 1, create_time_ms: lastAt, context_token: 'test-context', item_list: [{ type: 1, text_item: { text: '用户主动消息' } }] });
  return { id, peer, conversationId: f.store.conversation(id)?.id };
}
const reminders = (f: Fixture) => f.store.all<{ id: string; status: string; error: string; conversation_id: string; text: string }>('SELECT * FROM messages WHERE source=?', SEND_WINDOW_REMINDER_SOURCE);
async function eventually(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(30); } assert.fail('reminder worker did not reach expected state'); }

test('reminder starts 30 minutes before the 24 hour deadline, once per inbound window', async () => {
  const f = await fixture(), now = Date.now(), start = now - SEND_WINDOW_MS + SEND_WINDOW_REMINDER_LEAD_MS;
  const bot = addBot(f, start + 1);
  f.gateway.queueWindowReminders(now); assert.equal(reminders(f).length, 0);
  f.store.run("UPDATE messages SET created_at=?,updated_at=? WHERE conversation_id=? AND direction='in'", start, start, bot.conversationId!);
  f.gateway.queueWindowReminders(now); f.gateway.queueWindowReminders(now + 1000);
  assert.equal(reminders(f).length, 1); assert.match(reminders(f)[0].text, /30 分钟/);
  assert.match(reminders(f)[0].text, /请主动.*发送一条消息/);
  assert.equal(f.store.all('SELECT * FROM send_window_reminders').length, 1);
});

test('expired, disconnected, deleted, contextless and never-contacted bots are not reminded', async () => {
  const f = await fixture(), now = Date.now(), start = now - SEND_WINDOW_MS + SEND_WINDOW_REMINDER_LEAD_MS;
  const active = addBot(f, start), expired = addBot(f, now - SEND_WINDOW_MS), stopped = addBot(f, start), deleted = addBot(f, start), contextless = addBot(f, start);
  addBot(f, null); addBot(f, now);
  f.store.run("UPDATE bots SET enabled=0,status='stopped' WHERE id=?", stopped.id);
  f.store.run('UPDATE bots SET deleted_at=? WHERE id=?', now, deleted.id);
  f.store.run('UPDATE conversations SET context=NULL WHERE bot_id=?', contextless.id);
  f.gateway.queueWindowReminders(now);
  assert.equal(reminders(f).length, 1); assert.equal(reminders(f)[0].conversation_id, active.conversationId);
  assert.throws(() => f.gateway.assertSendWindow(expired.conversationId!), /24 小时/);
  f.store.run("UPDATE messages SET created_at=?,updated_at=? WHERE conversation_id=? AND direction='in'", now - SEND_WINDOW_MS, now - SEND_WINDOW_MS, active.conversationId!);
  assert.throws(() => f.gateway.assertSendWindow(active.conversationId!), /24 小时/); // Recent outbound reminder does not renew.
});

test('restart preserves reminder deduplication; a fresh inbound message opens a new reminder cycle', async () => {
  const f = await fixture(), now = Date.now(); const bot = addBot(f, now - SEND_WINDOW_MS + SEND_WINDOW_REMINDER_LEAD_MS);
  f.gateway.queueWindowReminders(now); await f.gateway.close(); f.store.close();
  f.store = new Store(f.dir); f.gateway = new Gateway(f.store, f.vault, f.adapter);
  f.gateway.queueWindowReminders(now + 1000); assert.equal(reminders(f).length, 1);
  f.gateway.ingest(bot.id, { message_id: 'new-reply', from_user_id: bot.peer, message_type: 1, create_time_ms: now, context_token: 'renewed-context', item_list: [{ type: 1, text_item: { text: '续期' } }] });
  f.gateway.queueWindowReminders(now); assert.equal(reminders(f).length, 1);
  f.gateway.queueWindowReminders(now + SEND_WINDOW_MS - SEND_WINDOW_REMINDER_LEAD_MS);
  assert.equal(reminders(f).length, 2);
});

test('the running worker automatically sends the reminder via the normal delivery queue', async () => {
  const f = await fixture(); addBot(f, Date.now() - SEND_WINDOW_MS + SEND_WINDOW_REMINDER_LEAD_MS);
  f.gateway.start(); await eventually(() => reminders(f)[0]?.status === 'provider_accepted');
  assert.equal(f.state.sent.length, 1); assert.match(f.state.sent[0], /续期/);
  f.gateway.queueWindowReminders(); assert.equal(reminders(f).length, 1);
});

test('an inbound reply cancels an old reminder before delivery', async () => {
  const f = await fixture(), bot = addBot(f, Date.now() - SEND_WINDOW_MS + SEND_WINDOW_REMINDER_LEAD_MS);
  f.gateway.queueWindowReminders();
  f.gateway.ingest(bot.id, { message_id: 'reply-before-delivery', from_user_id: bot.peer, message_type: 1, context_token: 'fresh-context', item_list: [{ type: 1, text_item: { text: '续期' } }] });
  f.gateway.start(); await eventually(() => reminders(f)[0]?.status === 'failed');
  assert.match(reminders(f)[0].error, /已取消旧窗口提醒/); assert.equal(f.state.sent.length, 0);
});

test('an ambiguous reminder outcome is retained and never automatically duplicated', async () => {
  const f = await fixture(); addBot(f, Date.now() - SEND_WINDOW_MS + SEND_WINDOW_REMINDER_LEAD_MS);
  f.state.failure = new Error('transport interrupted after submission'); f.gateway.start();
  await eventually(() => reminders(f)[0]?.status === 'unknown');
  f.gateway.queueWindowReminders(); await delay(600);
  assert.equal(f.state.sent.length, 1); assert.equal(reminders(f).length, 1);
});
