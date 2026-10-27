import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { imageSize } from 'image-size';
import { z } from 'zod';
import { AppError } from './security.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_BODY_LIMIT = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4096;
export interface ImageData { data: Buffer; mime: string }
export type ImageSource = { url: string } | ImageData;
export type Notification = { type: 'text'; text: string } | { type: 'image'; image: ImageSource };
export type ImageDownloader = (url: string, signal: AbortSignal) => Promise<ImageData>;

const textInput = z.object({ type: z.literal('text').optional(), text: z.string().trim().min(1, '消息不能为空').max(4000) }).strict();
const imageInput = z.object({ type: z.literal('image'), image: z.object({ url: z.string().max(4096).optional(), base64: z.string().max(IMAGE_BODY_LIMIT).optional() })
  .strict().refine(image => Number(image.url !== undefined) + Number(image.base64 !== undefined) === 1, 'url 与 base64 必须且只能提供一个') }).strict();
export function parseNotification(input: unknown): Notification {
  const value = z.union([textInput, imageInput]).parse(input);
  if (value.type !== 'image') return { type: 'text', text: value.text };
  if (value.image.url !== undefined) return { type: 'image', image: { url: checkedImageUrl(value.image.url).href } };
  const encoded = value.image.base64!.replace(/^data:image\/(?:png|jpeg|gif|webp);base64,/i, '').replace(/\s/g, '');
  if (!encoded || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new AppError(400, 'INVALID_BASE64', '图片 Base64 格式不正确');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new AppError(400, 'INVALID_BASE64', '图片 Base64 格式不正确');
  return { type: 'image', image: validateImage(bytes) };
}
export function notificationSummary(value: Notification) { return value.type === 'text' ? value.text : '[图片]'; }
export function notificationFingerprint(value: Notification) {
  if (value.type === 'text') return createHash('sha256').update(value.text).digest('hex');
  return 'image:' + createHash('sha256').update('url' in value.image ? `url:${value.image.url}` : value.image.data).digest('hex');
}
export function validateImage(data: Buffer): ImageData {
  if (!data.length) throw new AppError(400, 'EMPTY_IMAGE', '图片不能为空');
  if (data.length > MAX_IMAGE_BYTES) throw new AppError(413, 'IMAGE_TOO_LARGE', '图片不能超过 8 MB');
  let dimensions;
  try { dimensions = imageSize(data); } catch { throw new AppError(400, 'INVALID_IMAGE', '图片无法识别，请提供 PNG、JPEG、GIF 或 WebP 图片'); }
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[dimensions.type || ''];
  if (!mime) throw new AppError(400, 'UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG、GIF 和 WebP 图片');
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 40_000_000) throw new AppError(400, 'IMAGE_DIMENSIONS', '图片尺寸无效或超过 4000 万像素');
  return { data, mime };
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['192.88.99.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function checkedImageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(400, 'INVALID_IMAGE_URL', '图片链接必须为公开可访问的 HTTPS URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host))) {
    throw new AppError(400, 'INVALID_IMAGE_URL', '图片链接仅支持公网 HTTPS 地址');
  }
  url.hash = '';
  return url;
}
export async function resolveImageTarget(url: URL, resolver: typeof lookup = lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new AppError(400, 'PRIVATE_IMAGE_URL', '图片链接不能指向本机、内网或保留地址');
  return addresses.find(entry => entry.family === 4) || addresses[0];
}

// DNS is checked on every redirect and the checked address is pinned to the TLS connection.
// The original hostname remains in SNI and certificate verification; no cookies or credentials are forwarded.
export function createImageDownloader(resolveTarget = resolveImageTarget, open = request): ImageDownloader {
  return async (value, callerSignal) => {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(20_000)]);
  const load = async (value: string, redirects: number): Promise<ImageData> => {
    signal.throwIfAborted();
    const url = checkedImageUrl(value);
    const target = await new Promise<Awaited<ReturnType<typeof resolveImageTarget>>>((resolve, reject) => {
      const abort = () => reject(new AppError(502, 'IMAGE_DOWNLOAD_FAILED', '图片下载已中断或超时'));
      signal.addEventListener('abort', abort, { once: true });
      void resolveTarget(url).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
    });
    signal.throwIfAborted();
    return new Promise<ImageData>((resolve, reject) => {
      const req = open(url, {
        method: 'GET', agent: false, signal, family: target.family,
        headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp', 'User-Agent': 'iLinker/0.1.0' },
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        },
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
          response.resume();
          if (!response.headers.location || redirects >= 3) { reject(new AppError(400, 'IMAGE_REDIRECT', '图片链接重定向次数过多或缺少目标')); return; }
          try { void load(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); }
          catch { reject(new AppError(400, 'IMAGE_REDIRECT', '图片链接的重定向地址无效')); }
          return;
        }
        if (response.statusCode !== 200) { response.resume(); reject(new AppError(502, 'IMAGE_DOWNLOAD_FAILED', `图片下载失败（HTTP ${response.statusCode}）`)); return; }
        if (Number(response.headers['content-length']) > MAX_IMAGE_BYTES) {
          reject(new AppError(413, 'IMAGE_TOO_LARGE', '图片不能超过 8 MB')); response.destroy(); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) { reject(new AppError(413, 'IMAGE_TOO_LARGE', '图片不能超过 8 MB')); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new AppError(502, 'IMAGE_DOWNLOAD_FAILED', '图片下载中断，请检查链接是否可公开访问')));
        response.on('end', () => { try { resolve(validateImage(Buffer.concat(chunks))); } catch (error) { reject(error); } });
      });
      req.on('error', () => reject(new AppError(502, 'IMAGE_DOWNLOAD_FAILED', '图片下载失败或超时，请检查链接是否可公开访问')));
      req.end();
    });
  };
  try { return await load(value, 0); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(502, 'IMAGE_DOWNLOAD_FAILED', '图片下载失败或超时，请检查链接是否可公开访问'); }
  };
}
export const downloadRemoteImage = createImageDownloader();
