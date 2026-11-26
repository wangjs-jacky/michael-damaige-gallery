import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

// Overlay this feature onto a frozen production snapshot; never publish the old
// GitHub homepage over the newer production photo wall.
const [baselineArgument, outputArgument] = process.argv.slice(2);
assert(baselineArgument && outputArgument, 'Usage: node scripts/prepare-link-download-release.mjs BASELINE_RELEASE NEW_RELEASE');
const baseline = resolve(baselineArgument), output = resolve(outputArgument);
assert(output !== baseline && !output.startsWith(baseline + '/'), 'The new release must be independent of its baseline.');
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const original = JSON.parse(await readFile(join(baseline, 'release-manifest.json'), 'utf8'));
const baselineConfig = JSON.parse(await readFile(join(baseline, 'wrangler.json'), 'utf8'));
assert.equal(baselineConfig.name, 'michael-damaige-gallery');
assert.equal(baselineConfig.workers_dev, false);
assert.equal(baselineConfig.preview_urls, false);
const digest = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
for (const file of original.files) {
  assert.match(file.source, /^[A-Za-z0-9._/-]+$/);
  assert(!file.source.split('/').includes('..'));
  const bytes = await readFile(join(baseline, 'public', file.source));
  assert.equal(digest(bytes).sha256, file.sha256, 'Baseline has changed: ' + file.source);
}
await mkdir(output); // Refuse to overwrite any existing/frozen release.
await cp(join(baseline, 'public'), join(output, 'public'), { recursive: true, errorOnExist: true, force: false, mode: constants.COPYFILE_FICLONE });
await cp(join(project, 'public/download'), join(output, 'public/download'), { recursive: true, force: false, errorOnExist: true });
let homepage = await readFile(join(output, 'public/index.html'), 'utf8');
const anchor = '<a class="text-link" href="/download/">从 B 站链接下载 →</a>';
assert(!homepage.includes('href="/download/"'), 'Baseline already includes a download entry; reconcile instead of stacking another.');
const intro = '<p>从原视频里摘下的画面和原话。</p>';
assert(homepage.includes(intro), 'Expected production photo-wall intro is missing.');
homepage = homepage.replace(intro, intro + anchor);
await writeFile(join(output, 'public/index.html'), homepage);
const headersPath = join(output, 'public/_headers');
const previousHeaders = await readFile(headersPath, 'utf8');
await writeFile(headersPath, previousHeaders + '\n/download\n  ! Cache-Control\n  Cache-Control: public, max-age=0, must-revalidate, no-transform\n\n/download/\n  ! Cache-Control\n  Cache-Control: public, max-age=0, must-revalidate, no-transform\n\n/download/index.html\n  ! Cache-Control\n  Cache-Control: public, max-age=0, must-revalidate, no-transform\n');
const config = { ...baselineConfig, main: 'worker.mjs', assets: { ...baselineConfig.assets, binding: 'ASSETS', run_worker_first: ['/api/*', '/video/*', '/download/BV*'] } };
await writeFile(join(output, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
await cp(join(project, 'src/worker.mjs'), join(output, 'worker.mjs'), { errorOnExist: true, force: false });
const files = original.files.map(file => ({ ...file }));
for (const [source, contentType] of [['download/index.html', 'text/html'], ['download/page.css', 'text/css'], ['download/page.js', 'application/javascript']]) {
  assert(!files.some(item => item.source === source));
  files.push({ source, contentType, immutable: false, url: source.endsWith('/index.html') ? '/' + source.slice(0, -10) : '/' + source });
}
for (const item of files) Object.assign(item, digest(await readFile(join(output, 'public', item.source))));
files.sort((a, b) => a.source.localeCompare(b.source));
const controls = {};
for (const [key, path] of [['headers', 'public/_headers'], ['wrangler', 'wrangler.json'], ['worker', 'worker.mjs']]) controls[key] = digest(await readFile(join(output, path)));
const manifest = { ...original, files, controls };
await writeFile(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const preserved = original.files.filter(old => old.source !== 'index.html' && files.find(file => file.source === old.source)?.sha256 === old.sha256);
assert.equal(preserved.length, original.files.length - 1, 'An existing asset changed.');
console.log(JSON.stringify({ output, files: files.length, unchangedPreviousFiles: preserved.length, changedPreviousFiles: ['index.html'], newFiles: ['download/index.html', 'download/page.css', 'download/page.js'], workerSHA256: controls.worker.sha256 }));
