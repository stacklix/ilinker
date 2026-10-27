import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { LoginSession, Message } from '../shared/types.js';
import { AppError, Vault } from './security.js';
import { Store, id, getMessage, messageColumns, type BotRecord, type ConversationRecord, type WebHookRecord } from './store.js';
import { ILINK_BASE, PlatformError, validatedBase, type Credentials, type IncomingMessage, type PlatformAdapter } from './ilink.js';
import { downloadRemoteImage, notificationSummary, type ImageDownloader, type Notification } from './images.js';
import { SEND_WINDOW_CODE, SEND_WINDOW_MESSAGE, SEND_WINDOW_MS } from './send-window.js';

interface ActiveLogin extends LoginSession { qrcode: string; baseUrl: string; code?: string; controller: AbortController }
export class Gateway {
  events = new EventEmitter();
  private polls = new Map<string, AbortController>();
  private logins = new Map<string, ActiveLogin>();
  private sending = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(public store: Store, public vault: Vault, public adapter: PlatformAdapter, private imageDownloader: ImageDownloader = downloadRemoteImage) { this.events.setMaxListeners(200); }
  changed(botId?: string) { this.events.emit('change', { botId, at: Date.now() }); }
  credentials(bot: BotRecord): Credentials {
    if (!bot.credentials || !bot.base_url) throw new AppError(409, 'BOT_NOT_LOGGED_IN', '机器人尚未登录');
    return { token: this.vault.open(bot.credentials), baseUrl: bot.base_url };
  }
  start() {
    // A process crash after send may have reached WeChat. Never automatically resend it.
    this.store.run("UPDATE messages SET status='unknown',error='网关在发送过程中重启，请确认接收情况',updated_at=? WHERE status='sending'", Date.now());
    this.store.run("UPDATE bots SET status=CASE WHEN credentials IS NULL THEN 'pending' ELSE 'stopped' END WHERE enabled=0 OR status='logging_in'");
    for (const bot of this.store.all<BotRecord>('SELECT * FROM bots WHERE enabled=1 AND credentials IS NOT NULL')) this.connect(bot.id);
    this.timer = setInterval(() => this.drain(), 500);
    this.timer.unref();
  }
  private bot(botId: string) {
    const bot = this.store.get<BotRecord>('SELECT * FROM bots WHERE id=?', botId);
    if (!bot) throw new AppError(404, 'BOT_NOT_FOUND', '机器人不存在');
    return bot;
  }
  private state(botId: string, status: string, error: string | null = null) {
    this.store.run('UPDATE bots SET status=?,last_error=? WHERE id=?', status, error, botId);
    this.changed(botId);
  }
  connect(botId: string) {
    const bot = this.bot(botId);
    const activeLogin = [...this.logins.values()].some(login => login.botId === botId && !login.controller.signal.aborted && !['confirmed', 'expired', 'error', 'verify_code_blocked'].includes(login.status));
    if (activeLogin) throw new AppError(409, 'LOGIN_IN_PROGRESS', '机器人正在扫码授权，请先完成或停止当前登录流程');
    const credentials = this.credentials(bot);
    if (this.polls.has(botId)) return;
    this.store.run('UPDATE bots SET enabled=1 WHERE id=?', botId);
    const controller = new AbortController();
    this.polls.set(botId, controller);
    this.state(botId, 'connecting');
    this.store.log(botId, 'connect', '启动微信消息连接');
    void this.poll(botId, credentials, controller).finally(() => {
      if (this.polls.get(botId) === controller) this.polls.delete(botId);
    });
  }
  disconnect(botId: string, clearCredentials = false) {
    const bot = this.bot(botId);
    this.polls.get(botId)?.abort(); this.polls.delete(botId);
    this.sending.get(botId)?.abort();
    for (const login of this.logins.values()) if (login.botId === botId) { login.controller.abort(); login.status = 'expired'; }
    this.store.transaction(() => {
      this.store.run("UPDATE bots SET enabled=0,status=?,last_error=NULL WHERE id=?", clearCredentials ? 'pending' : 'stopped', botId);
      this.store.run("UPDATE messages SET status='failed',error='机器人连接已停止',updated_at=? WHERE bot_id=? AND status='queued'", Date.now(), botId);
      if (clearCredentials) {
        this.store.run("UPDATE bots SET credentials=NULL,base_url=NULL,cursor='' WHERE id=?", botId);
        this.store.run('UPDATE conversations SET context=NULL WHERE bot_id=?', botId);
      }
    });
    this.store.log(botId, clearCredentials ? 'credentials_cleared' : 'disconnect', clearCredentials ? '已清除本地凭证和会话上下文' : '已停止消息连接');
    if (bot.credentials) void this.adapter.notify(this.credentials(bot), false).catch(() => {});
    this.changed(botId);
  }
  async createLogin(botId: string): Promise<LoginSession> {
    this.bot(botId);
    for (const [key, old] of this.logins) if (old.expiresAt < Date.now()) { old.controller.abort(); this.logins.delete(key); }
    // Fetch first so a network failure does not unnecessarily disconnect a working bot.
    const tokens = this.store.all<{ credentials: string }>('SELECT credentials FROM bots WHERE credentials IS NOT NULL ORDER BY created_at DESC LIMIT 10').map(b => this.vault.open(b.credentials));
    const qr = await this.adapter.createLogin(tokens);
    if (!qr.qrcode || !qr.qrcode_img_content) throw new AppError(502, 'INVALID_QR', '微信未返回有效二维码');
    this.bot(botId);
    this.disconnect(botId);
    const login: ActiveLogin = {
      id: id('login'), botId, status: 'wait',
      qrImage: await QRCode.toDataURL(qr.qrcode_img_content, { width: 280, margin: 2 }),
      qrContent: qr.qrcode_img_content,
      expiresAt: Date.now() + 5 * 60_000, error: null, qrcode: qr.qrcode,
      baseUrl: ILINK_BASE, controller: new AbortController(),
    };
    this.logins.set(login.id, login);
    this.state(botId, 'logging_in');
    void this.pollLogin(login);
    return this.publicLogin(login);
  }
  private publicLogin(login: ActiveLogin): LoginSession {
    return { id: login.id, botId: login.botId, status: login.status, qrImage: login.qrImage, qrContent: login.qrContent, expiresAt: login.expiresAt, error: login.error };
  }
  login(botId: string, loginId: string) {
    const login = this.logins.get(loginId);
    if (!login || login.botId !== botId) throw new AppError(404, 'LOGIN_NOT_FOUND', '登录会话已失效，请刷新二维码');
    return this.publicLogin(login);
  }
  verify(botId: string, loginId: string, code: string) {
    this.login(botId, loginId);
    const login = this.logins.get(loginId)!;
    if (login.status !== 'need_verifycode') throw new AppError(409, 'VERIFY_NOT_REQUIRED', '当前登录流程无需验证码');
    login.code = code;
  }
  private async pollLogin(login: ActiveLogin) {
    const signal = login.controller.signal;
    try {
      while (!signal.aborted && Date.now() < login.expiresAt) {
        let result;
        try {
          const code = login.code; login.code = undefined;
          result = await this.adapter.pollLogin(login.qrcode, login.baseUrl, code, signal);
          login.error = null;
        } catch (error) {
          if (signal.aborted) return;
          login.error = error instanceof PlatformError ? error.message : '扫码状态获取失败，正在重试';
          await delay(2_000, undefined, { signal }); continue;
        }
        if (signal.aborted) return;
        login.status = result.status;
        if (result.status === 'scaned_but_redirect' && result.redirect_host) login.baseUrl = validatedBase(result.redirect_host);
        if (result.status === 'confirmed') {
          if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) throw new Error('missing credentials');
          const duplicate = this.store.get<{ id: string }>('SELECT id FROM bots WHERE platform=? AND account_id=? AND id<>? AND deleted_at IS NULL', 'wechat_ilink', result.ilink_bot_id, login.botId);
          if (duplicate) { login.error = '该微信账号已连接到另一个机器人，请使用不同账号'; login.status = 'error'; break; }
          const base = validatedBase(result.baseurl || ILINK_BASE);
          const previous = this.bot(login.botId);
          if ((previous.account_id && previous.account_id !== result.ilink_bot_id) ||
              (previous.peer_id && previous.peer_id !== result.ilink_user_id)) {
            login.error = '机器人已绑定其他账号，不支持换绑。请使用原账号扫码，或新建机器人';
            login.status = 'error'; break;
          }
          this.store.transaction(() => {
            this.store.run("UPDATE bots SET credentials=?,base_url=?,account_id=?,peer_id=?,cursor='' WHERE id=?",
              this.vault.seal(result.bot_token!), base, result.ilink_bot_id!, result.ilink_user_id!, login.botId);
            this.store.run('UPDATE conversations SET context=NULL WHERE bot_id=?', login.botId);
          });
          this.store.log(login.botId, 'login', '微信扫码登录成功');
          this.connect(login.botId); return;
        }
        if (result.status === 'binded_redirect') {
          const bot = this.bot(login.botId);
          if (bot.credentials) { login.status = 'confirmed'; this.connect(bot.id); return; }
          login.status = 'error'; login.error = '该账号已经绑定，请在原机器人中重新连接'; break;
        }
        if (['expired', 'verify_code_blocked'].includes(result.status)) break;
        this.changed(login.botId);
        await delay(1_000, undefined, { signal });
      }
      if (signal.aborted) return;
      if (!['expired', 'verify_code_blocked', 'error'].includes(login.status)) login.status = 'expired';
      this.state(login.botId, this.bot(login.botId).credentials ? 'stopped' : 'pending');
    } catch {
      if (signal.aborted) return;
      login.status = 'error'; login.error = '微信登录失败，请刷新二维码重新尝试';
      this.state(login.botId, 'pending', login.error);
    }
  }
  private async poll(botId: string, credentials: Credentials, controller: AbortController) {
    const signal = controller.signal;
    let failures = 0;
    void this.adapter.notify(credentials, true).catch(() => {});
    while (!signal.aborted && !this.closed) {
      try {
        const bot = this.bot(botId);
        const updates = await this.adapter.updates(credentials, bot.cursor, signal);
        if (signal.aborted) break;
        this.store.transaction(() => {
          for (const message of updates.msgs || []) this.ingest(botId, message);
          if (updates.get_updates_buf) this.store.run('UPDATE bots SET cursor=? WHERE id=?', updates.get_updates_buf, botId);
          this.store.run("UPDATE bots SET status='online',last_error=NULL,last_seen_at=? WHERE id=?", Date.now(), botId);
        });
        if (failures || bot.status !== 'online') this.store.log(botId, 'online', '微信消息连接正常');
        failures = 0; this.changed(botId);
        await delay(150, undefined, { signal });
      } catch (error) {
        if (signal.aborted || this.closed) break;
        if (error instanceof PlatformError && error.providerCode === -14) { this.expire(botId); break; }
        failures++;
        const detail = error instanceof PlatformError ? error.message : '消息同步失败，正在重新连接';
        this.state(botId, 'reconnecting', detail);
        if (failures === 1) this.store.log(botId, 'reconnecting', detail, 'warn');
        try { await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), undefined, { signal }); } catch { break; }
      }
    }
  }
  expire(botId: string) {
    this.polls.get(botId)?.abort(); this.polls.delete(botId);
    this.store.run('UPDATE bots SET enabled=0 WHERE id=?', botId);
    this.store.run('UPDATE conversations SET context=NULL WHERE bot_id=?', botId);
    this.store.run("UPDATE messages SET status='failed',error='微信授权已失效',updated_at=? WHERE bot_id=? AND status='queued'", Date.now(), botId);
    this.state(botId, 'expired', '微信授权已失效，请重新扫码登录');
    this.store.log(botId, 'expired', '微信授权已失效，请重新扫码登录', 'error');
  }
  ingest(botId: string, incoming: IncomingMessage) {
    if (!incoming.from_user_id || (incoming.message_type !== undefined && incoming.message_type !== 1)) return;
    const peer = incoming.from_user_id;
    if (this.bot(botId).peer_id !== peer) return;
    const key = String(incoming.message_id || incoming.msg_id || incoming.client_id || createHash('sha256').update(JSON.stringify(incoming)).digest('hex'));
    if (this.store.get('SELECT id FROM messages WHERE bot_id=? AND provider_key=?', botId, key)) return;
    let conversation = this.store.conversation(botId);
    if (conversation && conversation.peer_id !== peer) return;
    if (!conversation) {
      const conversationId = id('conv');
      this.store.run('INSERT INTO conversations (id,bot_id,peer_id,name,last_message_at) VALUES (?,?,?,?,?)', conversationId, botId, peer, peer, 0);
      conversation = this.store.get<ConversationRecord>('SELECT * FROM conversations WHERE id=?', conversationId)!;
    }
    if (incoming.context_token) this.store.run('UPDATE conversations SET context=? WHERE id=?', this.vault.seal(incoming.context_token), conversation.id);
    const items = incoming.item_list || [];
    const text = items.map(item => item.text_item?.text || item.voice_item?.text ||
      ({ 2: '[图片]', 3: '[语音]', 4: `[文件] ${item.file_item?.file_name || ''}`, 5: '[视频]' }[item.type || 0]) || '[暂不支持的消息]').join('\n');
    const now = Date.now();
    const timestamp = Number(incoming.create_time_ms);
    const time = Number.isFinite(timestamp) && timestamp > 0 && timestamp < now + 86_400_000 ? timestamp : now;
    this.store.run(`INSERT INTO messages (id,bot_id,conversation_id,direction,type,text,status,source,provider_key,created_at,updated_at)
      VALUES (?,?,?,'in',?,?,'received','微信',?,?,?)`, id('msg'), botId, conversation.id,
      items.every(i => i.type === 1) ? 'text' : 'mixed', text, key, time, now);
    this.store.run(`UPDATE conversations SET unread=unread+1,
      last_message=CASE WHEN last_message_at<=? THEN ? ELSE last_message END,last_message_at=MAX(last_message_at,?) WHERE id=?`,
      time, text.slice(0, 200), time, conversation.id);
  }
  enqueue(botId: string, text: string, source: string, webhookId: string | null = null): Message {
    return this.enqueueNotification(botId, { type: 'text', text }, source, webhookId);
  }
  enqueueWebhook(webhook: WebHookRecord, notification: Notification, source: string): Message {
    return this.enqueueNotification(webhook.bot_id, notification, source, webhook.id);
  }
  assertSendWindow(conversationId: string) {
    const last = this.store.get<{ time: number | null }>("SELECT MAX(MIN(created_at,updated_at)) time FROM messages WHERE conversation_id=? AND direction='in'", conversationId)?.time;
    if (last == null || Date.now() - last >= SEND_WINDOW_MS) throw new AppError(409, SEND_WINDOW_CODE, SEND_WINDOW_MESSAGE);
  }
  enqueueNotification(botId: string, notification: Notification, source: string, webhookId: string | null = null): Message {
    const bot = this.bot(botId);
    const conversation = this.store.conversation(botId);
    if (!conversation?.context) throw new AppError(409, 'CONTEXT_REQUIRED', '请先在微信中给机器人发送消息，建立会话上下文');
    const conversationId = conversation.id;
    this.assertSendWindow(conversationId);
    if (!bot.enabled || !bot.credentials || !['online', 'connecting', 'reconnecting'].includes(bot.status)) throw new AppError(409, 'BOT_OFFLINE', '机器人未连接，请先登录并启动连接');
    const messageId = id('msg'), now = Date.now();
    const text = notificationSummary(notification);
    this.store.transaction(() => {
      this.store.run(`INSERT INTO messages (id,bot_id,conversation_id,direction,type,text,status,source,webhook_id,created_at,updated_at)
        VALUES (?,?,?,'out',?,?,'queued',?,?,?,?)`, messageId, botId, conversationId, notification.type, text, source, webhookId, now, now);
      if (notification.type === 'image') {
        const image = notification.image;
        this.store.run('INSERT INTO message_images (message_id,source_url,data,mime) VALUES (?,?,?,?)', messageId,
          'url' in image ? this.vault.seal(image.url) : null, 'data' in image ? image.data : null, 'mime' in image ? image.mime : null);
      }
      this.store.run('UPDATE conversations SET last_message=?,last_message_at=? WHERE id=?', text.slice(0, 200), now, conversationId);
    });
    this.changed(botId);
    return getMessage(this.store, messageId)!;
  }
  private drain() {
    if (this.closed) return;
    const queued = this.store.all<Message>(`SELECT ${messageColumns} FROM messages WHERE status='queued' ORDER BY seq LIMIT 100`);
    for (const message of queued) {
      if (this.sending.has(message.botId)) continue;
      const bot = this.bot(message.botId);
      if (bot.status !== 'online') {
        if (Date.now() - message.createdAt > 10 * 60_000) {
          this.store.run("UPDATE messages SET status='failed',error='等待机器人连接超时',updated_at=? WHERE id=?", Date.now(), message.id);
          this.changed(message.botId);
        }
        continue;
      }
      const controller = new AbortController();
      this.sending.set(message.botId, controller);
      void this.deliver(message, bot, controller).finally(() => this.sending.delete(message.botId));
    }
  }
  private async deliver(message: Message, bot: BotRecord, controller: AbortController) {
    this.store.run("UPDATE messages SET status='sending',updated_at=? WHERE id=?", Date.now(), message.id);
    this.changed(bot.id);
    let submitted = false;
    try {
      const conversation = this.store.get<ConversationRecord>('SELECT * FROM conversations WHERE id=? AND bot_id=?', message.conversationId, bot.id);
      if (!conversation?.context) throw new PlatformError('会话上下文已失效，请在微信中重新发一条消息');
      this.assertSendWindow(conversation.id);
      const credentials = this.credentials(bot);
      const context = this.vault.open(conversation.context);
      if (message.type === 'image') {
        if (!this.adapter.sendImage) throw new PlatformError('当前平台不支持图片发送');
        const media = this.store.get<{ data: Uint8Array | null; source_url: string | null; mime: string | null }>('SELECT * FROM message_images WHERE message_id=?', message.id);
        if (!media) throw new PlatformError('图片数据不存在');
        let bytes: Buffer | null = media.data ? Buffer.from(media.data) : null;
        if (!bytes) {
          if (!media.source_url) throw new PlatformError('图片链接不存在');
          const image = await this.imageDownloader(this.vault.open(media.source_url), controller.signal);
          bytes = image.data;
          this.store.run('UPDATE message_images SET data=?,mime=? WHERE message_id=?', image.data, image.mime, message.id);
          this.changed(bot.id);
        }
        this.assertSendWindow(conversation.id);
        controller.signal.throwIfAborted(); submitted = true;
        await this.adapter.sendImage(credentials, { peerId: conversation.peer_id, context, image: bytes, clientId: message.id }, controller.signal);
      } else {
        submitted = true;
        await this.adapter.send(credentials, { peerId: conversation.peer_id, context, text: message.text, clientId: message.id }, controller.signal);
      }
      this.store.run("UPDATE messages SET status='provider_accepted',error=NULL,updated_at=? WHERE id=?", Date.now(), message.id);
    } catch (error) {
      const definite = !submitted || (error instanceof PlatformError && error.definite);
      const detail = error instanceof PlatformError || error instanceof AppError ? error.message :
        submitted ? '发送被中断，结果待确认，请核实接收情况' : '图片准备被中断，尚未提交平台';
      this.store.run('UPDATE messages SET status=?,error=?,updated_at=? WHERE id=?', definite ? 'failed' : 'unknown', detail, Date.now(), message.id);
      if (error instanceof PlatformError && error.providerCode === -14) this.expire(bot.id);
    }
    this.changed(bot.id);
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.polls.values()) controller.abort();
    for (const login of this.logins.values()) login.controller.abort();
    for (const controller of this.sending.values()) controller.abort();
    // Allow abort-aware tasks to finish before the database is closed.
    while (this.polls.size || this.sending.size) await delay(10);
    this.events.emit('shutdown');
    this.events.removeAllListeners();
  }
}
