import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArchivePlan, createArchiveResponse } from '../src/episode-archive.mjs';

const bvid = 'BV1LwhB65E8e';
const digits = new TextEncoder().encode('123456789');
const greeting = new TextEncoder().encode('hello world\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const images = [
  { id: 'digits', src: `images/${bvid}/digits.png`, bytes: 9, crc32: 0xcbf43926, sha256: sha(digits) },
  { id: 'greeting', src: `/images/${bvid}/greeting.png`, bytes: 12, crc32: 0xaf083b2d, sha256: sha(greeting) },
];
const video = { bvid, images };
const imageData = new Map([[`/images/${bvid}/digits.png`, digits], [`/images/${bvid}/greeting.png`, greeting]]);
const readImage = src => new Response(imageData.get(src));
const clone = value => structuredClone(value);

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('a planned streaming archive is a deterministic valid Store ZIP with exact length and image bytes', async () => {
  const plan = buildArchivePlan(video);
  assert.equal(plan.bytes, 239);
  assert.deepEqual(plan.entries, [
    { name: 'digits.png', src: `/images/${bvid}/digits.png`, bytes: 9, crc32: 0xcbf43926, sha256: sha(digits) },
    { name: 'greeting.png', src: `/images/${bvid}/greeting.png`, bytes: 12, crc32: 0xaf083b2d, sha256: sha(greeting) },
  ]);
  const response = await createArchiveResponse(video, readImage);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-length'), '239');
  assert.match(response.headers.get('content-disposition'), /BV1LwhB65E8e\.zip/);
  assert.match(response.headers.get('cache-control'), /no-transform/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, plan.bytes);
  const again = await createArchiveResponse(video, readImage);
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), bytes);
  const unpack = spawnSync('python3', ['-c', `
import io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    print(json.dumps([{'name': i.filename, 'body': archive.read(i).decode(), 'crc32': i.CRC,
      'method': i.compress_type, 'date': i.date_time, 'utf8': bool(i.flag_bits & 0x800)} for i in archive.infolist()]))
`], { input: bytes, encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  assert.deepEqual(JSON.parse(unpack.stdout), [
    { name: 'digits.png', body: '123456789', crc32: 0xcbf43926, method: 0, date: [1980, 1, 1, 0, 0, 0], utf8: true },
    { name: 'greeting.png', body: 'hello world\n', crc32: 0xaf083b2d, method: 0, date: [1980, 1, 1, 0, 0, 0], utf8: true },
  ]);
});

test('backpressure opens only the current image and does not read data ahead of its header', async () => {
  const opened = [], chunksRead = [];
  const response = await createArchiveResponse(video, src => {
    opened.push(src);
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        chunksRead.push(src);
        if (sent) controller.close();
        else { sent = true; controller.enqueue(imageData.get(src)); }
      },
    }, { highWaterMark: 0 }));
  });
  assert.equal(opened.length, 0);
  const reader = response.body.getReader();
  await reader.read();
  assert.deepEqual(opened, [`/images/${bvid}/digits.png`]);
  assert.equal(chunksRead.length, 0);
  await reader.read();
  assert.equal(chunksRead.length, 1);
  assert.equal(opened.length, 1);
  await reader.cancel('enough');
});

test('missing images fail the response stream instead of producing a complete-looking archive', async () => {
  const response = await createArchiveResponse(video, src => src.endsWith('greeting.png') ? new Response('missing', { status: 404 }) : readImage(src));
  await assert.rejects(response.arrayBuffer(), /unavailable|missing|404/i);
});

for (const [name, changed] of [['short', digits.slice(0, -1)], ['long', Uint8Array.from([...digits, 0])]]) {
  test(`a ${name} original is rejected using actual streamed bytes`, async () => {
    const response = await createArchiveResponse({ bvid, images: [images[0]] }, () => new Response(changed));
    await assert.rejects(response.arrayBuffer(), /length|size|bytes/i);
  });
}

test('cancellation reaches an in-flight original reader and opens no later image', { timeout: 2000 }, async () => {
  const started = deferred(), canceled = deferred(), pending = deferred();
  const opened = [];
  const response = await createArchiveResponse(video, src => {
    opened.push(src);
    return new Response(new ReadableStream({
      pull() { started.resolve(); return pending.promise; },
      cancel(reason) { canceled.resolve(reason); pending.resolve(); },
    }, { highWaterMark: 0 }));
  });
  const reader = response.body.getReader();
  await reader.read();
  const reading = reader.read();
  await started.promise;
  await reader.cancel('user stopped');
  assert.equal(await canceled.promise, 'user stopped');
  assert.equal((await reading).done, true);
  assert.equal(opened.length, 1);
});

test('a late image response is canceled when the archive was canceled while opening it', { timeout: 2000 }, async () => {
  const opening = deferred(), canceled = deferred();
  const response = await createArchiveResponse(video, () => opening.promise);
  const reader = response.body.getReader();
  const reading = reader.read();
  await reader.cancel('left page');
  opening.resolve(new Response(new ReadableStream({ cancel(reason) { canceled.resolve(reason); } }, { highWaterMark: 0 })));
  assert.equal(await canceled.promise, 'left page');
  assert.equal((await reading).done, true);
});

test('unsafe paths, duplicate names and invalid image metadata are rejected before image I/O', () => {
  const badImages = [
    { src: 'https://evil.test/file.png' }, { src: `//evil.test/images/${bvid}/digits.png` },
    { src: 'images/BV1fvpX6BEY5/digits.png' }, { src: `images/${bvid}/../digits.png` },
    { src: `images/${bvid}/%64igits.png` }, { src: `images/${bvid}/digits.png?x=1` },
    { src: `images/${bvid}/digits.jpg` }, { id: '../digits' }, { id: 'digits\n' },
    { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }, { bytes: 25 * 1024 * 1024 + 1 },
    { crc32: undefined }, { crc32: -1 }, { crc32: 0x100000000 }, { crc32: 0.5 },
    { sha256: '0'.repeat(63) }, { sha256: 'z'.repeat(64) }, { sha256: 'a'.repeat(63) + '\n' },
  ];
  for (const patch of badImages) assert.throws(() => buildArchivePlan({ bvid, images: [{ ...images[0], ...patch }] }), JSON.stringify(patch));
  for (const invalid of ['', bvid + '\n', 'BV1/../../xx', null]) assert.throws(() => buildArchivePlan({ bvid: invalid, images }));
  assert.throws(() => buildArchivePlan({ bvid, images: [] }));
  assert.throws(() => buildArchivePlan({ bvid, images: [images[0], images[0]] }));
  assert.throws(() => buildArchivePlan({ bvid, images: [images[0], { ...images[0], id: 'DIGITS', src: `images/${bvid}/DIGITS.png` }] }));
  assert.equal(buildArchivePlan({ bvid, images: [{ ...images[0], crc32: 0xffffffff }] }).entries[0].crc32, 0xffffffff);
});

test('classic ZIP limits reject Zip64 counts and offsets using metadata alone', () => {
  assert.throws(() => buildArchivePlan({ bvid, images: Array(65535).fill(images[0]) }));
  const tooLarge = Array.from({ length: 170 }, (_, index) => ({ ...images[0], id: 'image-' + index, src: `images/${bvid}/image-${index}.png`, bytes: 25 * 1024 * 1024 }));
  assert.throws(() => buildArchivePlan({ bvid, images: tooLarge }), /large|limit|ZIP|size/i);
});

const crcScript = fileURLToPath(new URL('./prepare-image-crc.mjs', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'episode-crc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'public'), input = join(directory, 'catalog.json'), output = join(directory, 'catalog-crc.json');
  await mkdir(join(root, 'images', bvid), { recursive: true });
  for (const image of images) await writeFile(join(root, 'images', bvid, image.id + '.png'), imageData.get('/' + image.src.replace(/^\//, '')));
  const catalog = { author: 'fixture', videos: [{ ...video, images: images.map(({ crc32: _crc, ...image }) => image) }] };
  await writeFile(input, JSON.stringify(catalog));
  return { directory, root, input, output, catalog };
}
const runCRC = f => spawnSync(process.execPath, [crcScript, f.input, f.root, f.output], { encoding: 'utf8' });

test('the CRC CLI verifies originals and writes only a new enriched catalog, refusing overwrite', async t => {
  const f = await fixture(t), original = await readFile(f.input);
  const result = runCRC(f);
  assert.equal(result.status, 0, result.stderr);
  const enrichedBytes = await readFile(f.output), enriched = JSON.parse(enrichedBytes);
  assert.deepEqual(enriched.videos[0].images.map(image => image.crc32), [0xcbf43926, 0xaf083b2d]);
  assert.equal(enriched.author, 'fixture');
  assert.deepEqual(await readFile(f.input), original);
  assert.deepEqual(await readFile(join(f.root, 'images', bvid, 'digits.png')), Buffer.from(digits));
  assert.deepEqual((await readdir(f.directory)).sort(), ['catalog-crc.json', 'catalog.json', 'public']);
  assert.notEqual(runCRC(f).status, 0);
  assert.deepEqual(await readFile(f.output), enrichedBytes);
});

test('the CRC CLI refuses changed source bytes without leaving an output catalog', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'images', bvid, 'digits.png'), '987654321');
  const result = runCRC(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA|hash|checksum/i);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});
