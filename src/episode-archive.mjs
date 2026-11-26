const encoder = new TextEncoder();
const UINT32_LIMIT = 0xffffffff;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const UTF8 = 0x0800;
const DOS_DATE = 0x0021; // 1980-01-01, 00:00:00; deterministic across hosts.

function invalid(message) { return new TypeError('Invalid episode archive: ' + message); }

function layout(entries) {
  let directoryOffset = 0, directoryBytes = 0;
  for (const entry of entries) {
    const length = encoder.encode(entry.name).byteLength;
    directoryOffset += 30 + length + entry.bytes;
    directoryBytes += 46 + length;
  }
  const bytes = directoryOffset + directoryBytes + 22;
  if (bytes >= UINT32_LIMIT) throw invalid('archive size exceeds the classic ZIP limit');
  return { bytes, directoryOffset, directoryBytes };
}

/** Validate trusted import metadata without reading or packaging any originals. */
export function buildArchivePlan(video) {
  const bvid = video?.bvid;
  if (typeof bvid !== 'string' || bvid.length !== 12 || !/^BV1[A-Za-z0-9]{9}$/.test(bvid)) throw invalid('invalid BV identifier');
  if (!Array.isArray(video.images) || video.images.length < 1 || video.images.length >= 0xffff) throw invalid('invalid image count for classic ZIP');
  const names = new Set();
  const entries = video.images.map(image => {
    const id = image?.id;
    if (typeof id !== 'string' || id.length < 1 || id.length > 128 || /[^A-Za-z0-9_-]/.test(id) || !/^[A-Za-z0-9]/.test(id)) throw invalid('invalid image identifier');
    const name = id + '.png', expected = `images/${bvid}/${name}`;
    if (image.src !== expected && image.src !== '/' + expected) throw invalid('image path must belong to the current episode');
    const folded = name.toLowerCase();
    if (names.has(folded)) throw invalid('duplicate image filename');
    names.add(folded);
    if (!Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > MAX_IMAGE_BYTES) throw invalid('invalid image bytes');
    if (!Number.isInteger(image.crc32) || image.crc32 < 0 || image.crc32 > UINT32_LIMIT) throw invalid('invalid image CRC32');
    if (typeof image.sha256 !== 'string' || image.sha256.length !== 64 || /[^A-Fa-f0-9]/.test(image.sha256)) throw invalid('invalid image SHA256');
    return { name, src: '/' + expected, bytes: image.bytes, crc32: image.crc32, sha256: image.sha256.toLowerCase() };
  });
  return { bytes: layout(entries).bytes, entries };
}

function localHeader(entry) {
  const name = encoder.encode(entry.name), header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, UTF8, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.bytes, true);
  view.setUint32(22, entry.bytes, true);
  view.setUint16(26, name.length, true);
  header.set(name, 30);
  return header;
}

function centralHeader(entry, offset) {
  const name = encoder.encode(entry.name), header = new Uint8Array(46 + name.length), view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, UTF8, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.bytes, true);
  view.setUint32(24, entry.bytes, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, offset, true);
  header.set(name, 46);
  return header;
}

function endRecord(count, directoryOffset, directoryBytes) {
  const record = new Uint8Array(22), view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, directoryBytes, true);
  view.setUint32(16, directoryOffset, true);
  return record;
}

/** Read originals only as the client consumes them; CRC/SHA are import-time metadata. */
export function createArchiveResponse(video, readImage) {
  if (typeof readImage !== 'function') throw invalid('readImage must be a function');
  const { bytes, entries } = buildArchivePlan(video);
  const { directoryOffset, directoryBytes } = layout(entries);
  const offsets = [];
  let index = 0, centralIndex = 0, offset = 0, consumed = 0;
  let reader = null, phase = 'header', canceled = false, cancelReason;

  async function cancelReader(reason) {
    const active = reader;
    reader = null;
    if (!active) return;
    try { await active.cancel(reason); }
    finally { active.releaseLock(); }
  }

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        // This consumes one original stream, advancing metadata phases only until
        // one output chunk is ready. It never queries task state or retries I/O.
        for (;;) {
          if (canceled) return;
          if (phase === 'header') {
            if (index === entries.length) { phase = 'central'; continue; }
            const entry = entries[index], response = await readImage(entry.src);
            if (canceled) { await response?.body?.cancel(cancelReason); return; }
            if (!response?.ok || !response.body) {
              await response?.body?.cancel();
              throw new Error('Original image unavailable: ' + entry.src);
            }
            reader = response.body.getReader();
            const declared = response.headers.get('content-length');
            if (declared !== null && Number(declared) !== entry.bytes) throw new Error('Original image length changed: ' + entry.src);
            const header = localHeader(entry);
            offsets.push(offset);
            offset += header.byteLength;
            consumed = 0;
            phase = 'image';
            controller.enqueue(header);
            return;
          }
          if (phase === 'image') {
            const part = await reader.read();
            if (canceled) return;
            if (part.done) {
              reader.releaseLock();
              reader = null;
              if (consumed !== entries[index].bytes) throw new Error('Original image length changed: ' + entries[index].src);
              index++;
              phase = 'header';
              continue;
            }
            if (!(part.value instanceof Uint8Array)) throw new Error('Original image stream did not return bytes');
            consumed += part.value.byteLength;
            if (consumed > entries[index].bytes) throw new Error('Original image length exceeded metadata: ' + entries[index].src);
            offset += part.value.byteLength;
            controller.enqueue(part.value);
            return;
          }
          if (centralIndex < entries.length) {
            controller.enqueue(centralHeader(entries[centralIndex], offsets[centralIndex]));
            centralIndex++;
            return;
          }
          controller.enqueue(endRecord(entries.length, directoryOffset, directoryBytes));
          controller.close();
          return;
        }
      } catch (error) {
        if (!canceled) controller.error(error);
        try { await cancelReader(error); } catch { /* Preserve the original stream failure. */ }
      }
    },
    async cancel(reason) {
      canceled = true;
      cancelReason = reason;
      await cancelReader(reason);
    },
  }, { highWaterMark: 0 });

  // Workers ignores a manually supplied Content-Length for a generic stream.
  // pipeThrough returns this native readable unchanged, preserving its known
  // length while stream cancellation still propagates back to the image reader.
  const body = typeof globalThis.FixedLengthStream === 'function'
    ? stream.pipeThrough(new globalThis.FixedLengthStream(bytes))
    : stream;
  return new Response(body, { headers: {
    'content-type': 'application/zip',
    'content-length': String(bytes),
    'content-disposition': `attachment; filename="${video.bvid}.zip"`,
    'cache-control': 'no-store, no-transform',
    'x-content-type-options': 'nosniff',
  } });
}
