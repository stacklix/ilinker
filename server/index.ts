import 'dotenv/config';
import { resolve } from 'node:path';
import { chmodSync, writeFileSync } from 'node:fs';
import { newToken } from './security.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为有效端口');
// Container-local capability: regenerated on every service start, never served publicly.
const localCliToken = process.env.ILINKER_LOCAL_CLI_FILE ? newToken() : undefined;
if (localCliToken) {
  const file = process.env.ILINKER_LOCAL_CLI_FILE!;
  writeFileSync(file, localCliToken, { mode: 0o600 });
  chmodSync(file, 0o600);
}
const { app } = await createApp({
  localCliToken,
  dataDir: resolve(process.env.DATA_DIR || './data'),
  encryptionKey: process.env.ENCRYPTION_KEY,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : undefined,
});
await app.listen({ port, host: process.env.HOST || '127.0.0.1' });
console.log(`iLinker 已启动：http://${process.env.HOST || '127.0.0.1'}:${port}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  void app.close().then(() => process.exit(0));
});
