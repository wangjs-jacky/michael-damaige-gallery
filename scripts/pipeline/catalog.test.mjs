import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageEpisode } from './release.mjs';
import { validateEpisodeProof } from './proof.mjs';

const oldBV = 'BV1LwhB65E8e', newBV = 'BV1xx411c7mD';
const now = '2026-11-26T08:00:00.000Z';
const fingerprint = bytes => ({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
const json = value => JSON.stringify(value, null, 2) + '\n';
const quote = '保留原话与条件。</script><script>alert(1)</script>\u2028下一句原话。';
const pngResult = spawnSync('python3', ['-c', `
import base64,json,struct,zlib
def chunk(t,b): return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
p=b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1080,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\\0'+b'\\0'*3240))+chunk(b'IEND',b'')
print(json.dumps({'base64':base64.b64encode(p).decode(),'crc32':zlib.crc32(p)&0xffffffff}))
`], { encoding: 'utf8' });
assert.equal(pngResult.status, 0, pngResult.stderr);
const pngFixture = JSON.parse(pngResult.stdout), png = Buffer.from(pngFixture.base64, 'base64');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gallery-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseline = join(root, 'baseline'), output = join(root, 'candidate'), project = join(root, 'project'), episode = join(root, 'episode');
  for (const path of [join(baseline, 'public/images', oldBV), join(baseline, 'public/downloads'), join(baseline, 'public/download'), join(project, 'public/download'), join(project, 'src'), join(episode, 'cards'), join(episode, 'frames')]) await mkdir(path, { recursive: true });
  const image = { id: 'old-image', src: `/images/${oldBV}/old-image.png`, width: 1080, height: 1, ...fingerprint(png), text: '旧原话', start: 0 };
  const catalog = { author: 'Michael大麦哥', updated: '2026-11-03', videoCount: 1, imageCount: 1, videos: [{ bvid: oldBV, title: '旧期', source: `https://www.bilibili.com/video/${oldBV}/`, batch: 'history', approval: 'approved', images: [image], download: { url: `/downloads/${oldBV}.zip`, bytes: 8, sha256: 'f'.repeat(64) } }] };
  const publication = { schemaVersion: 1, timeZone: 'Asia/Shanghai', fetchedAt: '2026-11-03T00:00:00Z', videos: { [oldBV]: { publishedAt: '2026-09-24T07:00:00+08:00', publishedDate: '2026-09-24', pubdate: 1790204400 } } };
  const homepage = '<!doctype html>\n<main data-preserve="photo-wall">正式照片墙UI</main>\n<script id="catalog-data" type="application/json">' + JSON.stringify(catalog) + '</script>\n<script type="application/json" id="publication-data">' + json(publication) + '</script>\n<script>window.oldUI=true</script>\n';
  const assets = {
    'index.html': homepage, 'catalog.json': json(catalog), 'video-publish-dates.json': json(publication),
    'theme.css': '/* frozen UI */\n', [`images/${oldBV}/old-image.png`]: png,
    [`downloads/${oldBV}.zip`]: 'old ZIP rollback bytes',
    'download/index.html': 'old download HTML', 'download/page.js': 'old download JS', 'download/page.css': 'old download CSS',
  };
  const files = [];
  for (const [source, content] of Object.entries(assets)) {
    const bytes = Buffer.from(content);
    await writeFile(join(baseline, 'public', source), bytes);
    files.push({ source, ...fingerprint(bytes), url: source === 'index.html' ? '/' : source === 'download/index.html' ? '/download/' : '/' + source, immutable: false, contentType: source.endsWith('.png') ? 'image/png' : source.endsWith('.json') ? 'application/json' : source.endsWith('.zip') ? 'application/zip' : 'text/plain' });
  }
  const controls = { headers: Buffer.from('/*\n  X-Content-Type-Options: nosniff\n'), worker: Buffer.from('export default { fetch() { return new Response("old") } };\n'), wrangler: Buffer.from(json({ name: 'michael-damaige-gallery', compatibility_date: '2026-11-02', workers_dev: false, preview_urls: false, main: 'worker.mjs', assets: { directory: './public', binding: 'ASSETS', not_found_handling: '404-page', run_worker_first: ['/api/*', '/video/*', '/download/BV*'] } })) };
  for (const [name, source] of [['headers', 'public/_headers'], ['worker', 'worker.mjs'], ['wrangler', 'wrangler.json']]) await writeFile(join(baseline, source), controls[name]);
  await writeFile(join(baseline, 'release-manifest.json'), json({ version: 1, worker: { name: 'michael-damaige-gallery' }, files, controls: Object.fromEntries(Object.entries(controls).map(([name, bytes]) => [name, fingerprint(bytes)])) }));
  await writeFile(join(project, 'src/worker.mjs'), 'import { value } from "./value.mjs"; export default { fetch() { return new Response(value); } };\n');
  await writeFile(join(project, 'src/value.mjs'), 'export const value="bundled current worker";\n');
  for (const file of ['index.html', 'page.js', 'page.css']) await writeFile(join(project, 'public/download', file), 'current download ' + file);
  const source = { id: newBV, title: '新期</script>标题', author: 'Michael大麦哥', url: `https://www.bilibili.com/video/${newBV}/`, duration: 10, video: 'source.mp4', width: 1920, height: 1080 };
  const metadata = { bvid: newBV, title: source.title, author: source.author, uid: 324213598, source: source.url, publishedAt: '2026-11-26T07:00:00+08:00', duration: 10, page: 1, cid: 123 };
  const segment = { id: 's0001', start: 0, end: 2, text: quote }, visual = { time: 1, role: 'speaker', reason: '实际原画面' };
  const plan = { cards: [{ id: 'fresh-01', visual, blocks: [{ evidence: ['s0001'] }] }] };
  const inputs = {
    'source.json': source, 'metadata.json': metadata, 'transcript.json': { source: 'local-asr', segments: [segment] }, 'plan.json': plan,
    'frames.json': [{ key: 'fresh-01-hero', selected: 'frames/fresh-at.jpg', role: 'speaker', reason: '实际原画面', candidates: [{ time: 1, file: 'frames/fresh-at.jpg' }] }],
    'evidence.json': [{ card: 'fresh-01', block: 0, segments: [segment], visual }],
    'cards.json': [{ card: 'fresh-01', file: 'cards/fresh-01.png', width: 1080, height: 1 }],
  };
  for (const [name, value] of Object.entries(inputs)) await writeFile(join(episode, name), json(value));
  await writeFile(join(episode, 'cards/fresh-01.png'), png);
  await writeFile(join(episode, 'frames/fresh-at.jpg'), 'private frame evidence');
  return { root, baseline, output, project, episode, inputs, catalog, publication, homepage, files };
}

const stage = (f, extra = {}) => stageEpisode({ baselineRelease: f.baseline, outputRelease: f.output, projectRoot: f.project, episodeDir: f.episode, now, ...extra });
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const inline = (html, id) => JSON.parse(html.match(new RegExp('<script\\b[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'))[1]);

test('one episode is frozen incrementally while all prior images, ZIPs and UI bytes remain intact', async t => {
  const f = await fixture(t), result = await stage(f);
  assert.deepEqual(result.newFiles, [`images/${newBV}/fresh-01.png`]);
  assert.equal(result.bvid, newBV);
  assert.equal(result.migrationOnly, false);
  for (const source of ['theme.css', `images/${oldBV}/old-image.png`, `downloads/${oldBV}.zip`]) assert.deepEqual(await readFile(join(f.output, 'public', source)), await readFile(join(f.baseline, 'public', source)));
  const catalog = await readJSON(join(f.output, 'public/catalog.json'));
  assert.equal(catalog.videoCount, 2); assert.equal(catalog.imageCount, 2);
  assert.equal(catalog.videos[0].approval, 'review'); assert.equal(catalog.videos[0].batch, 'new');
  assert.equal(catalog.videos[0].images[0].text, quote);
  assert.equal(catalog.videos[0].images[0].src, `images/${newBV}/fresh-01.png`);
  assert.equal(catalog.videos[0].images[0].crc32, pngFixture.crc32);
  assert.equal(catalog.videos[1].images[0].crc32, pngFixture.crc32);
  assert.equal(catalog.videos[1].download.url, `/video/${oldBV}/?raw=1`);
  assert.equal(catalog.videos[1].download.sha256, undefined);
  const html = await readFile(join(f.output, 'public/index.html'), 'utf8');
  assert.deepEqual(inline(html, 'catalog-data'), catalog);
  assert.deepEqual(inline(html, 'publication-data'), await readJSON(join(f.output, 'public/video-publish-dates.json')));
  assert(html.includes('data-preserve="photo-wall">正式照片墙UI'));
  assert(html.endsWith('<script>window.oldUI=true</script>\n'));
  assert(!html.includes('</script><script>alert(1)</script>'));
  assert.equal(result.changeProof.homepage.outsideDataBeforeSHA256, result.changeProof.homepage.outsideDataAfterSHA256);
  assert.equal(result.changeProof.episode.uid, 324213598);
  assert.equal(Object.keys(result.changeProof.episode.provenance).length, 7);
  assert.deepEqual((await readdir(join(f.output, 'public/downloads'))), [`${oldBV}.zip`]);
  assert(!await readFile(join(f.output, 'worker.mjs'), 'utf8').then(source => /\bimport\s|\bimport\(/.test(source)));
  const bundled = await import(pathToFileURL(join(f.output, 'worker.mjs')));
  assert.equal(await bundled.default.fetch().text(), 'bundled current worker');
  const manifest = await readJSON(join(f.output, 'release-manifest.json'));
  assert.deepEqual(manifest.changeProof, { source: 'change-proof.json', ...fingerprint(await readFile(result.changeProofPath)) });
  const baselineManifest = await readFile(join(f.baseline, 'release-manifest.json'));
  const approved = await validateEpisodeProof(
    { path: f.output, manifest, headers: await readFile(join(f.output, 'public/_headers'), 'utf8') },
    { path: f.baseline, manifest: JSON.parse(baselineManifest), manifestSha256: fingerprint(baselineManifest).sha256, headers: await readFile(join(f.baseline, 'public/_headers'), 'utf8') },
  );
  assert.deepEqual(approved.sort(), [...result.changedPreviousFiles, ...result.newFiles].sort());
});

test('migration-only freeze adds CRC and on-demand links without new public assets or date changes', async t => {
  const f = await fixture(t), result = await stage(f, { episodeDir: undefined });
  assert.equal(result.migrationOnly, true); assert.equal(result.bvid, null);
  assert.deepEqual(result.newFiles, []);
  assert(!result.changedPreviousFiles.includes('video-publish-dates.json'));
  assert.deepEqual(await readFile(join(f.output, 'public/video-publish-dates.json')), await readFile(join(f.baseline, 'public/video-publish-dates.json')));
  assert.equal((await readJSON(join(f.output, 'public/catalog.json'))).videos[0].images[0].crc32, pngFixture.crc32);
  assert.deepEqual(await readFile(join(f.output, 'public/_headers')), await readFile(join(f.baseline, 'public/_headers')));
  assert.deepEqual(await readFile(join(f.output, 'wrangler.json')), await readFile(join(f.baseline, 'wrangler.json')));
});

test('an existing episode cannot be replaced by a new render', async t => {
  const f = await fixture(t);
  f.inputs['metadata.json'].bvid = oldBV; f.inputs['metadata.json'].source = `https://www.bilibili.com/video/${oldBV}/`;
  f.inputs['source.json'].id = oldBV; f.inputs['source.json'].url = f.inputs['metadata.json'].source;
  for (const name of ['metadata.json', 'source.json']) await writeFile(join(f.episode, name), json(f.inputs[name]));
  await assert.rejects(stage(f));
  await assert.rejects(readFile(join(f.output, 'release-manifest.json')), { code: 'ENOENT' });
});

test('corrupted baseline assets fail before a candidate is created', async t => {
  const f = await fixture(t);
  await writeFile(join(f.baseline, 'public/theme.css'), 'tampered');
  await assert.rejects(stage(f), /Baseline asset changed/);
  await assert.rejects(readFile(join(f.output, 'release-manifest.json')), { code: 'ENOENT' });
});

test('foreign authors or rewritten quote evidence cannot enter the public catalog', async t => {
  for (const kind of ['author', 'quote']) {
    const f = await fixture(t);
    if (kind === 'author') {
      f.inputs['metadata.json'].uid = 1;
      await writeFile(join(f.episode, 'metadata.json'), json(f.inputs['metadata.json']));
    } else {
      f.inputs['evidence.json'][0].segments[0].text = '编写的新摘要';
      await writeFile(join(f.episode, 'evidence.json'), json(f.inputs['evidence.json']));
    }
    await assert.rejects(stage(f));
    await assert.rejects(readFile(join(f.output, 'release-manifest.json')), { code: 'ENOENT' });
  }
});

test('a frozen output cannot be reused and source catalog bytes are never rewritten', async t => {
  const f = await fixture(t), before = await readFile(join(f.baseline, 'public/catalog.json'));
  await stage(f);
  await assert.rejects(stage(f), /overwrite|existing/);
  assert.deepEqual(await readFile(join(f.baseline, 'public/catalog.json')), before);
});

test('source BV contradictions, non-first pages and invalid PNG image data are refused', async t => {
  for (const kind of ['identity', 'page', 'PNG']) {
    const f = await fixture(t);
    if (kind === 'identity') {
      f.inputs['source.json'].id = oldBV;
      await writeFile(join(f.episode, 'source.json'), json(f.inputs['source.json']));
    } else if (kind === 'page') {
      f.inputs['metadata.json'].page = 2;
      await writeFile(join(f.episode, 'metadata.json'), json(f.inputs['metadata.json']));
    } else {
      const damaged = spawnSync('python3', ['-c', `
import struct,zlib,sys
p=sys.stdin.buffer.read(); n=struct.unpack('>I',p[33:37])[0]; b=b'not a zlib image'; t=b'IDAT'
sys.stdout.buffer.write(p[:33]+struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)+p[45+n:])
`], { input: png });
      assert.equal(damaged.status, 0, damaged.stderr?.toString());
      await writeFile(join(f.episode, 'cards/fresh-01.png'), damaged.stdout);
    }
    await assert.rejects(stage(f));
    await assert.rejects(readFile(join(f.output, 'release-manifest.json')), { code: 'ENOENT' });
  }
});

test('baseline control hashes are verified alongside all public asset hashes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.baseline, 'worker.mjs'), 'export default {};');
  await assert.rejects(stage(f), /Baseline control changed/);
  await assert.rejects(readFile(join(f.output, 'release-manifest.json')), { code: 'ENOENT' });
});
