import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { request as httpsRequest } from 'node:https';
import type { lookup } from 'node:dns/promises';
import { checkedImageUrl, createImageDownloader, isPublicAddress, parseNotification, resolveImageTarget, validateImage, MAX_IMAGE_BYTES } from './images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8x8AAAAASUVORK5CYII=', 'base64');

test('images are identified by their data, not a claimed extension or MIME type', () => {
  assert.equal(validateImage(png).mime, 'image/png');
  assert.throws(() => validateImage(Buffer.from('<html>error</html>')));
  assert.throws(() => validateImage(Buffer.alloc(MAX_IMAGE_BYTES + 1)));
  assert.deepEqual(parseNotification({ text: 'hello' }), { type: 'text', text: 'hello' });
  assert.equal(parseNotification({ type: 'image', image: { base64: `data:image/png;base64,${png.toString('base64')}` } }).type, 'image');
});

test('public address checks reject loopback, private, metadata, mapped IPv6 and reserved networks', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:10.1.1.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['https://2130706433/a.png', 'https://0x7f000001/a.png', 'https://[::ffff:127.0.0.1]/a.png', 'https://user:pass@example.com/a.png', 'file:///C:/a.png']) assert.throws(() => checkedImageUrl(url));
});

test('all DNS answers are checked, including a private address hidden behind a public first answer', async () => {
  const mixed = (async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]) as unknown as typeof lookup;
  await assert.rejects(resolveImageTarget(new URL('https://images.example.com/a.png'), mixed), /内网/);
  const resolver = (async () => [{ address: '1.1.1.1', family: 4 }]) as unknown as typeof lookup;
  assert.deepEqual(await resolveImageTarget(new URL('https://images.example.com/a.png'), resolver), { address: '1.1.1.1', family: 4 });
});

function fakeTransport(responses: { status?: number; headers?: Record<string, string>; chunks?: Buffer[] }[]) {
  const calls: { url: URL; options: Record<string, unknown> }[] = [];
  const open = ((url: URL, options: Record<string, unknown>, callback: (response: Readable) => void) => {
    calls.push({ url, options });
    const description = responses.shift(); assert.ok(description, 'unexpected image request');
    const response = Readable.from(description.chunks || [png]) as Readable & { statusCode: number; headers: object };
    response.statusCode = description.status || 200; response.headers = description.headers || {};
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => { queueMicrotask(() => callback(response)); };
    return req;
  }) as unknown as typeof httpsRequest;
  return { open, calls };
}
test('remote downloads pin the validated address and preserve TLS hostname without forwarding credentials', async () => {
  const fake = fakeTransport([{}]);
  const download = createImageDownloader(async () => ({ address: '8.8.8.8', family: 4 }), fake.open);
  const image = await download('https://images.example.com/a.png', new AbortController().signal);
  assert.deepEqual(image.data, png); assert.equal(image.mime, 'image/png');
  const call = fake.calls[0];
  assert.equal(call.url.hostname, 'images.example.com'); assert.equal(call.options.agent, false);
  const headers = call.options.headers as Record<string, string>; assert.equal(headers.Authorization, undefined); assert.equal(headers.Cookie, undefined);
  const pinnedLookup = call.options.lookup as (hostname: string, options: object, callback: (error: unknown, result: unknown) => void) => void;
  pinnedLookup('images.example.com', { all: true }, (error, result) => { assert.equal(error, null); assert.deepEqual(result, [{ address: '8.8.8.8', family: 4 }]); });
});
test('redirects to private hosts are rejected before making a second network request', async () => {
  const fake = fakeTransport([{ status: 302, headers: { location: 'https://127.0.0.1/private' } }]);
  const download = createImageDownloader(async () => ({ address: '8.8.8.8', family: 4 }), fake.open);
  await assert.rejects(download('https://images.example.com/a.png', new AbortController().signal), /公网/);
  assert.equal(fake.calls.length, 1);
});
test('download size is bounded for both Content-Length and chunked streaming responses', async () => {
  for (const response of [{ headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } }, { chunks: [Buffer.alloc(MAX_IMAGE_BYTES), Buffer.alloc(1)] }]) {
    const fake = fakeTransport([response]);
    const download = createImageDownloader(async () => ({ address: '8.8.8.8', family: 4 }), fake.open);
    await assert.rejects(download('https://images.example.com/a.png', new AbortController().signal), /8 MB/);
  }
});
