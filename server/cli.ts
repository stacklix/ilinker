#!/usr/bin/env node
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { runCli } from './cli-core.js';

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

async function prompt(label: string, secret: boolean, signal: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('当前没有交互终端。认证可使用 --username 和 --password-stdin；Docker 扫码绑定请使用 docker compose exec（保留 TTY）');
  if (!secret) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { return await rl.question(label, { signal }); } finally { rl.close(); }
  }
  signal.throwIfAborted();
  process.stderr.write(label);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', input); signal.removeEventListener('abort', cancel);
      process.stdin.setRawMode(previousRaw); process.stdin.pause(); process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(new Error('输入已取消'));
    const input = (chunk: string) => {
      if (chunk.startsWith('\u001b')) return;
      for (const character of chunk) {
        if (character === '\u0003') { cancel(); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
        else if (character >= ' ') value += character;
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    process.stdin.on('data', input);
  });
}

try {
  await runCli(process.argv.slice(2), {
    signal: controller.signal,
    io: {
      out: text => { process.stdout.write(text + '\n'); },
      info: text => { process.stderr.write(text + '\n'); },
      prompt,
      passwordStdin: async () => {
        if (process.stdin.isTTY) throw new Error('--password-stdin 需要通过管道输入密码');
        let value = '';
        for await (const chunk of process.stdin) { value += chunk.toString(); if (value.length > 1024) throw new Error('密码输入过长'); }
        return value;
      },
    },
  });
} catch (error) {
  process.stderr.write(`错误：${error instanceof Error ? error.message : '操作失败'}\n`);
  process.exitCode = 1;
}
