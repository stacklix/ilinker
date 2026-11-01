import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { newToken, passwordHash } from './security.js';
import { HakoAuth, hakoConfig } from './hako.js';
import { resetAdminPassword } from './reset-password.js';

const fixtures: { dir: string; app: Awaited<ReturnType<typeof createApp>>['app'] }[] = [];
afterEach(async () => { for (const { dir, app } of fixtures.splice(0)) { await app.close(); assert.ok(dir.startsWith(join(tmpdir(), 'ilinker-hako-'))); await rm(dir, { recursive: true, force: true }); } });
const password = 'local-password-2026';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ilinker-hako-'));
  const config = { serverUrl: 'https://hako.example.com', clientId: 'ilinker', clientSecret: newToken() };
  const state = { subject: newToken(), unavailable: false, malformed: false, completeGate: undefined as (() => Promise<void>) | undefined };
  const requests = new Map<string, { redeem: string; status: string; purpose: string }>(), sessions = new Set<string>();
  const calls: { path: string; method: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error');
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    assert.equal(url.origin, config.serverUrl);
    assert.equal(headers.get('authorization'), `Bearer ${config.clientSecret}`); assert.equal(headers.get('x-hako-client'), config.clientId);
    if (state.unavailable) throw new Error('private-network-failure');
    const path = url.pathname.replace('/api/v1/app-login', ''), method = init!.method!;
    calls.push({ path, method });
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/requests') {
      const id = newToken(), redeem = newToken(), body = JSON.parse(String(init?.body));
      requests.set(id, { redeem, status: 'pending', purpose: body.purpose });
      const qr = new URL('hako://web-login'); qr.searchParams.set('v', '2'); qr.searchParams.set('server', state.malformed ? 'https://attacker.example.com' : config.serverUrl); qr.searchParams.set('request', id);
      return response({ id, redeemToken: redeem, qrPayload: qr.href, confirmationCode: '123456', expiresAt: new Date(Date.now() + 90_000).toISOString() }, 201);
    }
    if (path === '/session') {
      const token = headers.get('x-hako-session')!;
      if (method === 'DELETE') { sessions.delete(token); return response({ ok: true }); }
      return sessions.has(token) ? response({ active: true, issuer: config.serverUrl, subject: state.subject, clientId: config.clientId }) : response({}, 401);
    }
    const id = path.split('/')[2], request = requests.get(id);
    if (!request || request.redeem !== headers.get('x-hako-request')) return response({}, 404);
    if (method === 'DELETE') { requests.delete(id); return response({ ok: true }); }
    if (path.endsWith('/complete')) {
      if (request.status !== 'approved') return response({}, 409);
      await state.completeGate?.(); requests.delete(id);
      const token = newToken(); if (request.purpose === 'login') sessions.add(token);
      return response({ issuer: config.serverUrl, subject: state.subject, username: 'hako-owner', clientId: config.clientId, purpose: request.purpose,
        ...(request.purpose === 'login' ? { sessionToken: token, expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() } : {}) });
    }
    return response({ status: request.status });
  };
  const instance = await createApp({ dataDir: dir, logger: false, startWorkers: false, hako: config, hakoFetch: fetcher });
  fixtures.push({ app: instance.app, dir });
  instance.store.run('INSERT INTO admins VALUES (1,?,?)', 'local-admin', await passwordHash(password));
  const login = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'local-admin', password } });
  const cookie = `ilinker_session=${login.cookies[0].value}`;
  const start = async (bind = false, browserCookie = '') => {
    const result = await instance.app.inject({ method: 'POST', url: `/api/v1/auth/hako/${bind ? 'bind' : 'requests'}`, headers: { cookie: [bind ? cookie : '', browserCookie].filter(Boolean).join('; ') }, payload: bind ? { currentPassword: password } : {} });
    assert.equal(result.statusCode, 200, result.body);
    const pending = result.cookies.find(item => item.name === 'ilinker_hako_pending')!;
    return { id: result.json().id as string, cookie: `ilinker_hako_pending=${pending.value}${bind ? '; ' + cookie : ''}`, body: result.body };
  };
  const complete = (request: { id: string; cookie: string }) => instance.app.inject({ method: 'POST', url: `/api/v1/auth/hako/requests/${request.id}/complete`, headers: { cookie: request.cookie }, payload: {} });
  const bind = async () => { const request = await start(true); requests.get(request.id)!.status = 'approved'; const result = await complete(request); assert.equal(result.statusCode, 200, result.body); return request; };
  const scanLogin = async () => { const request = await start(); requests.get(request.id)!.status = 'approved'; const result = await complete(request); assert.equal(result.statusCode, 200, result.body); return { cookie: `ilinker_session=${result.cookies.find(c => c.name === 'ilinker_session')!.value}`, result }; };
  return { ...instance, dir, config, state, requests, sessions, calls, cookie, start, complete, bind, scanLogin };
}

test('binding requires password and browser ownership, and enables independent password and Hako logins', async () => {
  const f = await fixture();
  assert.equal((await f.app.inject('/api/v1/auth/status')).json().hakoEnabled, false);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/hako/requests', payload: {} })).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/hako/bind', payload: { currentPassword: password } })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/hako/bind', headers: { cookie: f.cookie }, payload: { currentPassword: 'wrong' } })).statusCode, 400);
  const request = await f.start(true), remote = f.requests.get(request.id)!;
  assert.ok(!request.body.includes(remote.redeem) && !request.body.includes(f.config.clientSecret));
  assert.equal((await f.complete({ ...request, cookie: '' })).statusCode, 410);
  remote.status = 'approved'; assert.equal((await f.complete(request)).statusCode, 200);
  assert.equal((await f.complete(request)).statusCode, 410);
  assert.equal((await f.app.inject('/api/v1/auth/status')).json().hakoEnabled, true);
  const login = await f.scanLogin();
  assert.equal(login.result.json().username, 'local-admin');
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: { cookie: login.cookie } })).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: { cookie: f.cookie } })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'local-admin', password } })).statusCode, 200);
  const meta = f.store.get<{ token: string }>('SELECT token FROM hako_sessions')!;
  assert.ok(!f.sessions.has(meta.token)); // Provider credential is encrypted at rest.
});

test('provider revocation and outage fail closed for Hako while password login continues', async () => {
  const f = await fixture(); await f.bind(); const login = await f.scanLogin();
  f.store.run('UPDATE hako_sessions SET checked_at=0'); f.state.unavailable = true;
  const down = await f.app.inject({ url: '/api/v1/auth/me', headers: { cookie: login.cookie } });
  assert.equal(down.statusCode, 503); assert.ok(!down.body.includes('private-network-failure'));
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: { cookie: f.cookie } })).statusCode, 200);
  f.state.unavailable = false; f.sessions.clear();
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: { cookie: login.cookie } })).statusCode, 401);
  assert.equal(f.store.all('SELECT * FROM hako_sessions').length, 0);
});

test('refresh, cancellation, different identities and malformed QR payloads cannot authenticate', async () => {
  const f = await fixture(); await f.bind();
  const old = await f.start(), current = await f.start(false, old.cookie);
  assert.equal((await f.complete(old)).statusCode, 410);
  assert.equal(f.requests.has(old.id), false);
  f.requests.get(current.id)!.status = 'approved'; f.state.subject = newToken();
  assert.equal((await f.complete(current)).statusCode, 403);
  f.state.malformed = true;
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/hako/requests', payload: {} })).statusCode, 502);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/hako/requests', headers: { origin: 'https://attacker.example.com' }, payload: {} })).statusCode, 403);
});

test('password recovery invalidates Hako sessions and pending requests without removing the binding', async () => {
  const f = await fixture(); await f.bind(); const login = await f.scanLogin(), pending = await f.start();
  await resetAdminPassword(f.dir, async () => 'recovered-password-2026', new AbortController().signal);
  assert.equal(f.store.all('SELECT * FROM sessions').length, 0);
  assert.equal(f.store.all('SELECT * FROM hako_sessions').length, 0);
  assert.ok(f.store.get('SELECT * FROM hako_binding'));
  assert.equal((await f.complete(pending)).statusCode, 410);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: { cookie: login.cookie } })).statusCode, 401);
});

test('a recovery during provider redemption cannot create a new session with the old pending request', async () => {
  const f = await fixture(); await f.bind(); const request = await f.start(); f.requests.get(request.id)!.status = 'approved';
  let release!: () => void, started!: () => void;
  const entering = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.state.completeGate = async () => { started(); await gate; };
  const pending = f.complete(request).then(result => result); await entering;
  await resetAdminPassword(f.dir, async () => 'concurrent-recovery-password', new AbortController().signal);
  release(); assert.equal((await pending).statusCode, 410);
  assert.equal(f.store.all('SELECT * FROM sessions').length, 0);
});

test('unbind revokes Hako sessions only and logout revokes the remote grant', async () => {
  const f = await fixture(); await f.bind(); let login = await f.scanLogin();
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: login.cookie } })).statusCode, 200);
  assert.equal(f.sessions.size, 0);
  login = await f.scanLogin();
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/hako/unbind', headers: { cookie: f.cookie }, payload: { currentPassword: password } })).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: { cookie: login.cookie } })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/v1/auth/me', headers: { cookie: f.cookie } })).statusCode, 200);
  assert.equal((await f.app.inject('/api/v1/auth/status')).json().hakoEnabled, false);
});

test('Hako settings reject partial configuration, insecure origins and invalid secrets', () => {
  assert.equal(hakoConfig({}), undefined);
  assert.throws(() => hakoConfig({ HAKO_URL: 'https://hako.example.com' }), /同时配置/);
  for (const config of [
    { serverUrl: 'http://hako.example.com', clientId: 'ilinker', clientSecret: newToken() },
    { serverUrl: 'https://hako.example.com/path', clientId: 'ilinker', clientSecret: newToken() },
    { serverUrl: 'https://hako.example.com', clientId: 'ilinker', clientSecret: 'weak' },
  ]) assert.throws(() => new HakoAuth(null!, null!, config), /Hako 配置无效/);
});
