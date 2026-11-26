import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { crc32 } from 'node:zlib';
import { BVID, CREATOR_UID } from './bilibili.mjs';
import { buildArchivePlan } from '../../src/episode-archive.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const same = (a, b, why) => assert(isDeepStrictEqual(a, b), why);
const readJSON = async p => JSON.parse(await readFile(p, 'utf8'));
const without = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const dataScript = id => new RegExp(`(<script\\b[^>]*\\bid=["']${id}["'][^>]*>)([\\s\\S]*?)(<\\/script\\s*>)`, 'g');

export function homepageData(html) {
  const data = {};
  let outside = html;
  for (const id of ['catalog-data', 'publication-data']) {
    const matches = [...html.matchAll(dataScript(id))]; assert.equal(matches.length, 1, '正式页内联数据块不唯一');
    data[id] = JSON.parse(matches[0][2]);
    outside = outside.replace(dataScript(id), '$1__GALLERY_DATA__$3');
  }
  return { data, outside };
}

export function validateCatalogDelta(next, previous, episode) {
  const old = previous.videos, videos = next.videos;
  assert(Array.isArray(old) && Array.isArray(videos));
  same(without(next, ['videos', 'videoCount', 'imageCount', 'updated', 'download']), without(previous, ['videos', 'videoCount', 'imageCount', 'updated', 'download']), '目录作者或其他信息被修改');
  assert.equal(videos.length, old.length + (episode ? 1 : 0), '只允许逐次增加一期');
  assert.equal(next.videoCount, videos.length);
  assert.equal(next.imageCount, videos.reduce((n, v) => n + v.images.length, 0));
  const byID = new Map(videos.map(v => [v.bvid, v])); assert.equal(byID.size, videos.length, 'BV重复');
  for (const before of old) {
    const after = byID.get(before.bvid); assert(after, '旧期被移除');
    same(without(after, ['images', 'download']), without(before, ['images', 'download']), '旧期内容/认可状态变化');
    assert.equal(after.images.length, before.images.length);
    for (let i = 0; i < before.images.length; i++) {
      same(without(after.images[i], ['crc32']), without(before.images[i], ['crc32']), '旧图被覆盖');
      if (before.images[i].crc32 !== undefined) assert.equal(after.images[i].crc32, before.images[i].crc32, '旧图CRC被修改');
    }
  }
  for (const video of videos) {
    const plan = buildArchivePlan(video);
    same(video.download, { url: `/video/${video.bvid}/?raw=1`, bytes: plan.bytes }, '目录仍依赖预制ZIP或下载元数据不匹配');
  }
  if (episode) {
    assert.equal(episode.uid, CREATOR_UID); assert(BVID.test(episode.bvid));
    assert(!old.some(v => v.bvid === episode.bvid), '不能覆盖已收录期');
    const added = byID.get(episode.bvid);
    assert(added && added.approval === 'review' && added.batch === 'new');
    assert.equal(added.source, `https://www.bilibili.com/video/${episode.bvid}/`);
    assert(added.images.length > 0 && added.images.length === episode.imageCount);
    for (const image of added.images) {
      assert.equal(image.width, 1080); assert(image.height > 0 && image.height <= 12000);
      assert(typeof image.text === 'string' && image.text.trim()); assert(!/(\/Users\/|\/Volumes\/|sk-[A-Za-z0-9]{20})/.test(image.text));
    }
  }
  return byID;
}

export async function validateEpisodeProof(target, baseline) {
  const descriptor = target.manifest.changeProof;
  assert(descriptor?.source === 'change-proof.json', '缺少增量变更证明');
  const bytes = await readFile(join(target.path, descriptor.source));
  assert.equal(bytes.length, descriptor.bytes); assert.equal(sha(bytes), descriptor.sha256);
  const proof = JSON.parse(bytes);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.kind, 'episode-stage');
  assert.equal(proof.baseline.manifest.sha256, baseline.manifestSha256, '增量基线变化');
  const [next, previous, nextDates, previousDates, nextHTML, previousHTML] = await Promise.all([
    readJSON(join(target.path, 'public/catalog.json')), readJSON(join(baseline.path, 'public/catalog.json')),
    readJSON(join(target.path, 'public/video-publish-dates.json')), readJSON(join(baseline.path, 'public/video-publish-dates.json')),
    readFile(join(target.path, 'public/index.html'), 'utf8'), readFile(join(baseline.path, 'public/index.html'), 'utf8'),
  ]);
  const byID = validateCatalogDelta(next, previous, proof.episode);
  const nextPage = homepageData(nextHTML), oldPage = homepageData(previousHTML);
  same(nextPage.outside, oldPage.outside, '增量更新不能更改原照片墙UI');
  same(nextPage.data['catalog-data'], next, '主页与目录不同步');
  same(nextPage.data['publication-data'], nextDates, '主页与日期不同步');
  same(without(nextDates, ['videos', 'fetchedAt']), without(previousDates, ['videos', 'fetchedAt']), '日期表结构发生变化');
  for (const [bvid, date] of Object.entries(previousDates.videos)) same(nextDates.videos[bvid], date, '旧视频日期被修改');
  const addedDateIDs = Object.keys(nextDates.videos).filter(id => !Object.hasOwn(previousDates.videos, id));
  same(addedDateIDs, proof.episode ? [proof.episode.bvid] : [], '日期新增范围超出一期');
  const allowed = new Set(['index.html', 'catalog.json', 'video-publish-dates.json', 'download/index.html', 'download/page.css', 'download/page.js']);
  const expectedAdded = new Set(proof.episode ? byID.get(proof.episode.bvid).images.map(im => im.src.replace(/^\//, '')) : []);
  const oldFiles = new Map(baseline.manifest.files.map(f => [f.source, f]));
  const nextFiles = new Map(target.manifest.files.map(f => [f.source, f]));
  for (const video of next.videos) for (const image of video.images) {
    const source = image.src.replace(/^\//, ''), file = nextFiles.get(source);
    assert(file && image.bytes === file.bytes && image.sha256 === file.sha256, '目录与原图清单摘要不符');
    const bytes = await readFile(join(target.path, 'public', source));
    assert.equal(bytes.length, image.bytes); assert.equal(sha(bytes), image.sha256);
    assert.equal(crc32(bytes), image.crc32, '目录CRC与真实原图不符');
    assert.equal(bytes.readUInt32BE(16), image.width); assert.equal(bytes.readUInt32BE(20), image.height);
  }
  const changed = [], added = [];
  for (const [source, before] of oldFiles) {
    const after = nextFiles.get(source); assert(after, '旧资源被删除：' + source);
    if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) { assert(allowed.has(source), '增量修改超出范围：' + source); changed.push(source); }
  }
  for (const source of nextFiles.keys()) if (!oldFiles.has(source)) { assert(expectedAdded.has(source), '新增资源超出本期原图：' + source); added.push(source); }
  same([...expectedAdded].sort(), [...added].sort(), '本期原图清单不完整');
  assert.equal(target.headers, baseline.headers, '原安全头与缓存必须保持');
  assert.equal(sha(await readFile(join(target.path, 'wrangler.json'))), sha(await readFile(join(baseline.path, 'wrangler.json'))), '原部署配置必须保持');
  same(proof.changes.removed, [], '变更证明不能删除资源');
  same(proof.changes.changed.map(x => x.source).sort(), [...changed].sort(), '变更证明与实际变化不符');
  same(proof.changes.added.map(x => x.source).sort(), [...added].sort(), '新增证明与实际变化不符');
  for (const entry of [...proof.changes.changed, ...proof.changes.added]) {
    const after = nextFiles.get(entry.source); same(entry.after, { bytes: after.bytes, sha256: after.sha256 }, '变化后摘要不符');
    if (entry.before) { const before = oldFiles.get(entry.source); same(entry.before, { bytes: before.bytes, sha256: before.sha256 }, '变化前摘要不符'); }
  }
  return [...changed, ...added];
}
