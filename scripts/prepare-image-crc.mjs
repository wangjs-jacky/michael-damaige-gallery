import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArchivePlan } from '../src/episode-archive.mjs';

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

/** Verify source originals once; output only enriched metadata, never ZIP files. */
export async function prepareImageCRC(inputPath, publicRoot, outputPath) {
  const input = resolve(inputPath), output = resolve(outputPath), root = await realpath(publicRoot);
  try {
    await lstat(output);
    throw new Error('Refusing to overwrite an existing output catalog');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const catalog = JSON.parse(await readFile(input, 'utf8'));
  if (!Array.isArray(catalog.videos) || !catalog.videos.length) throw new Error('Catalog must contain videos');
  const seen = new Set();
  let imageCount = 0;
  for (const video of catalog.videos) {
    if (seen.has(video.bvid)) throw new Error('Duplicate video in catalog');
    seen.add(video.bvid);
    const plan = buildArchivePlan({ ...video, images: video.images?.map(image => ({ ...image, crc32: image.crc32 ?? 0 })) });
    for (let index = 0; index < plan.entries.length; index++) {
      const entry = plan.entries[index], file = await realpath(join(root, entry.src.slice(1)));
      if (!file.startsWith(root + sep)) throw new Error('Original image resolves outside the public root');
      const hash = createHash('sha256');
      let bytes = 0, crc = 0xffffffff;
      for await (const chunk of createReadStream(file)) {
        bytes += chunk.byteLength;
        if (bytes > entry.bytes) throw new Error('Original image bytes changed: ' + entry.src);
        hash.update(chunk);
        for (const value of chunk) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
      }
      if (bytes !== entry.bytes) throw new Error('Original image bytes changed: ' + entry.src);
      if (hash.digest('hex') !== entry.sha256) throw new Error('Original image SHA256 changed: ' + entry.src);
      video.images[index].crc32 = (crc ^ 0xffffffff) >>> 0;
      imageCount++;
    }
  }
  await writeFile(output, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
  return { output, videos: catalog.videos.length, images: imageCount };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error('Usage: node scripts/prepare-image-crc.mjs INPUT_CATALOG IMAGE_PUBLIC_ROOT NEW_OUTPUT');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await prepareImageCRC(...args))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
