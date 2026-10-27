import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { Bot, LoginSession, WebHook } from '../shared/types.js';

export const CLI_HELP = `iLinker CLI — 管理运行中的通知网关

  ilinker auth setup --username <账号>          初始化管理员并登录
  ilinker auth login --username <账号>          登录已有管理员
  ilinker auth logout                          退出 CLI 登录
  ilinker bot list                             列出机器人
  ilinker bot bind --name <名称>                创建机器人并扫码绑定
  ilinker bot bind --id <机器人ID>              为已有机器人扫码或恢复原账号
  ilinker webhook list                         列出 WebHook（不返回 Token）
  ilinker webhook create --bot <ID> --name <名称> 创建 WebHook，显示一次完整地址

通用参数：
  --url <网关地址>       默认 ILINKER_URL，或本地 HOST / PORT 配置
  --session-file <路径>  CLI 登录状态文件
  --json                以 JSON 输出结果
  --help                显示帮助

认证：容器内操作机器人和 WebHook 无需登录；远程访问需登录。
交互输入隐藏密码，或通过 --password-stdin 从标准输入读取密码。
绑定：可用 --qr-file <PNG路径> 保存二维码，--timeout <秒> 设置等待时间（默认300）。
创建 WebHook：可用 --rate-limit <1-600>、--expires-at <ISO时间>、--public-url <对外地址>。
CLI 使用网关 API；请先启动服务。机器人只能恢复原绑定账号，不支持换绑。`;

export interface CliIO {
  out(text: string): void;
  info(text: string): void;
  prompt(label: string, secret: boolean, signal: AbortSignal): Promise<string>;
  passwordStdin(): Promise<string>;
}
export interface CliOptions {
  io: CliIO;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  pollMs?: number;
}
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('地址格式无效，请使用 http://host:port 或 https://host'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('网关地址必须为 HTTP(S) 源地址，不能包含用户名、密码、路径或查询参数');
  }
  return url.origin;
}
function defaultUrl(env: NodeJS.ProcessEnv) {
  if (env.ILINKER_URL) return env.ILINKER_URL;
  let host = env.HOST || '127.0.0.1';
  if (['0.0.0.0', '::', '[::]'].includes(host)) host = '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `http://${host}:${env.PORT || '3000'}`;
}
const isMissing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

class Client {
  cookie = '';
  localToken = '';
  constructor(public base: string, private file: string, private fetcher: typeof fetch, private signal: AbortSignal) {}
  async load() {
    let content: string;
    try { content = await readFile(this.file, 'utf8'); } catch (error) { if (isMissing(error)) return; throw new Error('无法读取 CLI 登录状态文件'); }
    try {
      const saved = JSON.parse(content) as { origin?: string; cookie?: string };
      if (saved.origin === this.base && typeof saved.cookie === 'string' && /^ilinker_session=[A-Za-z0-9_-]+$/.test(saved.cookie)) this.cookie = saved.cookie;
    } catch { throw new Error('CLI 登录状态文件损坏，请删除该文件后重新登录'); }
  }
  async save() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify({ origin: this.base, cookie: this.cookie }), { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(this.file, 0o600);
  }
  async forget() { this.cookie = ''; await rm(this.file, { force: true }); }
  async request<T>(method: string, path: string, body?: unknown, signal = this.signal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(`/api/v1${path}`, this.base), {
        method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { ...(this.localToken ? { 'X-iLinker-Local-CLI': this.localToken } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      if (signal.aborted) throw new Error('操作已取消或等待超时');
      throw new Error('无法连接网关，请确认服务已启动并检查 --url；CLI 不接受 HTTP 重定向');
    }
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error('网关返回了无法识别的响应'); }
    if (!response.ok) {
      const message = data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : `HTTP ${response.status}`;
      throw new HttpError(response.status, response.status === 401 ? '管理员登录已失效或账号密码错误，请执行 auth login' : message);
    }
    if (path === '/auth/login') {
      const setCookie = response.headers.getSetCookie().find(value => value.startsWith('ilinker_session='));
      const cookie = setCookie?.split(';')[0];
      if (!cookie || !/^ilinker_session=[A-Za-z0-9_-]+$/.test(cookie)) throw new Error('网关未返回有效的登录凭证');
      this.cookie = cookie;
    }
    return data as T;
  }
}

export async function runCli(args: string[], options: CliOptions): Promise<void> {
  const env = options.env || process.env, io = options.io;
  const signal = options.signal || new AbortController().signal;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    url: { type: 'string' }, 'session-file': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    username: { type: 'string' }, 'password-stdin': { type: 'boolean' }, name: { type: 'string' }, id: { type: 'string' },
    note: { type: 'string' }, 'qr-file': { type: 'string' }, timeout: { type: 'string' }, bot: { type: 'string' },
    'rate-limit': { type: 'string' }, 'expires-at': { type: 'string' }, 'public-url': { type: 'string' },
  } });
  if (values.help || positionals.length === 0) { io.out(CLI_HELP); return; }
  const command = positionals.join(' ');
  const allowed: Record<string, string[]> = {
    'auth setup': ['username', 'password-stdin'], 'auth login': ['username', 'password-stdin'], 'auth logout': [],
    'bot list': [], 'bot bind': ['name', 'id', 'note', 'qr-file', 'timeout'], 'webhook list': [],
    'webhook create': ['name', 'bot', 'rate-limit', 'expires-at', 'public-url'],
  };
  if (!(command in allowed)) throw new Error('未知命令，请运行 ilinker --help');
  for (const key of Object.keys(values)) if (!['url', 'session-file', 'json', 'help', ...allowed[command]].includes(key)) throw new Error(`${command} 不支持 --${key}`);
  const base = origin(values.url || defaultUrl(env));
  const file = resolve(values['session-file'] || env.ILINKER_SESSION_FILE || join(env.DATA_DIR || join(homedir(), '.ilinker'), 'cli-session.json'));
  const client = new Client(base, file, options.fetch || fetch, signal);
  const localOrigin = `http://127.0.0.1:${env.PORT || '3000'}`;
  if (env.ILINKER_LOCAL_CLI_FILE && base === origin(localOrigin) && /^(bot|webhook) /.test(command)) {
    try { client.localToken = (await readFile(env.ILINKER_LOCAL_CLI_FILE, 'utf8')).trim(); }
    catch { throw new Error('无法读取容器本地管理凭证，请确认容器网关服务已启动'); }
    if (!/^[A-Za-z0-9_-]{32,}$/.test(client.localToken)) throw new Error('容器本地管理凭证无效，请重启网关服务');
  } else await client.load();
  const output = (data: unknown, text: string) => io.out(values.json ? JSON.stringify(data, null, 2) : text);
  const required = (value: string | undefined, option: string) => { if (!value?.trim()) throw new Error(`需要 --${option}`); return value.trim(); };

  if (command === 'auth setup' || command === 'auth login') {
    const username = values.username?.trim() || (await io.prompt('管理员账号：', false, signal)).trim();
    const password = values['password-stdin'] ? (await io.passwordStdin()).replace(/\r?\n$/, '') : await io.prompt('密码：', true, signal);
    if (command === 'auth setup') {
      if (!values['password-stdin'] && password !== await io.prompt('再次输入密码：', true, signal)) throw new Error('两次密码不一致');
      await client.request('POST', '/auth/setup', { username, password });
    }
    await client.request('POST', '/auth/login', { username, password });
    await client.save();
    output({ username, origin: base }, `已登录：${username}\n网关：${base}`);
    return;
  }
  if (!client.cookie && !client.localToken) throw new Error('CLI 尚未登录此网关，请先执行 auth setup 或 auth login');
  if (command === 'auth logout') {
    try { await client.request('POST', '/auth/logout'); } catch (error) { if (!(error instanceof HttpError && error.status === 401)) throw error; }
    await client.forget(); output({ ok: true }, 'CLI 已退出登录'); return;
  }
  if (command === 'bot list') {
    const bots = await client.request<Bot[]>('GET', '/bots');
    output(bots, bots.length ? ['ID\t名称\t状态\t绑定账号', ...bots.map(b => `${b.id}\t${b.name}\t${b.status}\t${b.accountId || '未绑定'}`)].join('\n') : '尚未创建机器人'); return;
  }
  if (command === 'webhook list') {
    const webhooks = await client.request<WebHook[]>('GET', '/webhooks');
    output(webhooks, webhooks.length ? ['ID\t名称\t机器人\t状态', ...webhooks.map(h => `${h.id}\t${h.name}\t${h.botName}\t${h.enabled ? '已启用' : '已停用'}`)].join('\n') : '尚未创建 WebHook'); return;
  }
  if (command === 'webhook create') {
    const name = required(values.name, 'name'), botId = required(values.bot, 'bot');
    const rateLimit = Number(values['rate-limit'] || '60');
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 600) throw new Error('--rate-limit 必须为 1–600 的整数');
    const expiresAt = values['expires-at'] ? Date.parse(values['expires-at']) : null;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error('--expires-at 必须是未来的 ISO 日期时间');
    const publicOrigin = origin(values['public-url'] || env.PUBLIC_ORIGIN || base);
    const result = await client.request<{ webhook: WebHook; path: string; token: string }>('POST', '/webhooks', { name, botId, rateLimit, expiresAt });
    const url = new URL(result.path, publicOrigin).href;
    output({ ...result, url }, `WebHook：${result.webhook.name}\nID：${result.webhook.id}\nPOST ${url}\n完整地址仅在本次显示，请保存。`); return;
  }

  if (!!values.id === !!values.name) throw new Error('bot bind 需要 --name（新建）或 --id（已有机器人），二者只能选择一个');
  if (values.id && values.note !== undefined) throw new Error('--note 仅用于新建机器人');
  const seconds = Number(values.timeout || '300');
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) throw new Error('--timeout 必须为 1–900 秒');
  const bot = values.id
    ? await client.request<Bot>('GET', `/bots/${encodeURIComponent(values.id)}`)
    : await client.request<Bot>('POST', '/bots', { name: required(values.name, 'name'), note: values.note || '' });
  io.info(`机器人：${bot.name}\nID：${bot.id}`);
  const loginBase = `/bots/${encodeURIComponent(bot.id)}/login-sessions`;
  let login = await client.request<LoginSession>('POST', loginBase);
  if (values['qr-file']) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(login.qrImage)) throw new Error('网关返回的二维码图片格式无效');
    const imagePath = resolve(values['qr-file']);
    await mkdir(dirname(imagePath), { recursive: true, mode: 0o700 });
    await writeFile(imagePath, Buffer.from(login.qrImage.split(',')[1], 'base64'), { mode: 0o600, flag: 'wx' });
    io.info(`二维码已保存：${imagePath}`);
  }
  io.info(await QRCode.toString(login.qrContent, { type: 'terminal', small: true }));
  io.info('请使用微信扫码并确认授权。');
  const deadline = Math.min(Date.now() + seconds * 1000, login.expiresAt);
  const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
  let lastStatus = '', lastVerification = 0;
  try {
    while (true) {
      waitSignal.throwIfAborted();
      if (login.status === 'confirmed') {
        const connected = await client.request<Bot>('GET', `/bots/${encodeURIComponent(bot.id)}`, undefined, waitSignal);
        output(connected, `绑定成功：${connected.name}\n机器人 ID：${connected.id}\n请在微信中给机器人发送一条消息，之后即可接收 WebHook 通知。`); return;
      }
      if (['expired', 'verify_code_blocked', 'error'].includes(login.status)) throw new Error(login.error || `扫码未完成：${login.status}；可用 bot bind --id ${bot.id} 重试`);
      if (login.status !== lastStatus) { io.info(`扫码状态：${login.status}`); lastStatus = login.status; }
      if (login.status === 'need_verifycode' && Date.now() - lastVerification > 5000) {
        const code = (await io.prompt('请输入微信验证码：', true, waitSignal)).trim();
        await client.request('POST', `${loginBase}/${encodeURIComponent(login.id)}/verify`, { code }, waitSignal);
        lastVerification = Date.now();
      }
      await delay(options.pollMs ?? 1200, undefined, { signal: waitSignal });
      login = await client.request<LoginSession>('GET', `${loginBase}/${encodeURIComponent(login.id)}`, undefined, waitSignal);
    }
  } catch (error) {
    if (waitSignal.aborted) throw new Error(signal.aborted ? '操作已取消' : `扫码等待超时，可用 bot bind --id ${bot.id} 重试`);
    throw error;
  }
}
