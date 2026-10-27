import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';

const fixtures: { app: Awaited<ReturnType<typeof createApp>>['app']; dir: string }[] = [];
afterEach(async () => {
  for (const { app, dir } of fixtures.splice(0)) {
    await app.close();
    assert.ok(dir.startsWith(join(tmpdir(), 'ilinker-logging-test-')));
    await rm(dir, { recursive: true, force: true });
  }
});
async function fixture(web = false) {
  const dir = await mkdtemp(join(tmpdir(), 'ilinker-logging-test-'));
  const webDir = join(dir, 'web');
  if (web) { await mkdir(webDir); await writeFile(join(webDir, 'index.html'), '<html>iLinker</html>'); }
  const output: string[] = [];
  const { app } = await createApp({ dataDir: dir, startWorkers: false, webDir, logger: { stream: { write: chunk => { output.push(chunk); } } } });
  fixtures.push({ app, dir });
  return { app, output, logs: () => output.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('requests log their route, request id, completion status and duration', async () => {
  const f = await fixture();
  assert.equal((await f.app.inject('/healthz')).statusCode, 200);
  const logs = f.logs();
  const incoming = logs.find(log => log.msg === 'incoming request');
  const completed = logs.find(log => log.msg === 'request completed');
  assert.equal(incoming.req.method, 'GET');
  assert.equal(incoming.req.url, '/healthz');
  assert.ok(incoming.reqId);
  assert.equal(completed.reqId, incoming.reqId);
  assert.equal(completed.res.statusCode, 200);
  assert.equal(typeof completed.responseTime, 'number');
});

test('requests are logged before the handler finishes, so a pending request is visible', async () => {
  const f = await fixture();
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.app.get('/pending', async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return { ok: true }; });
  const response = f.app.inject('/pending').then(result => result);
  await started;
  const pendingLogs = f.logs();
  finish();
  assert.ok(pendingLogs.some(log => log.msg === 'incoming request' && log.req.url === '/pending'));
  assert.ok(!pendingLogs.some(log => log.msg === 'request completed'));
  assert.equal((await response).statusCode, 200);
  assert.ok(f.logs().some(log => log.msg === 'request completed'));
});

test('WebHook tokens and request secrets do not appear in logs, including unmatched routes', async () => {
  const f = await fixture();
  const token = 'hk_' + 'S'.repeat(43);
  const secrets = [token, 'private-cookie', 'private-authorization', 'private-query', 'private-password', 'private-local-cli'];
  const webhook = await f.app.inject({ method: 'POST', url: '/webhook/message/' + token + '?secret=private-query',
    headers: { cookie: 'ilinker_session=private-cookie', authorization: 'Bearer private-authorization', 'x-ilinker-local-cli': 'private-local-cli' },
    payload: { text: 'private-password' } });
  assert.equal(webhook.statusCode, 404);
  assert.equal((await f.app.inject('/unknown/' + encodeURIComponent(token) + '?secret=private-query')).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner', password: 'private-password' } })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: 'private-password' })).statusCode, 400);
  const raw = f.output.join('');
  for (const secret of secrets) assert.ok(!raw.includes(secret), 'Unexpected secret in request log');
  assert.ok(f.logs().some(log => log.req?.url === '/webhook/message/:token'));
  assert.ok(f.logs().some(log => log.req?.url === '[unmatched]'));
});

test('internal errors are correlated with the request without printing their potentially sensitive message', async () => {
  const f = await fixture();
  f.app.get('/broken', async () => { throw new Error('private-error-detail'); });
  assert.equal((await f.app.inject('/broken')).statusCode, 500);
  const logs = f.logs();
  const failed = logs.find(log => log.msg === 'request failed');
  assert.equal(failed.errorType, 'Error');
  assert.ok(logs.some(log => log.msg === 'incoming request' && log.reqId === failed.reqId));
  assert.ok(logs.some(log => log.msg === 'request completed' && log.reqId === failed.reqId && log.res.statusCode === 500));
  assert.ok(!f.output.join('').includes('private-error-detail'));
});

test('static frontend and unknown routes retain their responses without logging raw URLs', async () => {
  const f = await fixture(true);
  const home = await f.app.inject('/');
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /iLinker/);
  const token = 'hk_' + 'T'.repeat(43);
  const missing = await f.app.inject('/missing/' + token);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'NOT_FOUND');
  assert.ok(!f.output.join('').includes(token));
});
