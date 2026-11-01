import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runCli, type CliIO } from './cli-core.js';
import { Store } from './store.js';
import { passwordHash, passwordMatches } from './security.js';

const oldPassword = 'previous-admin-password', newPassword = 'new-recovery-password';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    assert.ok(dir.startsWith(join(tmpdir(), 'ilinker-reset-')));
    await rm(dir, { recursive: true, force: true });
  }
});
async function fixture(initialized = true) {
  const dir = await mkdtemp(join(tmpdir(), 'ilinker-reset-')); dirs.push(dir);
  const store = new Store(dir);
  if (initialized) store.run('INSERT INTO admins VALUES (1,?,?)', 'existing-admin', await passwordHash(oldPassword));
  store.run('INSERT INTO sessions VALUES (?,?)', 'old-session-hash', Date.now() + 60_000);
  const output: string[] = [], prompts: boolean[] = [];
  const io: CliIO = {
    out: text => { output.push(text); }, info: text => { output.push(text); },
    prompt: async (_label, secret) => { prompts.push(secret); return newPassword; },
    passwordStdin: async () => newPassword + '\r\n',
  };
  const run = (args: string[] = [], overrides: Partial<CliIO> = {}, env: NodeJS.ProcessEnv = { DATA_DIR: dir }) => runCli(
    ['auth', 'reset-password', ...args], { io: { ...io, ...overrides }, env, fetch: async () => { throw new Error('recovery must never use HTTP'); } },
  );
  return { dir, store, output, prompts, io, run };
}

test('offline recovery preserves the account and key, supports container env and ignores remote/session configuration', async () => {
  const f = await fixture();
  const key = Buffer.from('existing-encryption-key');
  await writeFile(join(f.dir, 'encryption.key'), key);
  await writeFile(join(f.dir, 'cli-session.json'), 'corrupt old session file');
  f.store.close();
  await f.run(['--json'], {}, {
    DATA_DIR: f.dir, ILINKER_URL: 'invalid remote URL', ILINKER_LOCAL_CLI_FILE: join(f.dir, 'missing-token'),
    ILINKER_SESSION_FILE: join(f.dir, 'cli-session.json'),
  });
  assert.deepEqual(f.prompts, [true, true]);
  assert.deepEqual(JSON.parse(f.output.join('')), { ok: true, username: 'existing-admin', dataDir: f.dir });
  assert.ok(!f.output.join('').includes(newPassword));
  const reopened = new Store(f.dir);
  try {
    const admin = reopened.get<{ username: string; password_hash: string }>('SELECT * FROM admins')!;
    assert.equal(admin.username, 'existing-admin');
    assert.equal(await passwordMatches(newPassword, admin.password_hash), true);
    assert.equal(await passwordMatches(oldPassword, admin.password_hash), false);
    assert.equal(reopened.all('SELECT * FROM sessions').length, 0);
    assert.deepEqual(await readFile(join(f.dir, 'encryption.key')), key);
    assert.equal(await readFile(join(f.dir, 'cli-session.json'), 'utf8'), 'corrupt old session file');
  } finally { reopened.close(); }
});

test('recovery validates confirmation, length, cancellation and rejects remote or unrelated options without mutations', async () => {
  const f = await fixture();
  try {
    const before = f.store.all('SELECT * FROM admins');
    let calls = 0;
    await assert.rejects(f.run([], { prompt: async () => ++calls === 1 ? newPassword : 'different-password' }), /两次密码不一致/);
    for (const password of ['short', 'x'.repeat(129)]) await assert.rejects(f.run(['--password-stdin'], { passwordStdin: async () => password }), /10–128/);
    for (const args of [['--url', 'https://remote.example.com'], ['--session-file', 'some-file'], ['--username', 'other'], ['--password', newPassword]]) {
      await assert.rejects(f.run(args), /不支持|Unknown option/);
    }
    const controller = new AbortController();
    await assert.rejects(runCli(['auth', 'reset-password'], {
      env: { DATA_DIR: f.dir }, signal: controller.signal,
      io: { ...f.io, prompt: async () => { controller.abort(); return newPassword; } },
    }), /abort/i);
    assert.deepEqual(f.store.all('SELECT * FROM admins'), before);
    assert.equal(f.store.all('SELECT * FROM sessions').length, 1);
  } finally { f.store.close(); }
});

test('recovery does not create missing databases or initialize an account', async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(f.run(), /管理员尚未初始化/);
    assert.deepEqual(f.prompts, []);
    const missing = join(f.dir, 'missing');
    await assert.rejects(f.run(['--data-dir', missing]), /不会创建新数据库/);
    await assert.rejects(stat(missing), /ENOENT/);
    assert.equal(f.store.all('SELECT * FROM admins').length, 0);
    assert.equal(f.store.all('SELECT * FROM sessions').length, 1);
  } finally { f.store.close(); }
});

test('failure to revoke sessions rolls back the password update', async () => {
  const f = await fixture();
  try {
    const before = f.store.all('SELECT * FROM admins');
    f.store.db.exec("CREATE TRIGGER prevent_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test revoke failure'); END");
    await assert.rejects(f.run(['--password-stdin']), /test revoke failure/);
    assert.deepEqual(f.store.all('SELECT * FROM admins'), before);
    assert.equal(f.store.all('SELECT * FROM sessions').length, 1);
  } finally { f.store.close(); }
});

test('the executable resets an offline database with --data-dir and piped input without echoing the password', async () => {
  const f = await fixture(); f.store.close();
  const result = await new Promise<{ code: number | null; out: string; error: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'server/cli.ts', 'auth', 'reset-password', '--data-dir', f.dir, '--password-stdin', '--json'], {
      env: { ...process.env, DATA_DIR: join(f.dir, 'wrong-directory') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', error = '';
    child.stdout.on('data', chunk => { out += chunk.toString(); }); child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject); child.on('close', code => resolveRun({ code, out, error }));
    child.stdin.end(newPassword + '\n');
  });
  assert.equal(result.code, 0, result.error);
  assert.equal(JSON.parse(result.out).username, 'existing-admin');
  assert.ok(!result.out.includes(newPassword) && !result.error.includes(newPassword));
  const reopened = new Store(f.dir);
  try { assert.ok(await passwordMatches(newPassword, reopened.get<{ password_hash: string }>('SELECT password_hash FROM admins')!.password_hash)); }
  finally { reopened.close(); }
});
