import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const catalog = JSON.parse(await fs.readFile('public/catalog.json', 'utf8'));
const origin = process.env.GALLERY_ORIGIN || 'https://michael-damaige-gallery.jacky-openbird.workers.dev';
const pending = catalog.videos.flatMap(video => video.images);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let count = 0;

async function worker() {
  while (pending.length) {
    const image = pending.shift();
    const target = path.join('public', image.src);
    try {
      if (sha256(await fs.readFile(target)) === image.sha256) {
        count++;
        continue;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.download`;
    try {
      // curl 继承当前命令的代理环境，不修改系统或 Git 的全局配置。
      await run('curl', ['--fail', '--silent', '--show-error', '--location',
        '--connect-timeout', '20', '--max-time', '120',
        '--output', temporary, new URL(image.src, origin).href]);
      const bytes = await fs.readFile(temporary);
      if (bytes.length !== image.bytes || sha256(bytes) !== image.sha256) {
        throw new Error(`原图字节或哈希不符：${image.src}`);
      }
      await fs.rename(temporary, target);
      count++;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

await Promise.all(Array.from({ length: 4 }, worker));
console.log(`已恢复并核对 ${count} 张原图。`);
