import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { AppError, hashToken, newToken, passwordMatches, type Vault } from './security.js';
import type { Store } from './store.js';

export interface HakoConfig { serverUrl: string; clientId: string; clientSecret: string }
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const startSchema = z.object({ id: token, redeemToken: token, confirmationCode: z.string().regex(/^\d{6}$/), qrPayload: z.string().max(2048), expiresAt: z.string().datetime() });
const identitySchema = z.object({ issuer: z.string(), subject: token, username: z.string().min(1).max(80), clientId: z.string(), purpose: z.enum(['bind', 'login']), sessionToken: token.optional(), expiresAt: z.string().datetime().optional() });
type Binding = { issuer: string; subject: string; username: string; version: string };
type Pending = { id: string; browserHash: string; redeem: string; passwordHash: string; configHash: string; bindingVersion?: string; sessionHash?: string; purpose: 'bind' | 'login'; expiresAt: number; busy: boolean };
const COOKIE = 'ilinker_hako_pending';
const SESSION = 'ilinker_session';
const notFound = () => new AppError(410, 'HAKO_REQUEST_EXPIRED', '二维码已失效，请刷新后重新扫码');

export function hakoConfig(env: NodeJS.ProcessEnv): HakoConfig | undefined {
  if (!env.HAKO_URL && !env.HAKO_CLIENT_ID && !env.HAKO_CLIENT_SECRET) return;
  if (!env.HAKO_URL || !env.HAKO_CLIENT_ID || !env.HAKO_CLIENT_SECRET) throw new Error('请同时配置 HAKO_URL、HAKO_CLIENT_ID 和 HAKO_CLIENT_SECRET');
  return { serverUrl: env.HAKO_URL, clientId: env.HAKO_CLIENT_ID, clientSecret: env.HAKO_CLIENT_SECRET };
}

export class HakoAuth {
  private pending = new Map<string, Pending>();
  private config?: HakoConfig;
  private configHash = '';
  private source: 'page' | 'environment' | 'none' = 'none';
  constructor(private store: Store, private vault: Vault, config?: HakoConfig, private fetcher: typeof fetch = fetch, private secure = false) {
    const saved = store?.get<{ value: string }>('SELECT value FROM hako_settings WHERE id=1');
    if (saved) { config = JSON.parse(vault.open(saved.value)) || undefined; this.source = 'page'; }
    else if (config) this.source = 'environment';
    this.configure(config);
  }
  private normalize(config: HakoConfig): HakoConfig {
    let url: URL;
    try { url = new URL(config.serverUrl); } catch { throw new Error('HAKO_URL 必须为 HTTPS 根地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[A-Za-z0-9_-]{1,80}$/.test(config.clientId) || !token.safeParse(config.clientSecret).success) throw new Error('Hako 配置无效：需 HTTPS 根地址、应用 ID 和 32 字节 Base64url 应用密钥');
    return { serverUrl: url.origin, clientId: config.clientId, clientSecret: config.clientSecret };
  }
  private configure(config?: HakoConfig) {
    this.config = config ? this.normalize(config) : undefined;
    this.configHash = this.config ? hashToken(JSON.stringify(this.config)) : '';
  }
  private settingsView() {
    return { configured: !!this.config, source: this.source, serverUrl: this.config?.serverUrl || '', clientId: this.config?.clientId || '', secretSet: !!this.config?.clientSecret, secretMask: this.config ? '••••••••••••••••' : '' };
  }
  private binding() { return this.store.get<Binding>('SELECT * FROM hako_binding WHERE id=1'); }
  enabled() { return !!this.config && this.binding()?.issuer === this.config.serverUrl; }
  private requireConfig() { if (!this.config) throw new AppError(503, 'HAKO_DISABLED', '尚未配置 Hako 登录'); return this.config; }
  private admin() { return this.store.get<{ username: string; password_hash: string }>('SELECT username,password_hash FROM admins WHERE id=1'); }
  private async request(method: string, path: string, extra: Record<string, string> = {}, body?: unknown) {
    const config = this.requireConfig();
    let response: Response;
    try {
      response = await this.fetcher(`${config.serverUrl}/api/v1/app-login${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${config.clientSecret}`, 'X-Hako-Client': config.clientId, ...extra, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new AppError(503, 'HAKO_UNAVAILABLE', '暂时无法连接 Hako，请稍后重试或使用密码登录'); }
    if (!response.ok) {
      if (response.status === 410 || response.status === 404) throw notFound();
      if (response.status === 401 || response.status === 403) throw new AppError(502, 'HAKO_REJECTED', 'Hako 应用凭证或授权已失效');
      throw new AppError(503, 'HAKO_UNAVAILABLE', 'Hako 暂时无法处理请求，请刷新重试或使用密码登录');
    }
    try { return await response.json(); } catch { throw new AppError(502, 'HAKO_INVALID_RESPONSE', 'Hako 返回了无效响应'); }
  }
  async valid(raw: string) {
    const hash = hashToken(raw);
    const session = this.store.get<{ token: string; subject: string; config_hash: string; checked_at: number }>('SELECT * FROM hako_sessions WHERE hash=?', hash);
    if (!session) return true;
    if (!this.enabled() || session.config_hash !== this.configHash || session.subject !== this.binding()?.subject) { this.store.run('DELETE FROM sessions WHERE hash=?', hash); return false; }
    if (Date.now() - session.checked_at < 60_000) return true;
    let data: unknown;
    try { data = await this.request('GET', '/session', { 'X-Hako-Session': this.vault.open(session.token) }); }
    catch (error) {
      if (error instanceof AppError && ['HAKO_REJECTED', 'HAKO_REQUEST_EXPIRED'].includes(error.code)) { this.store.run('DELETE FROM sessions WHERE hash=?', hash); return false; }
      throw error; // Outages fail closed for Hako sessions; password sessions remain independent.
    }
    const result = z.object({ active: z.literal(true), issuer: z.string(), subject: token, clientId: z.string() }).safeParse(data);
    if (!result.success || result.data.issuer !== this.config!.serverUrl || result.data.subject !== session.subject || result.data.clientId !== this.config!.clientId) { this.store.run('DELETE FROM sessions WHERE hash=?', hash); return false; }
    this.store.run('UPDATE hako_sessions SET checked_at=? WHERE hash=?', Date.now(), hash);
    return true;
  }
  async revoke(raw?: string) {
    if (!raw) return;
    const session = this.store.get<{ token: string }>('SELECT token FROM hako_sessions WHERE hash=?', hashToken(raw));
    this.store.run('DELETE FROM sessions WHERE hash=?', hashToken(raw));
    if (session) { try { await this.request('DELETE', '/session', { 'X-Hako-Session': this.vault.open(session.token) }); } catch { /* Local logout is already final. */ } }
  }
  private async reauthenticate(request: FastifyRequest) {
    const { currentPassword } = z.object({ currentPassword: z.string().max(128) }).parse(request.body);
    const admin = this.admin();
    if (!admin || !await passwordMatches(currentPassword, admin.password_hash)) throw new AppError(400, 'INVALID_PASSWORD', '当前密码不正确');
    if (this.admin()?.password_hash !== admin.password_hash || !request.cookies[SESSION] || !this.store.get('SELECT hash FROM sessions WHERE hash=? AND expires_at>?', hashToken(request.cookies[SESSION]), Date.now())) throw new AppError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
    return admin;
  }
  private async cancel(pending: Pending) {
    if (pending.configHash !== this.configHash) return;
    try { await this.request('DELETE', `/requests/${pending.id}`, { 'X-Hako-Request': pending.redeem }); } catch { /* Remote requests expire automatically. */ }
  }
  private async start(request: FastifyRequest, reply: FastifyReply, purpose: 'bind' | 'login') {
    const configHash = this.configHash;
    const config = this.requireConfig(), admin = purpose === 'bind' ? await this.reauthenticate(request) : this.admin();
    if (this.configHash !== configHash) throw notFound();
    if (!admin) throw new AppError(409, 'SETUP_REQUIRED', '请先创建本地管理员');
    const binding = this.binding();
    if (purpose === 'login' && !this.enabled()) throw new AppError(409, 'HAKO_NOT_BOUND', '请先用密码登录并绑定 Hako');
    if (purpose === 'bind' && binding) throw new AppError(409, 'HAKO_ALREADY_BOUND', '请先解除已有 Hako 绑定');
    for (const [key, pending] of this.pending) {
      if (pending.expiresAt <= Date.now()) this.pending.delete(key);
      else if (request.cookies[COOKIE] && pending.browserHash === hashToken(request.cookies[COOKIE])) { this.pending.delete(key); await this.cancel(pending); }
    }
    if (this.pending.size >= 64) throw new AppError(429, 'RATE_LIMITED', '待处理扫码请求过多，请稍后再试');
    const parsed = startSchema.safeParse(await this.request('POST', '/requests', {}, { purpose, userAgent: (request.headers['user-agent'] || '').slice(0, 512), clientIP: request.ip }));
    if (!parsed.success) throw new AppError(502, 'HAKO_INVALID_RESPONSE', 'Hako 返回了无效的扫码请求');
    const data = parsed.data, expiresAt = Date.parse(data.expiresAt), qr = new URL(data.qrPayload);
    if (expiresAt <= Date.now() || expiresAt > Date.now() + 95_000 || qr.protocol !== 'hako:' || qr.hostname !== 'web-login' || qr.username || qr.password || qr.port || qr.pathname || qr.hash || qr.searchParams.size !== 3 || qr.searchParams.get('v') !== '2' || qr.searchParams.get('server') !== config.serverUrl || qr.searchParams.get('request') !== data.id) throw new AppError(502, 'HAKO_INVALID_RESPONSE', 'Hako 返回的二维码无效');
    const browser = newToken();
    if (this.admin()?.password_hash !== admin.password_hash || this.binding()?.version !== binding?.version) throw notFound();
    const qrImage = await QRCode.toDataURL(data.qrPayload, { width: 280, margin: 2 });
    if (this.configHash !== configHash) throw notFound();
    this.pending.set(data.id, { id: data.id, browserHash: hashToken(browser), redeem: data.redeemToken, passwordHash: admin.password_hash, configHash, bindingVersion: binding?.version, purpose, expiresAt, busy: false, ...(purpose === 'bind' ? { sessionHash: hashToken(request.cookies[SESSION]!) } : {}) });
    reply.setCookie(COOKIE, browser, { path: '/api/v1/auth/hako', httpOnly: true, sameSite: 'strict', secure: this.secure, maxAge: 90 });
    return { id: data.id, qrImage, qrContent: data.qrPayload, confirmationCode: data.confirmationCode, expiresAt, purpose };
  }
  private getPending(request: FastifyRequest) {
    const { id } = request.params as { id: string }, pending = this.pending.get(id);
    if (!pending || !request.cookies[COOKIE] || pending.browserHash !== hashToken(request.cookies[COOKIE])) throw notFound();
    if (pending.configHash !== this.configHash || pending.expiresAt <= Date.now() || pending.passwordHash !== this.admin()?.password_hash || pending.bindingVersion !== this.binding()?.version || (pending.sessionHash && !this.store.get('SELECT hash FROM sessions WHERE hash=? AND expires_at>?', pending.sessionHash, Date.now()))) { this.pending.delete(id); throw notFound(); }
    return pending;
  }
  register(app: FastifyInstance) {
    app.get('/api/v1/auth/hako/settings', async () => this.settingsView());
    app.put('/api/v1/auth/hako/settings', { config: { rateLimit: { max: 8 } } }, async request => {
      const body = z.object({ serverUrl: z.string().trim().min(1).max(2048), clientId: z.string().trim().min(1).max(80), clientSecret: z.string().max(128).optional(), currentPassword: z.string().max(128) }).strict().parse(request.body);
      const admin = await this.reauthenticate(request);
      // Never forward an old secret to a different server or application.
      let server: URL;
      try { server = new URL(body.serverUrl); } catch { throw new AppError(400, 'INVALID_HAKO_CONFIG', '请填写有效的 Hako HTTPS 根地址'); }
      const keepSecret = !body.clientSecret;
      if (keepSecret && (!this.config || server.origin !== this.config.serverUrl || body.clientId !== this.config.clientId)) throw new AppError(400, 'HAKO_SECRET_REQUIRED', '首次配置或更换服务器、应用 ID 时，请填写新的 SK');
      let config: HakoConfig;
      try { config = this.normalize({ serverUrl: body.serverUrl, clientId: body.clientId, clientSecret: body.clientSecret || this.config!.clientSecret }); }
      catch { throw new AppError(400, 'INVALID_HAKO_CONFIG', '配置无效：需 HTTPS 根地址、有效的应用 ID 和 Hako 生成的 SK'); }
      const nextHash = hashToken(JSON.stringify(config));
      this.store.transaction(() => {
        if (this.admin()?.password_hash !== admin.password_hash || !this.store.get('SELECT hash FROM sessions WHERE hash=? AND expires_at>?', hashToken(request.cookies[SESSION]!), Date.now())) throw new AppError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
        this.store.run('INSERT INTO hako_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', this.vault.seal(JSON.stringify(config)));
        if (nextHash !== this.configHash) this.store.run('DELETE FROM sessions WHERE hash IN (SELECT hash FROM hako_sessions)');
        if (this.config?.serverUrl !== config.serverUrl) this.store.run('DELETE FROM hako_binding');
      });
      if (nextHash !== this.configHash) this.pending.clear();
      this.configure(config); this.source = 'page';
      return this.settingsView();
    });
    app.get('/api/v1/auth/hako/binding', async () => ({ configured: !!this.config, bound: !!this.binding(), issuer: this.binding()?.issuer || this.config?.serverUrl, username: this.binding()?.username }));
    app.post('/api/v1/auth/hako/bind', { config: { rateLimit: { max: 8 } } }, (request, reply) => this.start(request, reply, 'bind'));
    app.post('/api/v1/auth/hako/unbind', { config: { rateLimit: { max: 8 } } }, async request => {
      const admin = await this.reauthenticate(request);
      const grants = this.store.all<{ token: string }>('SELECT token FROM hako_sessions');
      this.store.transaction(() => {
        if (this.admin()?.password_hash !== admin.password_hash || !this.store.get('SELECT hash FROM sessions WHERE hash=? AND expires_at>?', hashToken(request.cookies[SESSION]!), Date.now())) throw new AppError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
        this.store.run('DELETE FROM sessions WHERE hash IN (SELECT hash FROM hako_sessions)'); this.store.run('DELETE FROM hako_binding');
      });
      const pending = [...this.pending.values()]; this.pending.clear();
      await Promise.all([...pending.map(item => this.cancel(item)), ...grants.map(async grant => { try { await this.request('DELETE', '/session', { 'X-Hako-Session': this.vault.open(grant.token) }); } catch { /* Local revocation is final even while Hako is offline. */ } })]);
      return { ok: true };
    });
    app.post('/api/v1/auth/hako/requests', { config: { rateLimit: { max: 8 } } }, (request, reply) => this.start(request, reply, 'login'));
    app.get('/api/v1/auth/hako/requests/:id', { config: { rateLimit: { max: 90 } } }, async request => {
      const pending = this.getPending(request);
      const result = z.object({ status: z.enum(['pending', 'scanned', 'approved', 'denied']) }).safeParse(await this.request('GET', `/requests/${pending.id}`, { 'X-Hako-Request': pending.redeem }));
      this.getPending(request);
      if (!result.success) throw new AppError(502, 'HAKO_INVALID_RESPONSE', 'Hako 返回了无效的扫码状态');
      return result.data;
    });
    app.delete('/api/v1/auth/hako/requests/:id', async request => { const pending = this.getPending(request); this.pending.delete(pending.id); await this.cancel(pending); return { ok: true }; });
    app.post('/api/v1/auth/hako/requests/:id/complete', { config: { rateLimit: { max: 10 } } }, async (request, reply) => {
      const pending = this.getPending(request);
      if (pending.busy) throw notFound();
      pending.busy = true;
      try {
        const result = identitySchema.safeParse(await this.request('POST', `/requests/${pending.id}/complete`, { 'X-Hako-Request': pending.redeem }, {}));
        this.getPending(request);
        const config = this.requireConfig();
        if (!result.success || result.data.issuer !== config.serverUrl || result.data.clientId !== config.clientId || result.data.purpose !== pending.purpose) throw new AppError(502, 'HAKO_INVALID_RESPONSE', 'Hako 返回的身份无效');
        const identity = result.data;
        return this.store.transaction(() => {
          this.getPending(request);
          if (pending.purpose === 'bind') {
            this.store.run('INSERT INTO hako_binding VALUES (1,?,?,?,?)', identity.issuer, identity.subject, identity.username, newToken());
            return { bound: true, username: identity.username };
          }
          const binding = this.binding();
          if (!binding || binding.issuer !== identity.issuer || binding.subject !== identity.subject) throw new AppError(403, 'HAKO_IDENTITY_MISMATCH', '该 Hako 身份未绑定当前管理员');
          const expiresAt = identity.expiresAt && Date.parse(identity.expiresAt);
          if (!identity.sessionToken || !expiresAt || expiresAt <= Date.now() || expiresAt > Date.now() + 12 * 3600_000 + 5000) throw new AppError(502, 'HAKO_INVALID_RESPONSE', 'Hako 未返回有效登录授权');
          const raw = newToken(), hash = hashToken(raw);
          this.store.run('INSERT INTO sessions VALUES (?,?)', hash, expiresAt);
          this.store.run('INSERT INTO hako_sessions VALUES (?,?,?,?,?)', hash, this.vault.seal(identity.sessionToken!), identity.subject, this.configHash, Date.now());
          reply.setCookie(SESSION, raw, { path: '/', httpOnly: true, sameSite: 'strict', secure: this.secure, maxAge: Math.floor((expiresAt - Date.now()) / 1000) });
          return { username: this.admin()!.username };
        });
      } finally { this.pending.delete(pending.id); reply.clearCookie(COOKIE, { path: '/api/v1/auth/hako' }); }
    });
    app.addHook('onClose', async () => { this.pending.clear(); });
  }
}
