import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationDay, selectNewVideos } from './bilibili.mjs';
const now = Date.parse('2026-11-26T11:00:00Z');
test('已知置顶不会挡住新投稿，旧未收录内容不会意外回填', () => {
  const known = ['BV1LwhB65E8e', 'BV1PfxW63EHv'], dates = { BV1LwhB65E8e: { publishedDate: '2026-10-28' }, BV1PfxW63EHv: null };
  const pinned = { bvid: known[0], dateLabel: '10-28' }, fresh = { bvid: 'BV1ttykzFERD', dateLabel: '7小时前' }, old = { bvid: 'BV1vYyXziEhi', dateLabel: '9-01' };
  for (const list of [[pinned, fresh, old], [fresh, pinned, old]]) {
    const result = selectNewVideos(list, known, dates, now);
    assert.equal(result.knownBoundaryFound, true); assert.deepEqual(result.videos.map(v => v.bvid), [fresh.bvid]);
  }
});
test('跨年、相对日期均用上海日期，无法判断的日期直接失败', () => {
  assert.equal(publicationDay('2天前', now), '2026-11-24');
  assert.equal(publicationDay('11月19日', now), '2026-11-19');
  assert.equal(publicationDay('2025年12月29日', now), '2025-12-29');
  assert.equal(publicationDay('12-31', Date.parse('2026-01-01T00:00Z')), '2025-12-31');
  assert.throws(() => publicationDay('2026-2-30', now));
  assert.throws(() => publicationDay('未知', now));
  assert.throws(() => selectNewVideos([], [], {}, now));
});
