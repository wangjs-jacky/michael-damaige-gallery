import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { parseInput, resolveInput } from '../src/worker.mjs';

const bvid = 'BV1LwhB65E8e';
const video = { bvid, title: '让时间慢下来的10个方法', images: [{}, {}], download: { url: `/downloads/${bvid}.zip`, bytes: 5276051 } };
const catalog = { videos: [video] };
const env = { ASSETS: { fetch: async request => {
  const path = new URL(request.url ?? request).pathname;
  if (path === '/catalog.json') return Response.json(catalog);
  return new Response('existing asset', { headers: { 'content-type': 'text/html' } });
} } };
const endpoint = (input, init = {}) => new Request('https://gallery.example/api/resolve', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }), ...init,
});

test('extracts BV from direct IDs, mobile/desktop links and punctuated share text', () => {
  for (const input of [bvid, `https://www.bilibili.com/video/${bvid}/?t=123&share_source=copy_web`, `https://m.bilibili.com/video/${bvid}`, `【大麦哥】 https://www.bilibili.com/video/${bvid}/。`, `bilibili.com/video/${bvid}`]) {
    assert.deepEqual(parseInput(input), { bvid });
  }
  assert.deepEqual(parseInput('https://b23.tv/AbC123?share_source=copy'), { shortUrl: 'https://b23.tv/AbC123' });
});

test('rejects deceptive hosts, credentials, ports, paths, multiple links and oversize input', () => {
  for (const host of ['evil.bilibili.com', 'badbilibili.com', 'evil.b23.tv', 'badb23.tv']) {
    assert.throws(() => parseInput(`${host}/video/${bvid}`), undefined, host);
  }
  for (const input of ['', 'x'.repeat(4097), 'BV123', `https://evil.example/video/${bvid}`, `https://www.bilibili.com.evil.test/video/${bvid}`, `https://b23.tv@127.0.0.1/${bvid}`, 'https://b23.tv:8080/abc', `https://evil.test/?next=https://www.bilibili.com/video/${bvid}`, `https://www.bilibili.com/other/${bvid}`, 'https://b23.tv/%2f%2f127.0.0.1', `https://www.bilibili.com/video/${bvid}suffix`, `https://www.bilibili.com/video/${bvid} https://b23.tv/abc`]) {
    assert.throws(() => parseInput(input), undefined, input);
  }
});

test('resolves a short link without fetching the Bilibili video or following its query', async () => {
  const requests = [];
  const result = await resolveInput('分享 https://b23.tv/AbCdEF 。', async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 302, headers: { location: `https://www.bilibili.com/video/${bvid}/?next=https://evil.test` } });
  });
  assert.equal(result, bvid);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.redirect, 'manual');
  assert(requests[0].init.signal instanceof AbortSignal);
});

test('does not fetch offsite/private targets returned by a short link', async () => {
  for (const location of ['http://127.0.0.1/private', 'https://evil.test/x', 'https://b23.tv.evil.test/abc', 'https://www.bilibili.com/login', 'https://b23.tv:444/abc']) {
    let calls = 0;
    await assert.rejects(resolveInput('https://b23.tv/abc', async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location } });
    }));
    assert.equal(calls, 1, location);
  }
});

test('short link relative hops are bounded; loops, no redirect and fetch errors end explicitly', async () => {
  let calls = 0;
  assert.equal(await resolveInput('https://b23.tv/first', async url => {
    calls++;
    return new Response(null, { status: 302, headers: { location: url.endsWith('first') ? '/second' : `https://www.bilibili.com/video/${bvid}` } });
  }), bvid);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(resolveInput('https://b23.tv/loop', async () => { calls++; return new Response(null, { status: 302, headers: { location: '/loop' } }); }));
  assert.equal(calls, 1);
  await assert.rejects(resolveInput('https://b23.tv/broken', async () => new Response('no redirect')));
  await assert.rejects(resolveInput('https://b23.tv/timeout', async () => { throw new DOMException('timeout', 'TimeoutError'); }));
});

test('API returns the matching collection and direct link, and misses cannot become arbitrary downloads', async () => {
  const response = await worker.fetch(endpoint(bvid), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.bvid, bvid);
  assert.equal(body.imageCount, 2);
  assert.equal(body.downloadUrl, `/downloads/${bvid}.zip`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const input of ['BV1xx411c7mD', 'https://evil.example/video/BV1LwhB65E8e/']) {
    const failed = await worker.fetch(endpoint(input), env);
    assert([400, 404].includes(failed.status));
    assert.equal(failed.headers.get('location'), null);
  }
});

test('direct video links redirect to catalogued packages, dropping tracking parameters', async () => {
  for (const method of ['GET', 'HEAD']) {
    const r = await worker.fetch(new Request(`https://gallery.example/video/${bvid}/?raw=1&next=https://evil.test`, { method }), env);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `/downloads/${bvid}.zip`);
    const automatic = await worker.fetch(new Request(`https://gallery.example/video/${bvid}/?next=https://evil.test`, { method }), env);
    assert.equal(automatic.status, 302);
    assert.equal(automatic.headers.get('location'), `/download/?video=${bvid}&auto=1`);
  }
  const missing = await worker.fetch(new Request('https://gallery.example/video/BV1xx411c7mD/'), env);
  assert.equal(missing.status, 302);
  assert.match(missing.headers.get('location'), /^\/download\/\?bvid=BV1xx411c7mD/);
});

test('same-origin packages work in a local HTTP runtime without weakening external targets', async () => {
  const request = new Request('http://127.0.0.1:8789/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: bvid }) });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const unsafe = { ...video, download: { url: 'http://evil.test/downloads/' + bvid + '.zip', bytes: 100 } };
  const unsafeEnv = { ASSETS: { fetch: async () => Response.json({ videos: [unsafe] }) } };
  assert.equal((await worker.fetch(endpoint(bvid), unsafeEnv)).status, 503);
});

test('rejects invalid API methods, JSON, cross-site requests and oversized bodies', async () => {
  const wrongMethod = await worker.fetch(new Request('https://gallery.example/api/resolve'), env);
  assert.equal(wrongMethod.status, 405);
  const wrongJSON = await worker.fetch(new Request('https://gallery.example/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), env);
  assert.equal(wrongJSON.status, 400);
  const crossSite = await worker.fetch(endpoint(bvid, { headers: { origin: 'https://evil.test', 'content-type': 'application/json' } }), env);
  assert.equal(crossSite.status, 403);
  const oversized = await worker.fetch(endpoint('x'.repeat(20000)), env);
  assert.equal(oversized.status, 413);
});

test('existing assets bypass the new behavior and unavailable catalog does not produce a download', async () => {
  const root = await worker.fetch(new Request('https://gallery.example/'), env);
  assert.equal(await root.text(), 'existing asset');
  for (const path of ['/download/', '/download/page.js', '/download/page.css']) {
    const asset = await worker.fetch(new Request('https://gallery.example' + path), env);
    assert.equal(asset.status, 200, path);
    assert.equal(await asset.text(), 'existing asset');
  }
  const failed = await worker.fetch(endpoint(bvid), { ASSETS: { fetch: async () => new Response('unavailable', { status: 503 }) } });
  assert.equal(failed.status, 503);
});
