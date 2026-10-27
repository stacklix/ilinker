import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { WechatAdapter, PlatformError, validatedBase } from './ilink.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test('platform requests use current QR POST flow, authenticated JSON headers and context routing', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(String(url).includes('get_bot_qrcode') ? { qrcode: 'qr', qrcode_img_content: 'qr-content' } : { ret: 0 }), { status: 200 });
  }) as typeof fetch;
  const adapter = new WechatAdapter();
  await adapter.createLogin(['local-token']);
  await adapter.send({ token: 'bot-token', baseUrl: 'https://ilinkai.weixin.qq.com' }, { peerId: 'peer', context: 'context-token', text: '通知', clientId: 'stable-id' }, new AbortController().signal);
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { local_token_list: ['local-token'] });
  const sent = requests[1], body = JSON.parse(String(sent.init.body));
  assert.equal((sent.init.headers as Record<string, string>).Authorization, 'Bearer bot-token');
  assert.equal(body.msg.context_token, 'context-token'); assert.equal(body.msg.client_id, 'stable-id');
  assert.equal(body.msg.item_list[0].text_item.text, '通知'); assert.equal(sent.init.redirect, 'error');
});
test('unsafe platform redirect hosts are rejected before credentials can be sent', () => {
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.attacker.example', 'https://ilinkai.weixin.qq.com@attacker.example', 'http://127.0.0.1', 'https://ilinkai.weixin.qq.com:8443']) assert.throws(() => validatedBase(value));
  assert.equal(validatedBase('other.weixin.qq.com'), 'https://other.weixin.qq.com');
});
test('large provider message identifiers are parsed losslessly', async () => {
  globalThis.fetch = (async () => new Response('{"ret":0,"msgs":[{"message_id":18446744073709551615}],"get_updates_buf":"cursor"}')) as typeof fetch;
  const result = await new WechatAdapter().updates({ token: 't', baseUrl: 'https://ilinkai.weixin.qq.com' }, '', new AbortController().signal);
  assert.equal(result.msgs?.[0].message_id, '18446744073709551615');
});
test('network ambiguity differs from explicit provider rejection and credentials never appear in errors', async () => {
  const adapter = new WechatAdapter(), credentials = { token: 'super-secret', baseUrl: 'https://ilinkai.weixin.qq.com' };
  globalThis.fetch = (async () => { throw new Error('super-secret'); }) as typeof fetch;
  await assert.rejects(adapter.send(credentials, { peerId: 'peer', context: 'ctx', text: 'x', clientId: '1' }, new AbortController().signal), error => error instanceof PlatformError && !error.definite && !error.message.includes('super-secret'));
  globalThis.fetch = (async () => new Response('{"ret":-14,"errmsg":"secret response"}')) as typeof fetch;
  await assert.rejects(adapter.updates(credentials, '', new AbortController().signal), error => error instanceof PlatformError && error.definite && error.providerCode === -14 && !error.message.includes('secret response'));
});

test('image send encrypts original bytes, uploads to the CDN and submits a correctly routed image item', async () => {
  const image = Buffer.from('original-image-data-for-protocol-test');
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (String(url).includes('getuploadurl')) return new Response(JSON.stringify({ ret: 0, upload_param: 'upload-param-with+/=' }));
    if (String(url).includes('cdn.weixin.qq.com')) return new Response('', { headers: { 'x-encrypted-param': 'download-param' } });
    return new Response('{"ret":0}');
  }) as typeof fetch;
  await new WechatAdapter().sendImage({ token: 'bot-token', baseUrl: 'https://ilinkai.weixin.qq.com' }, { peerId: 'target-peer', context: 'context', clientId: 'image-stable-id', image }, new AbortController().signal);
  assert.equal(requests.length, 3);
  const upload = JSON.parse(String(requests[0].init.body));
  assert.equal(upload.media_type, 1); assert.equal(upload.to_user_id, 'target-peer');
  assert.equal(upload.rawsize, image.length); assert.equal(upload.rawfilemd5, createHash('md5').update(image).digest('hex'));
  assert.equal(upload.no_need_thumb, true);
  const encrypted = Buffer.from(requests[1].init.body as Uint8Array);
  assert.equal(encrypted.length, upload.filesize); assert.notDeepEqual(encrypted, image);
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), image);
  assert.equal((requests[1].init.headers as Record<string, string>).Authorization, undefined);
  const cdnUrl = new URL(requests[1].url); assert.equal(cdnUrl.searchParams.get('encrypted_query_param'), 'upload-param-with+/=');
  const message = JSON.parse(String(requests[2].init.body)).msg;
  assert.equal(message.client_id, 'image-stable-id'); assert.equal(message.context_token, 'context'); assert.equal(message.to_user_id, 'target-peer');
  assert.equal(message.item_list.length, 1); const item = message.item_list[0]; assert.equal(item.type, 2);
  assert.equal(item.image_item.mid_size, encrypted.length); assert.equal(item.image_item.media.encrypt_query_param, 'download-param');
  assert.equal(Buffer.from(item.image_item.media.aes_key, 'base64').toString(), upload.aeskey);
  assert.equal(item.image_item.media.encrypt_type, 1);
});

test('image CDN failures cannot be mistaken for delivery and malicious upload URLs are rejected', async () => {
  const credentials = { token: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com' };
  const data = { peerId: 'peer', context: 'context', clientId: 'id', image: Buffer.from('image') };
  for (const unsafe of [true, false]) {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (requests === 1) return new Response(JSON.stringify({ upload_full_url: unsafe ? 'https://attacker.example/upload' : 'https://novac2c.cdn.weixin.qq.com/c2c/upload' }));
      return new Response('error', { status: 500 });
    }) as typeof fetch;
    await assert.rejects(new WechatAdapter().sendImage(credentials, data, new AbortController().signal), error => error instanceof PlatformError && error.definite);
    assert.equal(requests, unsafe ? 1 : 2);
  }
});

test('network ambiguity after image submission remains unknown, unlike upload-stage failures', async () => {
  globalThis.fetch = (async (url) => {
    if (String(url).includes('getuploadurl')) return new Response('{"upload_param":"param"}');
    if (String(url).includes('cdn.weixin.qq.com')) return new Response('', { headers: { 'x-encrypted-param': 'download' } });
    throw new Error('network failed after submission');
  }) as typeof fetch;
  await assert.rejects(new WechatAdapter().sendImage({ token: 't', baseUrl: 'https://ilinkai.weixin.qq.com' },
    { peerId: 'peer', context: 'ctx', clientId: 'id', image: Buffer.from('data') }, new AbortController().signal), error => error instanceof PlatformError && !error.definite);
});

test('explicit provider 24 hour rejection is actionable and does not expose response secrets', async () => {
  const adapter = new WechatAdapter();
  for (const errmsg of ['超过24小时未收到用户消息 token=secret', 'No reply received within 24 hours secret']) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ret: -2, errmsg }))) as typeof fetch;
    await assert.rejects(adapter.send({ token: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com' },
      { peerId: 'peer', context: 'ctx', text: 'x', clientId: '1' }, new AbortController().signal),
      error => error instanceof PlatformError && error.definite && /24 小时/.test(error.message) && !error.message.includes('secret'));
  }
  globalThis.fetch = (async () => new Response(JSON.stringify({ ret: -2, errmsg: 'generic rejection' }))) as typeof fetch;
  await assert.rejects(adapter.send({ token: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com' },
    { peerId: 'peer', context: 'ctx', text: 'x', clientId: '1' }, new AbortController().signal),
    error => error instanceof PlatformError && !/24 小时/.test(error.message));
});
