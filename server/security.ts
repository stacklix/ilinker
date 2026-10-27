import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = (prefix = '') => prefix + randomBytes(32).toString('base64url');

export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [salt, expected] = encoded.split(':');
  const key = await derive(password, salt, 64) as Buffer;
  const bytes = Buffer.from(expected, 'hex');
  return bytes.length === key.length && timingSafeEqual(bytes, key);
}

export class Vault {
  private key: Buffer;
  constructor(dataDir: string, configuredKey?: string) {
    mkdirSync(dataDir, { recursive: true });
    const filename = join(dataDir, 'encryption.key');
    if (configuredKey) this.key = Buffer.from(configuredKey, 'base64');
    else if (existsSync(filename)) this.key = readFileSync(filename);
    else {
      this.key = randomBytes(32);
      writeFileSync(filename, this.key, { mode: 0o600, flag: 'wx' });
    }
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEY 必须为 Base64 编码的 32 字节密钥');
  }
  seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  open(encoded: string): string {
    const data = Buffer.from(encoded, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
}

export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
