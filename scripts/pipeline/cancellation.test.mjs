import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from './io.mjs';

// The child models a Skill Node process whose ASR descendant ignores SIGTERM.
// One future write exposes an orphan; no process/status query loop is involved.
for (const mode of ['abort', 'timeout', 'failure']) {
  test(`${mode} ends task-owned descendants before they can write after phase failure`, {
    skip: process.platform === 'win32' ? 'POSIX process groups are the Mac/Linux runtime contract' : false,
    timeout: 6000,
  }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'gallery-cancel-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const marker = join(directory, 'late-asr-result');
    const writeDelay = mode === 'timeout' ? 1500 : 400;
    const descendant = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      console.log('ready');
      setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'orphan wrote after cancellation'), ${writeDelay});
    `;
    const parent = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => {
        console.log('descendant-ready');
        ${mode === 'failure' ? 'process.exit(2);' : ''}
      });
      setTimeout(() => {}, 4000);
    `;
    let announceReady;
    const ready = new Promise(resolve => { announceReady = resolve; });
    const controller = new AbortController();
    const result = run(process.execPath, ['-e', parent], {
      signal: controller.signal, timeout: mode === 'timeout' ? 1000 : 10000,
      onOutput: chunk => { if (chunk.includes('descendant-ready')) announceReady(); },
    });
    // Attach rejection handling immediately, including a slow child startup.
    const rejected = assert.rejects(result, mode === 'abort' ? /取消/ : mode === 'timeout' ? /超时/ : /退出/);
    await Promise.race([ready, rejected.then(() => {
      throw new Error('The test process failed before its descendant was ready');
    })]);
    if (mode === 'abort') controller.abort();
    await rejected;
    // A single bounded wait reaches the descendant's scheduled write time.
    await delay(writeDelay + 100);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  });
}
