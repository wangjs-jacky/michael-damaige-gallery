import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { build } from 'esbuild';
import { enrichCatalog, loadEpisode, mergeEpisode, replaceInlineData } from './catalog.mjs';

const exec = promisify(execFile);
const VOLUME = '/Volumes/ZHITAI TiPlus7100s';
const VOLUME_UUID = 'AE0665BA-321F-4964-B0F8-122BFABE7178';
const MUTABLE = new Set(['catalog.json', 'video-publish-dates.json', 'index.html', 'download/index.html', 'download/page.js', 'download/page.css']);
const CONTROL_PATHS = { headers: 'public/_headers', wrangler: 'wrangler.json', worker: 'worker.mjs' };
const fingerprint = bytes => ({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
const json = value => JSON.stringify(value, null, 2) + '\n';
const same = (left, right) => left?.bytes === right?.bytes && left?.sha256 === right?.sha256;

function safeSource(source) {
  if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(source) || source.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid release asset path');
  return source;
}

async function regularFile(path) {
  if (!(await lstat(path)).isFile()) throw new Error('Release inputs must be regular files');
  return readFile(path);
}

async function publicFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const source = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await publicFiles(root, source));
    else if (entry.isFile()) files.push(source);
    else throw new Error('Frozen assets cannot contain symbolic links or special files');
  }
  return files;
}

async function verifyBaseline(baseline) {
  const raw = await regularFile(join(baseline, 'release-manifest.json'));
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Baseline asset manifest is missing');
  const seen = new Set();
  for (const item of manifest.files) {
    const source = safeSource(item.source);
    if (seen.has(source)) throw new Error('Duplicate baseline asset');
    seen.add(source);
    if (!same(fingerprint(await regularFile(join(baseline, 'public', source))), item)) throw new Error('Baseline asset changed: ' + source);
  }
  for (const [key, source] of Object.entries(CONTROL_PATHS)) {
    if (!same(fingerprint(await regularFile(join(baseline, source))), manifest.controls?.[key])) throw new Error('Baseline control changed: ' + key);
  }
  if (Object.keys(manifest.controls).some(key => !Object.hasOwn(CONTROL_PATHS, key))) throw new Error('Unknown baseline control');
  const allowed = new Set([...seen, '_headers']);
  for (const source of await publicFiles(join(baseline, 'public'))) if (!allowed.has(source)) throw new Error('Unlisted baseline public file: ' + source);
  if (manifest.changeProof) {
    if (manifest.changeProof.source !== 'change-proof.json' || !same(fingerprint(await regularFile(join(baseline, 'change-proof.json'))), manifest.changeProof)) throw new Error('Baseline change proof changed');
  }
  const configuration = JSON.parse(await readFile(join(baseline, 'wrangler.json'), 'utf8'));
  if (configuration.name !== 'michael-damaige-gallery' || configuration.workers_dev !== false || configuration.preview_urls !== false || configuration.main !== 'worker.mjs' || configuration.assets?.directory !== './public' || configuration.assets?.binding !== 'ASSETS') throw new Error('Baseline is not the expected frozen gallery Worker');
  return { manifest, fingerprint: fingerprint(raw) };
}

async function verifyExternalDestination(output) {
  if (output !== VOLUME && !output.startsWith(VOLUME + sep)) return;
  const { stdout } = await exec('diskutil', ['info', '-plist', VOLUME]);
  const value = key => stdout.match(new RegExp('<key>' + key + '</key>\\s*<string>([^<]+)</string>'))?.[1];
  if (value('VolumeUUID') !== VOLUME_UUID || value('MountPoint') !== VOLUME || !/<key>Writable<\/key>\s*<true\s*\/>/.test(stdout)) throw new Error('Expected writable external volume is not mounted');
  await access(VOLUME, constants.W_OK);
}

async function bundleWorker(projectRoot) {
  const result = await build({
    absWorkingDir: projectRoot, entryPoints: [join(projectRoot, 'src/worker.mjs')],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    sourcemap: false, legalComments: 'none', metafile: true,
  });
  if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output => output.imports.length)) throw new Error('Worker must bundle into one self-contained module');
  return result.outputFiles[0].contents;
}

/** Freeze one new episode, or migrate download metadata with episodeDir omitted. */
export async function stageEpisode({ baselineRelease, outputRelease, episodeDir, projectRoot, now = new Date() }) {
  if (!baselineRelease || !outputRelease || !projectRoot) throw new Error('baselineRelease, outputRelease and projectRoot are required');
  const baseline = await realpath(baselineRelease), project = await realpath(projectRoot);
  const requested = resolve(outputRelease), parent = await realpath(dirname(requested)), output = join(parent, basename(requested));
  if (output === baseline || output.startsWith(baseline + sep)) throw new Error('Output must be independent of its frozen baseline');
  try { await lstat(output); throw new Error('Refusing to overwrite an existing release'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await verifyExternalDestination(output);
  const instant = new Date(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid stage timestamp');
  const previous = await verifyBaseline(baseline), original = previous.manifest;
  const catalog = JSON.parse(await readFile(join(baseline, 'public/catalog.json'), 'utf8'));
  const publication = JSON.parse(await readFile(join(baseline, 'public/video-publish-dates.json'), 'utf8'));
  const episode = episodeDir ? await loadEpisode(episodeDir, { existingBvids: catalog.videos.map(video => video.bvid) }) : null;
  const enriched = await enrichCatalog(catalog, join(baseline, 'public'));
  const merged = mergeEpisode(enriched, publication, episode, instant);
  const homepage = replaceInlineData(await readFile(join(baseline, 'public/index.html'), 'utf8'), merged.catalog, merged.publication);
  if (homepage.outsideDataBeforeSHA256 !== homepage.outsideDataAfterSHA256) throw new Error('Homepage UI outside inline data changed');
  const worker = await bundleWorker(project);
  const overlays = new Map([
    ['catalog.json', Buffer.from(json(merged.catalog))],
    ['index.html', Buffer.from(homepage.html)],
  ]);
  if (episode) overlays.set('video-publish-dates.json', Buffer.from(json(merged.publication)));
  for (const source of ['download/index.html', 'download/page.js', 'download/page.css']) overlays.set(source, await regularFile(join(project, 'public', source)));

  await mkdir(output); // Atomic refusal if another job claimed this release name.
  try {
    await cp(join(baseline, 'public'), join(output, 'public'), { recursive: true, errorOnExist: true, force: false, mode: constants.COPYFILE_FICLONE });
    await cp(join(baseline, 'wrangler.json'), join(output, 'wrangler.json'), { errorOnExist: true, force: false });
    for (const [source, bytes] of overlays) {
      if (!original.files.some(item => item.source === source)) throw new Error('Expected existing mutable asset missing: ' + source);
      await writeFile(join(output, 'public', source), bytes);
    }
    const files = original.files.map(item => ({ ...item }));
    for (const image of episode?.images ?? []) {
      const source = safeSource(image.source);
      if (!source.startsWith(`images/${episode.video.bvid}/`) || files.some(item => item.source === source)) throw new Error('New images cannot overwrite an existing asset');
      await mkdir(dirname(join(output, 'public', source)), { recursive: true });
      await cp(image.sourcePath, join(output, 'public', source), { errorOnExist: true, force: false });
      const actual = fingerprint(await regularFile(join(output, 'public', source)));
      if (!same(actual, image)) throw new Error('New original changed during staging: ' + source);
      files.push({ source, ...actual, contentType: 'image/png', immutable: false, url: '/' + source });
    }
    const changes = { changed: [], added: [], removed: [] };
    for (const item of files) {
      const actual = fingerprint(await regularFile(join(output, 'public', item.source)));
      const old = original.files.find(previous => previous.source === item.source);
      if (!old) changes.added.push({ source: item.source, after: actual });
      else if (!same(old, actual)) {
        if (!MUTABLE.has(item.source)) throw new Error('An existing protected asset changed: ' + item.source);
        changes.changed.push({ source: item.source, before: { bytes: old.bytes, sha256: old.sha256 }, after: actual });
      }
      Object.assign(item, actual);
    }
    files.sort((left, right) => left.source.localeCompare(right.source));
    await writeFile(join(output, 'worker.mjs'), worker, { flag: 'wx' });
    const controls = {};
    for (const [key, source] of Object.entries(CONTROL_PATHS)) controls[key] = fingerprint(await regularFile(join(output, source)));
    if (!same(controls.headers, original.controls.headers) || !same(controls.wrangler, original.controls.wrangler)) throw new Error('Baseline configuration or response headers changed');
    const proof = {
      schemaVersion: 1, kind: 'episode-stage', createdAt: instant.toISOString(),
      baseline: { manifest: previous.fingerprint, files: original.files.map(({ source, bytes, sha256 }) => ({ source, bytes, sha256 })), controls: original.controls },
      episode: episode ? { bvid: episode.video.bvid, uid: 324213598, imageCount: episode.images.length, provenance: episode.provenance } : null,
      changes,
      controls: Object.fromEntries(Object.keys(controls).map(key => [key, { before: original.controls[key], after: controls[key] }])),
      homepage: { outsideDataBeforeSHA256: homepage.outsideDataBeforeSHA256, outsideDataAfterSHA256: homepage.outsideDataAfterSHA256 },
    };
    const proofBytes = Buffer.from(json(proof));
    await writeFile(join(output, 'change-proof.json'), proofBytes, { flag: 'wx' });
    const manifest = { ...original, files, controls, changeProof: { source: 'change-proof.json', ...fingerprint(proofBytes) } };
    await writeFile(join(output, 'release-manifest.json'), json(manifest), { flag: 'wx' });
    return {
      outputRelease: output, bvid: episode?.video.bvid ?? null, migrationOnly: !episode,
      changedPreviousFiles: changes.changed.map(item => item.source), newFiles: changes.added.map(item => item.source),
      unchangedPreviousFiles: original.files.length - changes.changed.length,
      changeProof: proof, changeProofPath: join(output, 'change-proof.json'),
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
