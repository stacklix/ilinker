import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const windows = process.platform === 'win32';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8x8AAAAASUVORK5CYII=', 'base64');
const token = 'hk_' + 't'.repeat(43);
const script = resolve('scripts/send-screenshot.ps1');
const windowsPowerShell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const pwsh = (process.env.PATH || '').split(';').map(dir => join(dir, 'pwsh.exe')).find(existsSync);

async function checkScript(options: { statuses?: string[]; noWait?: boolean; httpError?: number; redirect?: boolean; invalidFile?: boolean; engine?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ilinker-screenshot-test-'));
  const image = join(dir, options.invalidFile ? 'not-an-image.txt' : 'shot.png');
  const config = join(dir, 'webhook.json');
  await writeFile(image, png);
  const requests: { method: string; path: string; key?: string; payload?: { type: string; image: { base64: string } } }[] = [];
  let gets = 0;
  let target = '';
  const server = createServer(async (req, res) => {
    const record: (typeof requests)[number] = { method: req.method || '', path: req.url || '', key: req.headers['idempotency-key'] as string };
    requests.push(record);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'POST') {
      let body = ''; for await (const part of req) body += part.toString();
      record.payload = JSON.parse(body);
      if (options.redirect) { res.writeHead(307, { Location: '/must-not-follow' }); res.end('{}'); return; }
      if (options.httpError) {
        res.writeHead(options.httpError);
        res.end(JSON.stringify({ code: 'CONTEXT_REQUIRED', message: `请先建立会话 ${target} ${token}` })); return;
      }
      res.writeHead(202); res.end(JSON.stringify({ requestId: 'req_mock', messageId: 'msg_mock', status: 'queued' })); return;
    }
    gets++;
    res.end(JSON.stringify({ messageId: 'msg_mock', status: options.statuses?.[Math.min(gets - 1, options.statuses.length - 1)] || 'provider_accepted', error: null }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    target = `http://127.0.0.1:${port}/webhook/message/${token}`;
    await writeFile(config, JSON.stringify({ webhookUrl: target }));
    const args = ['-NoProfile', '-NonInteractive', '-File', script, '-ImagePath', image, '-ConfigPath', config, '-IdempotencyKey', 'screenshot-test-key', '-WaitTimeoutSeconds', '1'];
    if (options.noWait) args.push('-NoWait');
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(options.engine || windowsPowerShell, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.ok(!output.stdout.includes(token) && !output.stderr.includes(token), 'script must redact the WebHook token');
    assert.ok(!output.stdout.includes(png.toString('base64')), 'script must not print image contents');
    const result = JSON.parse(output.stdout.trim());
    return { ...output, result, requests, gets };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(dir.startsWith(join(tmpdir(), 'ilinker-screenshot-test-')));
    await rm(dir, { recursive: true, force: true });
  }
}

test('screenshot script sends Base64 with idempotency and waits for provider acceptance', { skip: !windows }, async () => {
  const outcome = await checkScript();
  assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
  assert.equal(outcome.result.status, 'provider_accepted'); assert.equal(outcome.result.providerAccepted, true);
  assert.equal(outcome.result.messageId, 'msg_mock');
  assert.equal(outcome.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(outcome.requests[0].key, 'screenshot-test-key');
  assert.equal(outcome.requests[0].payload?.type, 'image');
  assert.deepEqual(Buffer.from(outcome.requests[0].payload!.image.base64, 'base64'), png);
  assert.ok(outcome.requests[1].path.endsWith('/status/msg_mock'));
});
test('screenshot NoWait reports queued rather than claiming platform acceptance', { skip: !windows }, async () => {
  const outcome = await checkScript({ noWait: true });
  assert.equal(outcome.code, 0); assert.equal(outcome.result.status, 'queued');
  assert.equal(outcome.result.providerAccepted, false); assert.equal(outcome.gets, 0);
});

test('screenshot unknown outcome exits unsuccessfully without re-posting', { skip: !windows }, async () => {
  const outcome = await checkScript({ statuses: ['unknown'] });
  assert.equal(outcome.code, 1); assert.equal(outcome.result.status, 'unknown');
  assert.equal(outcome.result.idempotencyKey, 'screenshot-test-key');
  assert.equal(outcome.requests.filter(r => r.method === 'POST').length, 1);
});
test('screenshot HTTP errors remain useful while redacting endpoint secrets', { skip: !windows }, async () => {
  const outcome = await checkScript({ httpError: 409 });
  assert.equal(outcome.code, 1); assert.match(outcome.result.error, /CONTEXT_REQUIRED/);
  assert.match(outcome.result.error, /请先建立会话/); assert.match(outcome.result.error, /REDACTED/);
  assert.equal(outcome.requests.length, 1);
});
test('screenshot client refuses HTTP redirects instead of forwarding image contents', { skip: !windows }, async () => {
  const outcome = await checkScript({ redirect: true });
  assert.equal(outcome.code, 1); assert.match(outcome.result.error, /307/); assert.equal(outcome.requests.length, 1);
});
test('screenshot wait timeout preserves identifiers and never creates duplicate tasks', { skip: !windows }, async () => {
  const outcome = await checkScript({ statuses: ['queued'] });
  assert.equal(outcome.code, 2); assert.equal(outcome.result.timedOut, true);
  assert.equal(outcome.result.messageId, 'msg_mock'); assert.equal(outcome.result.status, 'queued');
  assert.equal(outcome.requests.filter(r => r.method === 'POST').length, 1);
});
test('screenshot validation rejects unsupported files before making a request', { skip: !windows }, async () => {
  const outcome = await checkScript({ invalidFile: true });
  assert.equal(outcome.code, 1); assert.match(outcome.result.error, /formats/); assert.equal(outcome.requests.length, 0);
});
test('screenshot script also runs on PowerShell 7 when available', { skip: !windows || !pwsh }, async () => {
  const outcome = await checkScript({ engine: pwsh });
  assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr); assert.equal(outcome.result.providerAccepted, true);
});
