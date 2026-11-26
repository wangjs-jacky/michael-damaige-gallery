import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { buildArchivePlan } from '../src/episode-archive.mjs';

const root = resolve(process.argv[2] || 'public');
const raw = await readFile(join(root, 'catalog.json'), 'utf8'), data = JSON.parse(raw);
const ids = new Set(), hashes = new Set();
let count = 0;
for (const video of data.videos) {
  assert(!ids.has(video.bvid)); ids.add(video.bvid);
  assert.equal(video.source, `https://www.bilibili.com/video/${video.bvid}/`);
  assert(['approved', 'review', 'sample'].includes(video.approval));
  for (const image of video.images) {
    assert(/^\/?images\/BV[0-9A-Za-z]{10}\/[\w-]+\.png$/.test(image.src));
    const bytes = await readFile(join(root, image.src.replace(/^\//, '')));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
    assert.equal(bytes.length, image.bytes);
    assert.equal(bytes.readUInt32BE(16), image.width); assert.equal(bytes.readUInt32BE(20), image.height);
    assert.equal(image.width, 1080); assert(image.height > 0 && image.height <= 12000);
    assert(bytes.length < 25 * 1024 * 1024 && image.text?.length > 0);
    if (image.crc32 !== undefined) assert.equal(crc32(bytes), image.crc32);
    hashes.add(image.sha256); count++;
  }
  if (video.images.every(image => Number.isInteger(image.crc32))) {
    const plan = buildArchivePlan(video);
    assert.equal(video.download.url, `/video/${video.bvid}/?raw=1`);
    assert.equal(video.download.bytes, plan.bytes);
  }
}
assert.equal(ids.size, data.videoCount); assert.equal(count, data.imageCount); assert.equal(hashes.size, count);
assert(!/(\/Users\/|\/home\/|sk-[a-zA-Z0-9]{20}|ASIA[0-9A-Z]{16}|AKIA[0-9A-Z]{16})/.test(raw));
console.log(`通过：${ids.size} 期，${count} 张，哈希、字节数、尺寸、来源与认可状态一致。`);
