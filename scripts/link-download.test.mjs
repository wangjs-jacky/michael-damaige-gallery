import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import worker, { parseInput, resolveInput } from '../src/worker.mjs';

const bvid = 'BV1LwhB65E8e';
const digits = new TextEncoder().encode('123456789'), greeting = new TextEncoder().encode('hello world\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const video = { bvid, title: '让时间慢下来的10个方法', images: [
  { id: 'digits', src: `images/${bvid}/digits.png`, bytes: 9, crc32: 0xcbf43926, sha256: sha(digits) },
  { id: 'greeting', src: `images/${bvid}/greeting.png`, bytes: 12, crc32: 0xaf083b2d, sha256: sha(greeting) },
] };
const catalog = { videos: [video] };
const env = { ASSETS: { fetch: async request => {
  const path = new URL(request.url ?? request).pathname;
  if (path === '/catalog.json') return Response.json(catalog);
  if (path === `/images/${bvid}/digits.png`) return new Response(digits);
  if (path === `/images/${bvid}/greeting.png`) return new Response(greeting);
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

test('API returns an on-demand plan and image verification metadata without a prebuilt ZIP', async () => {
  const response = await worker.fetch(endpoint(bvid), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.bvid, bvid);
  assert.equal(body.imageCount, 2);
  assert.equal(body.downloadUrl, `/video/${bvid}/?raw=1`);
  assert.equal(body.bytes, 239);
  assert.equal(body.sha256, undefined);
  assert.deepEqual(body.entries.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })), [
    { name: 'digits.png', bytes: 9, sha256: sha(digits) },
    { name: 'greeting.png', bytes: 12, sha256: sha(greeting) },
  ]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const input of ['BV1xx411c7mD', 'https://evil.example/video/BV1LwhB65E8e/']) {
    const failed = await worker.fetch(endpoint(input), env);
    assert([400, 404].includes(failed.status));
    assert.equal(failed.headers.get('location'), null);
  }
});

test('raw video links stream originals while ordinary links enter automatic verified download', async () => {
  for (const method of ['GET', 'HEAD']) {
    const r = await worker.fetch(new Request(`https://gallery.example/video/${bvid}/?raw=1&next=https://evil.test`, { method }), env);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '239');
    assert.match(r.headers.get('content-type'), /application\/zip/);
    if (method === 'HEAD') assert.equal(r.body, null);
    else assert.equal((await r.arrayBuffer()).byteLength, 239);
    const automatic = await worker.fetch(new Request(`https://gallery.example/video/${bvid}/?next=https://evil.test`, { method }), env);
    assert.equal(automatic.status, 302);
    assert.equal(automatic.headers.get('location'), `/download/?video=${bvid}&auto=1`);
  }
  const missing = await worker.fetch(new Request('https://gallery.example/video/BV1xx411c7mD/'), env);
  assert.equal(missing.status, 302);
  assert.match(missing.headers.get('location'), /^\/download\/\?bvid=BV1xx411c7mD/);
});

test('on-demand archives work in local HTTP and ignore obsolete or malicious prebuilt package URLs', async () => {
  const request = new Request('http://127.0.0.1:8789/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: bvid }) });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const unsafe = { ...video, download: { url: 'http://evil.test/downloads/' + bvid + '.zip', bytes: 100 } };
  const unsafeEnv = { ASSETS: { fetch: async () => Response.json({ videos: [unsafe] }) } };
  const ignored = await worker.fetch(endpoint(bvid), unsafeEnv);
  assert.equal(ignored.status, 200);
  assert.equal((await ignored.json()).downloadUrl, `/video/${bvid}/?raw=1`);
});

test('raw archive reads only this episode original assets and produces a valid ZIP', async () => {
  const paths = [];
  const monitored = { ASSETS: { fetch(request) {
    paths.push(new URL(request.url).pathname);
    return env.ASSETS.fetch(request);
  } } };
  const head = await worker.fetch(new Request(`https://gallery.example/video/${bvid}/?raw=1`, { method: 'HEAD' }), monitored);
  assert.equal(head.status, 200);
  assert.deepEqual(paths, ['/catalog.json']);
  paths.length = 0;
  const response = await worker.fetch(new Request(`https://gallery.example/download/${bvid}/?raw=1`), monitored);
  assert.deepEqual(paths, ['/catalog.json']);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(paths, ['/catalog.json', `/images/${bvid}/digits.png`, `/images/${bvid}/greeting.png`]);
  const unpack = spawnSync('python3', ['-c', 'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; assert z.read("digits.png")==b"123456789"; assert z.read("greeting.png")==b"hello world\\n"'], { input: bytes, encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
});

test('invalid archive metadata fails resolve without generating or reading any package', async () => {
  for (const patch of [{ crc32: undefined }, { src: 'https://evil.test/private.png' }]) {
    const invalidVideo = { ...video, images: [{ ...video.images[0], ...patch }] };
    const broken = { ASSETS: { fetch: async () => Response.json({ videos: [invalidVideo] }) } };
    const response = await worker.fetch(endpoint(bvid), broken);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'ARCHIVE_UNAVAILABLE');
  }
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
