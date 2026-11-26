import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homepageData, validateCatalogDelta } from './proof.mjs';
import { buildArchivePlan } from '../../src/episode-archive.mjs';

const episode = bvid => ({ bvid, title: '原片标题', source: `https://www.bilibili.com/video/${bvid}/`, batch: 'new', approval: 'review', images: [{ id: 'original', src: `images/${bvid}/original.png`, width: 1080, height: 1440, bytes: 123, sha256: 'a'.repeat(64), crc32: 12, text: '保留条件的完整原话', start: 2 }] });
const catalog = videos => ({ author: 'Michael大麦哥', authorUrl: 'https://space.bilibili.com/324213598', updated: '2026-11-26', videoCount: videos.length, imageCount: videos.reduce((n, v) => n + v.images.length, 0), videos });
const migrate = v => ({ ...structuredClone(v), download: { url: `/video/${v.bvid}/?raw=1`, bytes: buildArchivePlan(v).bytes } });

test('只允许旧目录CRC及下载迁移，加一期必须待核对', () => {
  const old = episode('BV1LwhB65E8e'); delete old.images[0].crc32; old.approval = 'approved'; old.download = { url: '/downloads/old.zip', sha256: 'b'.repeat(64), bytes: 1 };
  const migrated = migrate({ ...old, images: [{ ...old.images[0], crc32: 12 }] });
  const added = migrate(episode('BV1ttykzFERD'));
  const proof = { bvid: added.bvid, uid: 324213598, imageCount: 1 };
  validateCatalogDelta(catalog([migrated, added]), catalog([old]), proof);
  for (const change of [v => { v[0].approval = 'review'; }, v => { v[0].images[0].text = '改写'; }, v => { v[1].approval = 'approved'; }, v => { v[1].download.url = '/downloads/new.zip'; }]) {
    const next = structuredClone([migrated, added]); change(next);
    assert.throws(() => validateCatalogDelta(catalog(next), catalog([old]), proof));
  }
});

test('数据JSON安全换入后只能改变两个内联数据块', () => {
  const html = '<html><script type="application/json" id="catalog-data">{"videos":[]}</script><main>原照片墙</main><script id="publication-data" type="application/json">{"videos":{}}</script></html>';
  const before = homepageData(html);
  const after = homepageData(html.replace('"videos":[]', '"videos":[1]'));
  assert.equal(before.outside, after.outside); assert.notDeepEqual(before.data, after.data);
  assert.throws(() => homepageData(html + '<script id="catalog-data">{}</script>'));
});
