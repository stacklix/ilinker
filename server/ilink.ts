import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import JSONBigFactory from 'json-bigint';
import { SEND_WINDOW_MESSAGE } from './send-window.js';

const JSONBig = JSONBigFactory({ storeAsString: true, protoAction: 'ignore', constructorAction: 'ignore' });
export const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
export interface Credentials { token: string; baseUrl: string }
export interface IncomingMessage {
  message_id?: string; msg_id?: string; from_user_id?: string; to_user_id?: string;
  client_id?: string; create_time_ms?: number; message_type?: number; context_token?: string;
  item_list?: { type?: number; text_item?: { text?: string }; voice_item?: { text?: string }; file_item?: { file_name?: string } }[];
}
export interface LoginResult {
  status: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string;
}
export interface PlatformAdapter {
  createLogin(tokens: string[]): Promise<{ qrcode: string; qrcode_img_content: string }>;
  pollLogin(qrcode: string, baseUrl: string, code: string | undefined, signal: AbortSignal): Promise<LoginResult>;
  updates(credentials: Credentials, cursor: string, signal: AbortSignal): Promise<{ msgs?: IncomingMessage[]; get_updates_buf?: string }>;
  send(credentials: Credentials, data: { peerId: string; context: string; text: string; clientId: string }, signal: AbortSignal): Promise<void>;
  sendImage?(credentials: Credentials, data: { peerId: string; context: string; image: Buffer; clientId: string }, signal: AbortSignal): Promise<void>;
  notify(credentials: Credentials, started: boolean): Promise<void>;
}
export class PlatformError extends Error {
  constructor(message: string, public definite = true, public providerCode?: number) { super(message); }
}
export function validatedBase(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || (url.port && url.port !== '443')) {
    throw new PlatformError('微信返回了不受支持的服务地址');
  }
  return url.origin;
}

export class WechatAdapter implements PlatformAdapter {
  private async call<T>(base: string, path: string, body?: unknown, token?: string, signal?: AbortSignal, timeout = 45_000): Promise<T> {
    const headers: Record<string, string> = {
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    let response: Response;
    try {
      response = await fetch(new URL(path, validatedBase(base)), {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal: combined, redirect: 'error',
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new PlatformError('微信请求超时或网络不可用；若为发送请求，结果待确认', false);
    }
    if (!response.ok) throw new PlatformError(`微信服务返回 HTTP ${response.status}`, response.status < 500);
    let result: T & { ret?: number; errcode?: number; errmsg?: string };
    try { result = JSONBig.parse(await response.text()); }
    catch { throw new PlatformError('微信服务响应格式异常，结果待确认', false); }
    const errorCode = result.ret || result.errcode;
    if (errorCode) {
      // Classify explicit window errors without exposing arbitrary provider text or secrets.
      const windowExpired = path === '/ilink/bot/sendmessage' && typeof result.errmsg === 'string' &&
        /24\s*(?:小时|hours?\b|h\b)/i.test(result.errmsg) &&
        /(?:未收到|未回复|没有收到|超[过时]|过期|expired|exceed|outside|no\s+(?:message|reply)|not\s+(?:received|replied))/i.test(result.errmsg);
      throw new PlatformError(errorCode === -14 ? '微信授权已失效，请重新扫码登录' : windowExpired ? SEND_WINDOW_MESSAGE : `微信服务拒绝请求（错误码 ${errorCode}）`, true, errorCode);
    }
    return result;
  }
  private body(extra: Record<string, unknown>) {
    return { ...extra, base_info: { channel_version: '2.4.10', bot_agent: 'iLinker/0.1.0' } };
  }
  createLogin(tokens: string[]) {
    return this.call<{ qrcode: string; qrcode_img_content: string }>(ILINK_BASE,
      '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: tokens.slice(0, 10) });
  }
  pollLogin(qrcode: string, base: string, code: string | undefined, signal: AbortSignal) {
    const query = new URLSearchParams({ qrcode });
    if (code) query.set('verify_code', code);
    return this.call<LoginResult>(base, `/ilink/bot/get_qrcode_status?${query}`, undefined, undefined, signal, 38_000);
  }
  updates(credentials: Credentials, cursor: string, signal: AbortSignal) {
    return this.call<{ msgs?: IncomingMessage[]; get_updates_buf?: string }>(credentials.baseUrl,
      '/ilink/bot/getupdates', this.body({ get_updates_buf: cursor }), credentials.token, signal);
  }
  async send(credentials: Credentials, data: { peerId: string; context: string; text: string; clientId: string }, signal: AbortSignal) {
    await this.call(credentials.baseUrl, '/ilink/bot/sendmessage', this.body({ msg: {
      from_user_id: '', to_user_id: data.peerId, client_id: data.clientId,
      message_type: 2, message_state: 2, context_token: data.context,
      item_list: [{ type: 1, text_item: { text: data.text } }],
    } }), credentials.token, signal, 30_000);
  }
  async sendImage(credentials: Credentials, data: { peerId: string; context: string; image: Buffer; clientId: string }, signal: AbortSignal) {
    const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const ciphertext = Buffer.concat([cipher.update(data.image), cipher.final()]);
    let downloadParam: string;
    try {
      const upload = await this.call<{ upload_full_url?: string; upload_param?: string }>(credentials.baseUrl,
        '/ilink/bot/getuploadurl', this.body({ filekey, media_type: 1, to_user_id: data.peerId,
          rawsize: data.image.length, rawfilemd5: createHash('md5').update(data.image).digest('hex'),
          filesize: ciphertext.length, no_need_thumb: true, aeskey: key.toString('hex'),
        }), credentials.token, signal, 30_000);
      const url = upload.upload_full_url?.trim() ? new URL(upload.upload_full_url.trim()) : upload.upload_param ?
        new URL(`https://novac2c.cdn.weixin.qq.com/c2c/upload?${new URLSearchParams({ encrypted_query_param: upload.upload_param, filekey })}`) : null;
      if (!url || url.protocol !== 'https:' || !url.hostname.endsWith('.cdn.weixin.qq.com') || url.username || url.password || (url.port && url.port !== '443')) {
        throw new PlatformError('微信未返回有效的图片上传地址');
      }
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      });
      const param = response.headers.get('x-encrypted-param');
      await response.body?.cancel();
      if (response.status !== 200 || !param) throw new PlatformError('微信图片上传失败，尚未提交图片消息');
      downloadParam = param;
    } catch (error) {
      // Uploading media alone never posts a chat message. These failures are safe to retry.
      if (error instanceof PlatformError) throw new PlatformError(error.message, true, error.providerCode);
      throw new PlatformError('微信图片上传失败或中断，尚未提交图片消息');
    }
    await this.call(credentials.baseUrl, '/ilink/bot/sendmessage', this.body({ msg: {
      from_user_id: '', to_user_id: data.peerId, client_id: data.clientId, message_type: 2, message_state: 2,
      context_token: data.context, item_list: [{ type: 2, image_item: {
        media: { encrypt_query_param: downloadParam,
          // Tencent's current client encodes the hex key string as base64, rather than the raw 16 bytes.
          aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 },
        mid_size: ciphertext.length,
      } }],
    } }), credentials.token, signal, 30_000);
  }
  async notify(credentials: Credentials, started: boolean) {
    await this.call(credentials.baseUrl, `/ilink/bot/msg/notify${started ? 'start' : 'stop'}`,
      this.body({}), credentials.token, undefined, 5_000);
  }
}
