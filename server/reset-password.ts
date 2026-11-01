import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { passwordHash } from './security.js';

// Recovery is deliberately filesystem-only: no HTTP endpoint or remote credentials.
export async function resetAdminPassword(dataDir: string, readPassword: () => Promise<string>, signal: AbortSignal) {
  const filename = join(dataDir, 'ilinker.sqlite');
  try {
    if (!(await stat(filename)).isFile()) throw new Error('not a database');
  } catch {
    throw new Error(`找不到现有数据库：${filename}；请检查 --data-dir 或 DATA_DIR，不会创建新数据库`);
  }
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    if (!db.prepare('SELECT username FROM admins WHERE id=1').get()) throw new Error('管理员尚未初始化，请先通过网页或 auth setup 创建管理员');
    const password = await readPassword();
    if (password.length < 10 || password.length > 128) throw new Error('新密码必须为 10–128 位');
    const encoded = await passwordHash(password);
    signal.throwIfAborted();
    db.exec('BEGIN IMMEDIATE');
    try {
      const admin = db.prepare('SELECT username FROM admins WHERE id=1').get() as { username: string } | undefined;
      if (!admin) throw new Error('管理员尚未初始化，请先通过网页或 auth setup 创建管理员');
      db.prepare('UPDATE admins SET password_hash=? WHERE id=1').run(encoded);
      db.exec('DELETE FROM sessions');
      db.exec('COMMIT');
      return { username: admin.username, dataDir };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}
