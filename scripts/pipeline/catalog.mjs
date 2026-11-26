import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inflateSync } from 'node:zlib';
import { buildArchivePlan } from '../../src/episode-archive.mjs';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const CREATOR_UID = 324213598;
const ARTIFACTS = ['source.json', 'metadata.json', 'transcript.json', 'plan.json', 'frames.json', 'evidence.json', 'cards.json'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const bvidOK = value => typeof value === 'string' && value.length === 12 && /^BV1[A-Za-z0-9]{9}$/.test(value);
const textOK = value => typeof value === 'string' && value.trim().length > 0;
const roles = new Set(['speaker', 'chart', 'demonstration', 'scene']);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function shanghaiDate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function publicationOf(metadata) {
  let milliseconds;
  if (metadata.pubdate !== undefined) {
    requireValue(Number.isSafeInteger(metadata.pubdate) && metadata.pubdate > 0, 'Invalid publication timestamp');
    milliseconds = metadata.pubdate * 1000;
  }
  if (metadata.publishedAt !== undefined) {
    requireValue(typeof metadata.publishedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(metadata.publishedAt), 'Invalid publication ISO date');
    const parsed = Date.parse(metadata.publishedAt);
    requireValue(Number.isFinite(parsed) && (milliseconds === undefined || parsed === milliseconds), 'Publication dates disagree');
    milliseconds = parsed;
  }
  requireValue(Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds % 1000 === 0, 'Publication date is required');
  const date = new Date(milliseconds);
  return { publishedAt: date.toISOString(), publishedDate: shanghaiDate(date), pubdate: milliseconds / 1000 };
}
async function insideFile(root, source, maximum = MAX_IMAGE_BYTES - 1) {
  requireValue(typeof source === 'string' && source.length > 0 && !isAbsolute(source) && !source.includes('\\') && !source.includes('\0') && source.split('/').every(part => part && part !== '.' && part !== '..'), 'File path leaves the episode or public root');
  const path = await realpath(join(root, source)), local = relative(root, path);
  requireValue(local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep), 'File path resolves outside the root');
  const info = await stat(path);
  requireValue(info.isFile() && info.size > 0 && info.size <= maximum, 'Artifact is not a bounded regular file');
  return path;
}
async function fileBytes(root, source, maximum) {
  const sourcePath = await insideFile(root, source, maximum);
  const bytes = await readFile(sourcePath);
  requireValue(bytes.length > 0 && bytes.length <= (maximum ?? MAX_IMAGE_BYTES - 1), 'Artifact changed size while reading');
  return { sourcePath, data: bytes };
}
function pngDimensions(bytes) {
  requireValue(bytes.length >= 57 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG signature');
  let offset = 8, width, height, ended = false, hasData = false;
  const seen = new Set(), compressedChunks = [];
  while (offset < bytes.length) {
    requireValue(offset + 12 <= bytes.length, 'Truncated PNG chunk');
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    requireValue(end <= bytes.length, 'Truncated PNG chunk data');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    requireValue(/^[A-Za-z]{4}$/.test(type) && crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'PNG chunk CRC mismatch');
    if (offset === 8) {
      requireValue(type === 'IHDR' && size === 13, 'PNG must begin with IHDR');
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      const depth = bytes[offset + 16], color = bytes[offset + 17];
      requireValue(width === 1080 && height >= 1 && height <= 12000 && depth === 8 && color === 2 && bytes[offset + 18] === 0 && bytes[offset + 19] === 0 && bytes[offset + 20] === 0, 'Renderer PNG must be bounded RGB8 without interlacing');
    } else requireValue(type !== 'IHDR', 'Duplicate PNG IHDR');
    requireValue(!/^[A-Z]/.test(type) || ['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type), 'Unsupported critical PNG chunk');
    if (type === 'IDAT') {
      requireValue(!ended && !seen.has('after-IDAT'), 'Nonconsecutive PNG image data');
      hasData ||= size > 0; compressedChunks.push(bytes.subarray(offset + 8, end - 4));
    }
    else if (seen.has('IDAT') && type !== 'IEND') seen.add('after-IDAT');
    seen.add(type);
    offset = end;
    if (type === 'IEND') {
      requireValue(size === 0 && hasData && offset === bytes.length, 'Invalid PNG end or missing image data');
      ended = true; break;
    }
  }
  requireValue(ended, 'PNG has no IEND');
  const stride = width * 3 + 1, expectedBytes = stride * height;
  const compressed = Buffer.concat(compressedChunks);
  const decoded = inflateSync(compressed, { maxOutputLength: expectedBytes, info: true });
  requireValue(decoded.buffer.length === expectedBytes && decoded.engine.bytesWritten === compressed.length, 'PNG pixel stream length or zlib boundary is invalid');
  for (let row = 0; row < height; row++) requireValue(decoded.buffer[row * stride] <= 4, 'PNG row has an invalid filter');
  return { width, height };
}
function validateContent(source, transcript, plan, evidence) {
  requireValue(Number.isFinite(source.duration) && source.duration > 0 && source.duration < 4 * 3600, 'Invalid source duration');
  requireValue(Array.isArray(transcript?.segments) && transcript.segments.length > 0 && transcript.segments.length <= 10000, 'Transcript must contain original segments');
  const byId = new Map();
  let previous = -1;
  for (const [index, row] of transcript.segments.entries()) {
    requireValue(row && typeof row.id === 'string' && /^s[0-9]{4,8}$/.test(row.id) && !byId.has(row.id) && textOK(row.text) && Number.isFinite(row.start) && Number.isFinite(row.end) && row.start >= 0 && row.start >= previous && row.end > row.start && row.end <= source.duration + 0.5, 'Invalid original transcript order or segment');
    previous = row.start; byId.set(row.id, { row, index });
  }
  requireValue(Array.isArray(plan?.cards) && plan.cards.length > 0 && plan.cards.length <= 256, 'Plan must contain cards');
  const ids = new Set(), expected = [], visuals = new Map(), selectedCards = new Map();
  let lastIndex = -1;
  function refs(value) {
    requireValue(Array.isArray(value) && value.length > 0 && value.length <= 1000 && new Set(value).size === value.length, 'Missing or duplicate subtitle evidence');
    const rows = value.map(id => { requireValue(byId.has(id), 'Unknown subtitle evidence'); return byId.get(id); });
    requireValue(rows.every((row, index) => !index || row.index > rows[index - 1].index), 'Subtitle evidence is not in original order');
    return rows;
  }
  function visual(value, implicit) {
    requireValue(value && Number.isFinite(value.time) && value.time >= 0 && value.time <= source.duration && roles.has(value.role) && textOK(value.reason), 'Invalid visual evidence');
    const selected = value.evidence === undefined ? implicit : refs(value.evidence).map(item => item.row);
    requireValue(selected.some(row => value.time >= row.start && value.time <= row.end), 'Visual time is outside its original evidence');
  }
  for (const card of plan.cards) {
    requireValue(card && typeof card.id === 'string' && card.id.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card.id) && !ids.has(card.id), 'Card IDs must be unique kebab-case');
    ids.add(card.id);
    requireValue(!['title', 'subtitle', 'takeaway', 'theme'].some(key => Object.hasOwn(card, key)) && Array.isArray(card.blocks) && card.blocks.length > 0 && card.blocks.length <= 16, 'Card contains added prose or no blocks');
    const all = [], displayed = [];
    for (const [index, block] of card.blocks.entries()) {
      requireValue(block && !['heading', 'text', 'quote', 'caption'].some(key => Object.hasOwn(block, key)), 'Block contains added prose');
      const selected = refs(block.evidence);
      for (const item of selected) { requireValue(item.index > lastIndex, 'Cards repeat or reorder original evidence'); lastIndex = item.index; }
      const rows = selected.map(item => item.row);
      if (Object.hasOwn(block, 'excerpts')) {
        requireValue(block.excerpts && typeof block.excerpts === 'object' && !Array.isArray(block.excerpts), 'Invalid subtitle excerpts');
        for (const [id, text] of Object.entries(block.excerpts)) requireValue(block.evidence.includes(id) && textOK(text) && byId.get(id).row.text.includes(text), 'Excerpt is not a nonempty continuous original substring');
      }
      all.push(...rows);
      displayed.push(...rows.map(row => block.excerpts?.[row.id] ?? row.text));
      if (block.visual) { visual(block.visual, rows); visuals.set(`${card.id}-${index + 1}`, block.visual); }
      expected.push({ card: card.id, block: index, segments: rows, ...(Object.hasOwn(block, 'excerpts') ? { excerpts: block.excerpts } : {}), visual: block.visual ?? card.visual ?? null });
      requireValue(block.visual || card.visual, 'Block has no corresponding visual');
    }
    if (card.visual) { visual(card.visual, all); visuals.set(`${card.id}-hero`, card.visual); }
    selectedCards.set(card.id, { text: displayed.join('\n'), start: all[0].start });
  }
  requireValue(Array.isArray(evidence) && evidence.length > 0 && isDeepStrictEqual(evidence, expected), 'Evidence does not match the original transcript and plan');
  return { visuals, selectedCards };
}

/** Validate private Skill artifacts and return only explicitly publishable records. */
export async function loadEpisode(episodeDir, { existingBvids = [] } = {}) {
  const root = await realpath(episodeDir), artifacts = {}, provenance = {};
  for (const name of ARTIFACTS) {
    const { data } = await fileBytes(root, name, 8 * 1024 * 1024);
    artifacts[name] = JSON.parse(data.toString('utf8'));
    provenance[name] = { bytes: data.length, sha256: sha(data) };
  }
  const source = artifacts['source.json'], metadata = artifacts['metadata.json'], plan = artifacts['plan.json'];
  const bvid = metadata?.bvid;
  requireValue(bvidOK(bvid) && metadata.uid === CREATOR_UID && !new Set(existingBvids).has(bvid), 'Episode is not a new video from the required creator');
  const sourceURL = `https://www.bilibili.com/video/${bvid}/`;
  requireValue(source?.url === sourceURL && (metadata.source === undefined || metadata.source === sourceURL) && textOK(metadata.title), 'Source URL and metadata must identify the same video');
  requireValue((source.id === undefined || source.id === bvid) && (source.bvid === undefined || source.bvid === bvid) && (metadata.page === undefined || metadata.page === 1), 'Source identity or video page disagrees with metadata');
  if (metadata.duration !== undefined) requireValue(Number.isFinite(metadata.duration) && Math.abs(metadata.duration - source.duration) <= 2, 'Source and metadata durations disagree');
  const publication = publicationOf(metadata);
  const { visuals, selectedCards } = validateContent(source, artifacts['transcript.json'], plan, artifacts['evidence.json']);
  const frames = artifacts['frames.json'];
  requireValue(Array.isArray(frames) && frames.length === visuals.size && new Set(frames.map(frame => frame?.key)).size === frames.length, 'Frame selection manifest does not match the plan');
  for (const frame of frames) {
    const requested = visuals.get(frame?.key);
    requireValue(requested && frame.role === requested.role && frame.reason === requested.reason && Array.isArray(frame.candidates) && frame.candidates.length > 0 && frame.candidates.length <= 16, 'Frame evidence does not match the planned visual');
    const candidates = new Set();
    for (const candidate of frame.candidates) {
      requireValue(candidate && typeof candidate.file === 'string' && /^frames\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png)$/.test(candidate.file) && !candidates.has(candidate.file) && Number.isFinite(candidate.time) && candidate.time >= 0 && candidate.time <= source.duration, 'Invalid frame candidate or timestamp');
      candidates.add(candidate.file);
    }
    requireValue(candidates.has(frame.selected), 'Selected frame is not one of the extracted candidates');
    await insideFile(root, frame.selected);
  }
  const cards = artifacts['cards.json'];
  requireValue(Array.isArray(cards) && cards.length === plan.cards.length, 'Rendered cards are missing or extra');
  const images = [], video = { bvid, title: metadata.title, source: sourceURL, batch: 'new', approval: 'review', images: [] };
  for (const [index, card] of cards.entries()) {
    const id = plan.cards[index].id;
    requireValue(card && card.card === id && card.file === `cards/${id}.png` && card.width === 1080 && Number.isInteger(card.height) && card.height >= 1 && card.height <= 12000, 'Rendered card order, path or dimensions disagree with the plan');
    const { sourcePath, data } = await fileBytes(root, card.file), dimensions = pngDimensions(data);
    requireValue(dimensions.width === card.width && dimensions.height === card.height, 'Actual PNG dimensions differ from cards.json');
    const source = `images/${bvid}/${id}.png`, bytes = data.length, sha256 = sha(data), crc = crc32(data);
    images.push({ source, sourcePath, bytes, sha256 });
    video.images.push({ id, src: source, ...dimensions, bytes, sha256, crc32: crc, ...selectedCards.get(id) });
  }
  video.download = { url: `/video/${bvid}/?raw=1`, bytes: buildArchivePlan(video).bytes };
  return { video, publication, images, provenance };
}

/** Verify frozen originals and migrate only package metadata and missing CRCs. */
export async function enrichCatalog(catalog, publicRoot) {
  const enriched = structuredClone(catalog), root = await realpath(publicRoot), seen = new Set();
  requireValue(Array.isArray(enriched?.videos), 'Catalog must contain videos');
  let imageCount = 0;
  for (const video of enriched.videos) {
    requireValue(bvidOK(video?.bvid) && !seen.has(video.bvid), 'Invalid or duplicate catalog BV');
    seen.add(video.bvid);
    const plan = buildArchivePlan({ ...video, images: video.images?.map(image => ({ ...image, crc32: image.crc32 ?? 0 })) });
    for (const [index, entry] of plan.entries.entries()) {
      const { data } = await fileBytes(root, entry.src.slice(1));
      requireValue(data.length === entry.bytes && sha(data) === entry.sha256, 'Frozen original bytes or SHA256 changed');
      const actual = crc32(data), image = video.images[index];
      if (Object.hasOwn(image, 'crc32')) requireValue(image.crc32 === actual, 'Existing image CRC32 is incorrect');
      else image.crc32 = actual;
      imageCount++;
    }
    video.download = { url: `/video/${video.bvid}/?raw=1`, bytes: buildArchivePlan(video).bytes };
  }
  enriched.videoCount = enriched.videos.length; enriched.imageCount = imageCount;
  return enriched;
}

function inlineSlots(html) {
  const slots = [], counts = { 'catalog-data': 0, 'publication-data': 0 };
  const scripts = /(<script\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)(<\/script\s*>)/gi;
  for (const match of html.matchAll(scripts)) {
    const ids = [...match[1].matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)].map(item => item[1] ?? item[2] ?? item[3]);
    const wanted = ids.filter(id => Object.hasOwn(counts, id));
    if (!wanted.length) continue;
    requireValue(ids.length === 1 && wanted.length === 1, 'Inline data script has duplicate IDs');
    const id = wanted[0], start = match.index + match[1].length;
    counts[id]++; slots.push({ id, start, end: start + match[2].length });
  }
  requireValue(Object.values(counts).every(count => count === 1), 'Each inline data script must occur exactly once');
  return slots;
}
const safeJSON = value => {
  const json = JSON.stringify(value);
  requireValue(typeof json === 'string', 'Inline data must be JSON');
  const escaped = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  return json.replace(/[<>&\u2028\u2029]/g, character => escaped[character]);
};
function withoutInlineData(html) {
  let output = '', cursor = 0;
  for (const slot of inlineSlots(html)) { output += html.slice(cursor, slot.start); cursor = slot.end; }
  return output + html.slice(cursor);
}

/** Keep every byte outside the two data blocks unchanged, including design drafts. */
export function replaceInlineData(html, catalog, publication) {
  requireValue(typeof html === 'string', 'HTML must be text');
  const values = { 'catalog-data': catalog, 'publication-data': publication };
  let replaced = '', cursor = 0;
  for (const slot of inlineSlots(html)) { replaced += html.slice(cursor, slot.start) + safeJSON(values[slot.id]); cursor = slot.end; }
  replaced += html.slice(cursor);
  const before = withoutInlineData(html), after = withoutInlineData(replaced);
  requireValue(before === after, 'Non-data HTML bytes changed');
  return { html: replaced, outsideDataBeforeSHA256: sha(before), outsideDataAfterSHA256: sha(after) };
}

/** Prepend one independently validated episode while preserving all prior records. */
export function mergeEpisode(catalog, publication, episode, now) {
  const merged = structuredClone(catalog), dates = structuredClone(publication);
  requireValue(Array.isArray(merged?.videos) && dates && dates.videos && typeof dates.videos === 'object' && !Array.isArray(dates.videos), 'Catalog and publication structures are required');
  if (episode === null || episode === undefined) return { catalog: merged, publication: dates };
  const video = episode.video;
  requireValue(bvidOK(video?.bvid) && !merged.videos.some(old => old.bvid === video.bvid) && !Object.hasOwn(dates.videos, video.bvid), 'Episode already exists');
  buildArchivePlan(video);
  const freshDate = publicationOf(episode.publication);
  requireValue(freshDate.publishedDate === episode.publication.publishedDate, 'Episode publication date does not match Shanghai time');
  const date = new Date(now);
  requireValue(now !== undefined && Number.isFinite(date.getTime()), 'A valid merge time is required');
  merged.videos.unshift(structuredClone(video));
  dates.videos[video.bvid] = structuredClone(episode.publication);
  merged.videoCount = merged.videos.length;
  merged.imageCount = merged.videos.reduce((count, row) => count + row.images.length, 0);
  merged.updated = shanghaiDate(date); dates.fetchedAt = date.toISOString();
  return { catalog: merged, publication: dates };
}
