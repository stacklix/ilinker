import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.js';
import { runCli, type CliIO } from './cli-core.js';
import type { PlatformAdapter } from './ilink.js';
import type { Bot, WebHook } from '../shared/types.js';

const password = 'cli-test-password-2026';
const fixtures: { app: Awaited<ReturnType<typeof createApp>>['app']; dir: string }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    assert.ok(fixture.dir.startsWith(join(tmpdir(), 'ilinker-cli-')));
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
async function fixture(localCliToken?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ilinker-cli-'));
  const state = { account: 'cli-account', peer: 'cli-owner', approved: true, verify: false, codes: [] as string[] };
  const adapter: PlatformAdapter = {
    async createLogin() { return { qrcode: 'test-qr', qrcode_img_content: 'https://example.com/cli-qr' }; },
    async pollLogin(_qr, _base, code, signal) {
      await delay(5, undefined, { signal });
      if (code) state.codes.push(code);
      if (!state.approved) return { status: 'wait' };
      if (state.verify && code !== '123456') return { status: 'need_verifycode' };
      return { status: 'confirmed', bot_token: 'cli-platform-secret', ilink_bot_id: state.account, ilink_user_id: state.peer };
    },
    async updates(_credentials, _cursor, signal) { await delay(50, undefined, { signal }); return { msgs: [] }; },
    async send() {}, async notify() {},
  };
  const instance = await createApp({ dataDir: dir, adapter, startWorkers: false, webDir: join(dir, 'no-web'), localCliToken });
  fixtures.push({ app: instance.app, dir });
  const url = await instance.app.listen({ host: '127.0.0.1', port: 0 });
  const output: string[] = [], info: string[] = [];
  const io: CliIO = {
    out: text => { output.push(text); }, info: text => { info.push(text); },
    prompt: async label => label.includes('验证码') ? '123456' : password,
    passwordStdin: async () => password + '\n',
  };
  const env = { DATA_DIR: dir, ILINKER_URL: url };
  const run = async (...args: string[]) => {
    output.length = 0; info.length = 0;
    await runCli(args, { io, env, pollMs: 10 });
    return output.join('\n');
  };
  const setup = () => run('auth', 'setup', '--username', 'cli-admin', '--password-stdin');
  return { ...instance, dir, url, env, io, state, output, info, run, setup };
}

test('CLI initializes, binds through HTTP, creates a WebHook and uses the single chat', async () => {
  const f = await fixture();
  await f.setup();
  const file = join(f.dir, 'cli-session.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.origin, f.url); assert.match(saved.cookie, /^ilinker_session=/);
  assert.ok(!f.output.join('').includes(password)); assert.ok(!f.output.join('').includes(saved.cookie));
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const qrFile = join(f.dir, 'qr.png');
  const bot = JSON.parse(await f.run('bot', 'bind', '--name', 'CLI 通知助手', '--qr-file', qrFile, '--json')) as Bot;
  assert.equal(bot.accountId, 'cli-account'); assert.equal(bot.hasCredentials, true);
  assert.deepEqual((await readFile(qrFile)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(f.info.some(line => line.includes('请使用微信扫码')));
  f.gateway.ingest(bot.id, { message_id: 'first', from_user_id: 'cli-owner', context_token: 'cli-context', message_type: 1, item_list: [{ type: 1, text_item: { text: '你好' } }] });
  const result = JSON.parse(await f.run('webhook', 'create', '--bot', bot.id, '--name', '构建通知', '--rate-limit', '20', '--public-url', 'https://notify.example.com', '--json')) as { webhook: WebHook; path: string; url: string; token: string };
  assert.equal(result.webhook.botId, bot.id); assert.equal(result.webhook.rateLimit, 20);
  assert.equal(result.url, `https://notify.example.com${result.path}`);
  const sent = await f.app.inject({ method: 'POST', url: result.path, payload: { text: '由 CLI 创建的通知入口' } });
  assert.equal(sent.statusCode, 202);
  assert.equal(f.store.get<{ conversation_id: string }>('SELECT conversation_id FROM messages WHERE id=?', sent.json().messageId)!.conversation_id, f.store.conversation(bot.id)!.id);
  const listed = await f.run('webhook', 'list', '--json');
  assert.ok(!listed.includes(result.token)); assert.equal(JSON.parse(listed).length, 1);
  await f.run('auth', 'logout');
  await assert.rejects(readFile(file), /ENOENT/);
  await assert.rejects(f.run('bot', 'list'), /尚未登录/);
});

test('container CLI binds and creates WebHooks without an administrator or login session', async () => {
  const token = 'local-test-capability-'.repeat(3);
  const f = await fixture(token);
  const file = join(f.dir, 'local-cli.token');
  await writeFile(file, token, { mode: 0o600 });
  const env = { ...f.env, PORT: new URL(f.url).port, ILINKER_LOCAL_CLI_FILE: file };
  const run = async (...args: string[]) => {
    f.output.length = 0;
    await runCli(args, { io: f.io, env, pollMs: 10 });
    return JSON.parse(f.output.join(''));
  };
  const bot = await run('bot', 'bind', '--name', '免登录机器人', '--json');
  const result = await run('webhook', 'create', '--bot', bot.id, '--name', '免登录通知', '--json');
  assert.equal(result.webhook.botId, bot.id);
  assert.equal((await run('bot', 'list', '--json')).length, 1);
  assert.equal((await run('webhook', 'list', '--json')).length, 1);
  assert.equal(f.store.get('SELECT id FROM admins'), undefined);
  assert.equal(f.store.get('SELECT hash FROM sessions'), undefined);
  await assert.rejects(readFile(join(f.dir, 'cli-session.json')), /ENOENT/);
  assert.ok(!f.output.join('').includes(token));
  let fetched = false;
  await assert.rejects(runCli(['bot', 'list', '--url', 'https://remote.example.com'], {
    io: f.io, env, fetch: async () => { fetched = true; throw new Error('must not send'); },
  }), /尚未登录/);
  assert.equal(fetched, false);
});

test('local CLI capability rejects external, browser, missing and invalid credentials', async () => {
  const token = 'local-test-capability-'.repeat(3);
  const f = await fixture(token);
  const headers = { 'x-ilinker-local-cli': token };
  assert.equal((await f.app.inject({ url: '/api/v1/bots', headers, remoteAddress: '127.0.0.1' })).statusCode, 200);
  for (const input of [
    { headers, remoteAddress: '192.168.0.12' },
    { headers: { ...headers, 'x-forwarded-for': '127.0.0.1' }, remoteAddress: '192.168.0.12' },
    { headers: { ...headers, origin: f.url }, remoteAddress: '127.0.0.1' },
    { headers: { ...headers, 'sec-fetch-site': 'same-origin' }, remoteAddress: '127.0.0.1' },
    { headers: { 'x-ilinker-local-cli': 'wrong-token' }, remoteAddress: '127.0.0.1' },
    { headers: {}, remoteAddress: '127.0.0.1' },
  ]) assert.equal((await f.app.inject({ url: '/api/v1/bots', ...input })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers, remoteAddress: '127.0.0.1' })).statusCode, 401);
  const disabled = await fixture();
  assert.equal((await disabled.app.inject({ url: '/api/v1/bots', headers, remoteAddress: '127.0.0.1' })).statusCode, 401);
});

test('CLI prompts for verification and reports refusal to rebind an existing bot', async () => {
  const f = await fixture(); await f.setup(); f.state.verify = true;
  const bot = JSON.parse(await f.run('bot', 'bind', '--name', '验证码机器人', '--json')) as Bot;
  assert.deepEqual(f.state.codes, ['123456']);
  f.state.verify = false; f.state.account = 'other-account'; f.state.peer = 'other-peer';
  await assert.rejects(f.run('bot', 'bind', '--id', bot.id), /不支持换绑/);
  assert.equal(f.store.bots()[0].accountId, 'cli-account');
});

test('CLI binding timeout keeps the pending bot available for an explicit retry', async () => {
  const f = await fixture(); await f.setup(); f.state.approved = false;
  await assert.rejects(f.run('bot', 'bind', '--name', '等待扫码', '--timeout', '1'), /扫码等待超时.*bot bind --id/);
  assert.equal(f.store.bots().length, 1);
  f.state.approved = true;
  const bot = f.store.bots()[0];
  const result = JSON.parse(await f.run('bot', 'bind', '--id', bot.id, '--json')) as Bot;
  assert.equal(result.id, bot.id); assert.equal(result.hasCredentials, true);
  assert.equal(f.store.bots().length, 1);
});

test('CLI validates options before creating bots or WebHooks', async () => {
  const f = await fixture(); await f.setup();
  await assert.rejects(f.run('bot', 'bind', '--id', 'bot', '--name', 'both'), /只能选择一个/);
  await assert.rejects(f.run('bot', 'bind', '--name', 'bad', '--timeout', 'NaN'), /timeout/);
  await assert.rejects(f.run('bot', 'list', '--name', 'ignored'), /不支持 --name/);
  await assert.rejects(f.run('webhook', 'create', '--bot', 'bot', '--name', 'bad', '--rate-limit', '0'), /rate-limit/);
  await assert.rejects(f.run('webhook', 'create', '--bot', 'bot', '--name', 'bad', '--expires-at', 'yesterday'), /expires-at/);
  await assert.rejects(f.run('webhook', 'create', '--bot', 'bot', '--name', 'bad', '--public-url', 'https://notify.example.com/path'), /源地址/);
  assert.equal(f.store.bots().length, 0); assert.equal(f.store.webhooks().length, 0);
});

test('CLI credentials are scoped to the exact origin and expired sessions cannot mutate state', async () => {
  const f = await fixture(); await f.setup();
  let called = false;
  await assert.rejects(runCli(['bot', 'list', '--url', 'https://other.example.com'], { io: f.io, env: f.env, fetch: async () => { called = true; throw new Error('must not send'); } }), /尚未登录/);
  assert.equal(called, false);
  f.store.run('DELETE FROM sessions');
  await assert.rejects(f.run('bot', 'bind', '--name', 'must-not-create'), /登录已失效/);
  assert.equal(f.store.bots().length, 0);
});

test('CLI refuses redirects before forwarding administrator credentials', async () => {
  const f = await fixture(); let redirected = 0;
  const target = createServer((_req, response) => { redirected++; response.end('{}'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as { port: number }).port;
  const source = createServer((_req, response) => { response.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/` }); response.end(); });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(f.run('auth', 'login', '--username', 'cli-admin', '--password-stdin', '--url', `http://127.0.0.1:${(source.address() as { port: number }).port}`), /不接受 HTTP 重定向/);
    assert.equal(redirected, 0);
  } finally {
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
  }
});

test('the executable CLI reads a piped password and saves a session without echoing secrets', async () => {
  const f = await fixture();
  const result = await new Promise<{ code: number | null; out: string; error: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'server/cli.ts', 'auth', 'setup', '--username', 'pipe-admin', '--password-stdin', '--json', '--url', f.url], {
      env: { ...process.env, DATA_DIR: f.dir }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', error = '';
    child.stdout.on('data', chunk => { out += chunk.toString(); }); child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject); child.on('close', code => resolveRun({ code, out, error }));
    child.stdin.end(password + '\n');
  });
  assert.equal(result.code, 0, result.error); assert.equal(JSON.parse(result.out).username, 'pipe-admin');
  assert.ok(!result.out.includes(password) && !result.error.includes(password));
  assert.equal(JSON.parse(await f.run('bot', 'list', '--json')).length, 0);
});

test('health endpoint is unauthenticated and contains no configuration or account data', async () => {
  const f = await fixture();
  const result = await fetch(`${f.url}/healthz`);
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { status: 'ok' });
});
