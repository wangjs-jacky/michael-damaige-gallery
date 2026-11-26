import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { processEpisode } from './episode.mjs';
import { validateInput } from './plan.mjs';

const bvid = 'BV1ttykzFERD';
const sourceURL = `https://www.bilibili.com/video/${bvid}/`;
const metadata = { bvid, uid: 324213598, title: '离线恢复验证', author: 'Michael大麦哥', page: 1, source: sourceURL, duration: 13 };
const context = { spaceId: 86, page: 'offline-page', targetId: 'offline-target', expectedUrl: sourceURL, runId: 'offline-run' };
const transcript = { source: 'local-asr', segments: [
  { id: 's0001', start: 1, end: 3, text: '先记录今天做过的事情。' },
  { id: 's0002', start: 3, end: 5, text: '每晚写下三件已经完成的小事。' },
  { id: 's0003', start: 5, end: 7, text: '下一步是每周回顾一次。' },
  { id: 's0004', start: 7, end: 9, text: '看看什么值得继续。' },
  { id: 's0005', start: 9, end: 12, text: '保留有效的方法再做调整。' },
] };
const visual = { time: 2, role: 'speaker', reason: '对应原话中的说话者画面' };
const plan = { cards: [{ id: 'record-daily', visual, blocks: [{ evidence: ['s0001', 's0002'] }] }] };
const oldSource = Buffer.from('old source without a trusted media receipt');
const muxedSource = Buffer.from('independently muxed offline source with video and audio');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fingerprint = async path => { const bytes = await readFile(path); return { bytes: bytes.length, sha256: digest(bytes) }; };
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJSON = async (path, value) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, jsonBytes(value)); };
const stop = label => new Error('offline-stop-' + label);
const isStop = expected => error => error === expected;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'damaige-resume-'));
  const dir = join(root, 'episodes', bvid, 'interrupted'), statePath = join(root, 'jobs', bvid + '.json');
  const sample = join(root, 'existing-offline-sample', 'untouched.mp4');
  await mkdir(dir, { recursive: true });
  await mkdir(join(sample, '..'), { recursive: true });
  await writeFile(sample, 'existing sample must stay unchanged');
  t.after(async () => {
    try { assert.equal(await readFile(sample, 'utf8'), 'existing sample must stay unchanged'); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const config = {
    dataRoot: root, videoCardsSkill: '/Users/jacky/jacky-github/jacky-skills/skills/video-to-cards',
    ffmpeg: 'offline-ffmpeg', ffprobe: 'offline-ffprobe', egoBin: 'offline-never-ego',
    codexBin: 'offline-never-codex', whisperPython: 'offline-never-asr', renderPython: 'offline-never-render',
  };
  const job = { schemaVersion: 1, bvid, dir, statePath, status: 'failed', phase: 'source', phases: {} };
  await writeJSON(statePath, job);
  return { root, dir, statePath, config, job };
}

async function filesUnder(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
async function assertAbandoned(dir, filename, expected) {
  const candidates = (await filesUnder(dir)).filter(path => relative(dir, path).includes('abandoned') && basename(path) === filename);
  const matching = await Promise.all(candidates.map(async path => (await readFile(path)).equals(expected)));
  assert(matching.some(Boolean), `${filename} must be preserved unchanged below an abandoned directory`);
}
function forbidden(name) { return async () => assert.fail('unexpected real-stage boundary: ' + name); }
function mockProbe(bytes) {
  return JSON.stringify({ format: { duration: bytes.equals(muxedSource) ? '13' : '1', size: String(bytes.length) }, streams: [{ codec_type: 'video', width: 1080, height: 720 }, { codec_type: 'audio' }] });
}
async function sourceFixture(t) {
  const f = await fixture(t);
  await writeJSON(join(f.dir, 'metadata.json'), metadata);
  await writeFile(join(f.dir, 'audio.m4s'), 'offline acquired audio');
  await writeFile(join(f.dir, 'video.m4s'), 'offline acquired video');
  await writeFile(join(f.dir, 'source.mp4'), oldSource);
  const files = {};
  for (const name of ['metadata.json', 'audio.m4s', 'video.m4s']) files[name] = await fingerprint(join(f.dir, name));
  await writeJSON(join(f.dir, 'acquisition.json'), { schemaVersion: 1, context, files });
  return f;
}
async function completedPhase(dir, names) {
  const files = {};
  for (const name of names) files[join(dir, name)] = await fingerprint(join(dir, name));
  return { completedAt: '2026-11-25T00:00:00.000Z', files };
}
async function planFixture(t, { receipt = true } = {}) {
  const f = await fixture(t), media = { duration: 13, bytes: muxedSource.length, width: 1080 };
  await writeJSON(join(f.dir, 'metadata.json'), metadata);
  await writeFile(join(f.dir, 'source.mp4'), muxedSource);
  await writeJSON(join(f.dir, 'media-check.json'), media);
  await writeJSON(join(f.dir, 'source.json'), { title: metadata.title, author: metadata.author, url: sourceURL, duration: 13, video: 'source.mp4', width: 1080, height: 720 });
  await writeJSON(join(f.dir, 'transcript-original.json'), transcript);
  await writeJSON(join(f.dir, 'transcript.json'), transcript);
  await writeJSON(join(f.dir, 'transcript-quality.json'), { duration: 13, segments: 5, excluded: [], accuracy: 'local-asr-unreviewed' });
  f.job.phases.source = await completedPhase(f.dir, ['metadata.json', 'source.mp4', 'media-check.json']);
  f.job.phases.transcript = await completedPhase(f.dir, ['source.json', 'transcript-original.json', 'transcript.json', 'transcript-quality.json']);
  f.job.phase = 'plan';
  await writeJSON(f.statePath, f.job);
  f.originalPlan = jsonBytes(plan);
  f.reportPath = join(f.dir, '.plan-attempts', 'a', 'report.json');
  await writeFile(join(f.dir, 'plan.json'), f.originalPlan);
  f.report = {
    status: 'completed', planSha256: digest(f.originalPlan),
    transcriptSha256: digest(await readFile(join(f.dir, 'transcript.json'))),
    sourceSha256: digest(JSON.stringify(validateInput(transcript, { ...metadata, duration: media.duration }).source)),
    audit: { toolCalls: 0, turnCompleted: true }, authentication: 'native-codex',
  };
  if (receipt) await writeJSON(f.reportPath, f.report);
  return f;
}

test('an interrupted acquired source is remuxed independently and its checkpoint prevents repeated acquisition or mux', { timeout: 5000 }, async t => {
  const f = await sourceFixture(t), sentinel = stop('before-asr');
  let acquired = 0, muxed = 0, prepared = 0;
  const runners = {
    acquire: async () => { acquired++; assert.fail('trusted acquisition receipt must be reused'); },
    plan: forbidden('plan'), selection: forbidden('selection'),
    run: async (bin, args) => {
      if (String(bin).includes('ffmpeg')) {
        muxed++;
        const pending = args.at(-1);
        assert.notEqual(pending, join(f.dir, 'source.mp4'));
        assert.match(basename(pending), /pending.*\.mp4$|\.pending\.mp4$/);
        assert(!relative(f.dir, pending).startsWith('..'));
        assert.deepEqual(await readFile(join(f.dir, 'source.mp4')), oldSource, 'old source stays until independent probe succeeds');
        await writeFile(pending, muxedSource);
        return '';
      }
      if (String(bin).includes('ffprobe')) return mockProbe(await readFile(args.at(-1)));
      if (args[0]?.endsWith('video-cards.mjs') && args[1] === 'prepare') { prepared++; throw sentinel; }
      assert.fail('unexpected offline command: ' + basename(String(bin)));
    },
  };
  await assert.rejects(processEpisode(f.config, { bvid, context, runners }), isStop(sentinel));
  const first = await readJSON(f.statePath);
  assert(first.phases.source, 'source completion must be persisted before entering ASR');
  assert(Object.keys(first.phases.source.files).some(path => path.endsWith('/source-receipt.json')));
  assert.deepEqual(await readFile(join(f.dir, 'source.mp4')), muxedSource);
  assert.deepEqual(await readJSON(join(f.dir, 'media-check.json')), { duration: 13, bytes: muxedSource.length, width: 1080 });
  assert(JSON.stringify(await readJSON(join(f.dir, 'source-receipt.json'))).includes(digest(muxedSource)), 'source receipt must bind the new media');
  await assertAbandoned(f.dir, 'source.mp4', oldSource);
  await assert.rejects(processEpisode(f.config, { bvid, context, runners }), isStop(sentinel));
  const second = await readJSON(f.statePath);
  assert.deepEqual(second.phases.source, first.phases.source);
  assert.equal(acquired, 0); assert.equal(muxed, 1); assert.equal(prepared, 2);
});

test('a broken acquisition receipt archives prior media before reacquiring and forwards capture evidence', { timeout: 5000 }, async t => {
  const f = await sourceFixture(t), sentinel = stop('after-reacquisition');
  await writeFile(join(f.dir, 'video.m4s'), 'changed video bytes invalidate the previous receipt');
  const names = ['metadata.json', 'audio.m4s', 'video.m4s', 'source.mp4', 'acquisition.json'];
  const originals = new Map(await Promise.all(names.map(async name => [name, await readFile(join(f.dir, name))])));
  const happyCapture = { purpose: 'offline-test-capture' };
  f.config.happyCapture = happyCapture;
  const browserStep = { operation: 'acquire', targetId: context.targetId, evidencePath: 'offline-only' }, events = [];
  let acquired = 0, muxed = 0;
  const runners = {
    plan: forbidden('plan'), selection: forbidden('selection'),
    acquire: async (receivedContext, requested, dir, options) => {
      acquired++;
      assert.equal(requested, bvid); assert.equal(dir, f.dir);
      assert.deepEqual(receivedContext, context);
      assert.equal(options.happyCapture, happyCapture);
      for (const name of names) {
        await assert.rejects(readFile(join(dir, name)), { code: 'ENOENT' });
        await assertAbandoned(dir, name, originals.get(name));
      }
      await writeJSON(join(dir, 'metadata.json'), { ...metadata, title: '重新采集的同一期视频' });
      await writeFile(join(dir, 'audio.m4s'), 'new acquired audio');
      await writeFile(join(dir, 'video.m4s'), 'new acquired video');
      const files = {};
      for (const name of ['metadata.json', 'audio.m4s', 'video.m4s']) files[name] = await fingerprint(join(dir, name));
      await writeJSON(join(dir, 'acquisition.json'), { schemaVersion: 1, context, files });
      return { context, browserStep };
    },
    run: async (bin, args) => {
      if (String(bin).includes('ffmpeg')) {
        muxed++;
        assert.notEqual(args.at(-1), join(f.dir, 'source.mp4'));
        await writeFile(args.at(-1), muxedSource);
        return '';
      }
      if (String(bin).includes('ffprobe')) return mockProbe(await readFile(args.at(-1)));
      if (args[1] === 'prepare') throw sentinel;
      assert.fail('unexpected offline command');
    },
  };
  await assert.rejects(processEpisode(f.config, { bvid, context, runners, emit: event => events.push(event) }), isStop(sentinel));
  const job = await readJSON(f.statePath);
  assert(job.phases.source, 'new source must be verified rather than reusing the broken acquisition');
  assert.equal(acquired, 1); assert.equal(muxed, 1);
  assert.deepEqual(await readFile(join(f.dir, 'source.mp4')), muxedSource);
  assert.equal((await readJSON(join(f.dir, 'metadata.json'))).title, '重新采集的同一期视频');
  assert(events.some(event => event.status === 'browser-step' && event.operation === browserStep.operation && event.evidencePath === browserStep.evidencePath));
  for (const name of names) await assertAbandoned(f.dir, name, originals.get(name));
});

test('canceling an independent mux leaves the prior source and sample untouched with no source success marker', { timeout: 5000 }, async t => {
  const f = await sourceFixture(t), controller = new AbortController(), sentinel = stop('cancel-mux');
  const runners = {
    acquire: forbidden('acquire'), plan: forbidden('plan'), selection: forbidden('selection'),
    run: async (bin, args) => {
      assert(String(bin).includes('ffmpeg'));
      assert.notEqual(args.at(-1), join(f.dir, 'source.mp4'));
      await writeFile(args.at(-1), 'incomplete pending source');
      controller.abort(sentinel);
      throw sentinel;
    },
  };
  await assert.rejects(processEpisode(f.config, { bvid, context, signal: controller.signal, runners }), isStop(sentinel));
  assert.deepEqual(await readFile(join(f.dir, 'source.mp4')), oldSource);
  const job = await readJSON(f.statePath);
  assert.equal(job.status, 'failed');
  assert(!job.phases.source);
});

test('a completed native plan receipt recovers a missing checkpoint without rerunning ASR or the planning model', { timeout: 5000 }, async t => {
  const f = await planFixture(t), sentinel = stop('before-frames'), reportBefore = await readFile(f.reportPath);
  let planned = 0, prepared = 0;
  const runners = {
    acquire: forbidden('acquire'), selection: forbidden('selection'),
    plan: async () => { planned++; assert.fail('completed plan receipt must be adopted'); },
    run: async (_bin, args) => {
      if (args[1] === 'prepare') { prepared++; assert.fail('transcript checkpoint must be reused'); }
      if (args[1] === 'validate') return '';
      if (args[1] === 'frames') throw sentinel;
      assert.fail('unexpected offline command');
    },
  };
  await assert.rejects(processEpisode(f.config, { bvid, context, runners }), isStop(sentinel));
  const job = await readJSON(f.statePath);
  assert(job.phases.plan, 'verified existing plan must receive its missing checkpoint');
  assert.deepEqual(job.phases.plan.files[join(f.dir, 'plan.json')], await fingerprint(join(f.dir, 'plan.json')));
  assert.deepEqual(job.phases.source, f.job.phases.source);
  assert.deepEqual(job.phases.transcript, f.job.phases.transcript);
  assert.deepEqual(await readFile(join(f.dir, 'plan.json')), f.originalPlan);
  assert.deepEqual(await readFile(f.reportPath), reportBefore);
  assert.equal(planned, 0); assert.equal(prepared, 0);
});

for (const receipt of ['missing', 'wrong-plan-hash']) {
  test(`a ${receipt} plan receipt preserves the old plan before calling the planning runner`, { timeout: 5000 }, async t => {
    const f = await planFixture(t, { receipt: receipt !== 'missing' }), sentinel = stop('before-frames');
    let reportBefore;
    if (receipt !== 'missing') {
      await writeJSON(f.reportPath, { ...f.report, planSha256: '0'.repeat(64) });
      reportBefore = await readFile(f.reportPath);
    }
    let planned = 0;
    const runners = {
      acquire: forbidden('acquire'), selection: forbidden('selection'),
      plan: async ({ outDir }) => {
        planned++;
        assert.equal(outDir, f.dir);
        await assert.rejects(readFile(join(f.dir, 'plan.json')), { code: 'ENOENT' });
        await assertAbandoned(f.dir, 'plan.json', f.originalPlan);
        const replacement = { cards: [{ id: 'review-weekly', visual: { ...visual, time: 6 }, blocks: [{ evidence: ['s0003'] }] }] };
        const raw = jsonBytes(replacement), reportPath = join(f.dir, '.plan-attempts', 'replacement', 'report.json');
        await writeFile(join(f.dir, 'plan.json'), raw, { flag: 'wx' });
        await writeJSON(reportPath, { ...f.report, planSha256: digest(raw) });
        return { planPath: join(f.dir, 'plan.json'), reportPath };
      },
      run: async (_bin, args) => {
        if (args[1] === 'validate') return '';
        if (args[1] === 'frames') throw sentinel;
        assert.fail('no source, mux or ASR stage may rerun');
      },
    };
    await assert.rejects(processEpisode(f.config, { bvid, context, runners }), isStop(sentinel));
    assert.equal(planned, 1);
    const job = await readJSON(f.statePath);
    assert(job.phases.plan);
    assert.deepEqual(job.phases.source, f.job.phases.source);
    assert.deepEqual(job.phases.transcript, f.job.phases.transcript);
    assert.equal((await readJSON(join(f.dir, 'plan.json'))).cards[0].id, 'review-weekly');
    await assertAbandoned(f.dir, 'plan.json', f.originalPlan);
    if (reportBefore) assert.deepEqual(await readFile(f.reportPath), reportBefore, 'untrusted historical receipts stay intact in their original attempt');
  });
}

test('acquisition failure persists the updated browser context without a source checkpoint', { timeout: 5000 }, async t => {
  const f = await fixture(t), sentinel = stop('acquire'), latest = { ...context, expectedUrl: sourceURL + '?vd_source=verified-after-navigation' };
  const runners = {
    run: forbidden('run'), plan: forbidden('plan'), selection: forbidden('selection'),
    acquire: async (_context, requested, dir) => {
      assert.equal(requested, bvid); assert.equal(dir, f.dir);
      await writeJSON(join(dir, 'browser-context.json'), latest);
      throw sentinel;
    },
  };
  await assert.rejects(processEpisode(f.config, { bvid, context, runners }), isStop(sentinel));
  const job = await readJSON(f.statePath);
  assert.deepEqual(job.context, latest);
  assert.equal(job.status, 'failed');
  assert(!job.phases.source);
});

test('browser context from a different run cannot replace the current acquisition context', { timeout: 5000 }, async t => {
  const f = await fixture(t), sentinel = stop('foreign-run-context');
  const foreign = { ...context, runId: 'another-offline-run', expectedUrl: sourceURL + '?vd_source=other-run' };
  const runners = {
    run: forbidden('run'), plan: forbidden('plan'), selection: forbidden('selection'),
    acquire: async (_context, _requested, dir) => {
      await writeJSON(join(dir, 'browser-context.json'), foreign);
      throw sentinel;
    },
  };
  await assert.rejects(processEpisode(f.config, { bvid, context, runners }), isStop(sentinel));
  const job = await readJSON(f.statePath);
  assert.deepEqual(job.context, context);
  assert.notEqual(job.context.runId, foreign.runId);
  assert(!job.phases.source);
});

test('fresh caller discovery context survives cached source reuse and changes only after a new acquisition', { timeout: 5000 }, async t => {
  for (const mode of ['source-checkpoint', 'source-receipt', 'fresh-acquisition']) {
    const f = await planFixture(t);
    const upload = { ...context, expectedUrl: 'https://space.bilibili.com/324213598/upload/video' };
    const acquiredContext = { ...context, expectedUrl: sourceURL + '?vd_source=fresh-acquisition' };
    // These cached phases model already completed offline work. Every external
    // tool boundary below is forbidden unless this case actually acquires media.
    const frameFile = 'frames/record-daily-hero-at.jpg';
    const frames = [{ key: 'record-daily-hero', selected: frameFile, role: visual.role, reason: visual.reason, candidates: [{ time: 2, file: frameFile }] }];
    await mkdir(join(f.dir, 'frames'), { recursive: true });
    await mkdir(join(f.dir, 'cards'), { recursive: true });
    await writeFile(join(f.dir, frameFile), 'cached offline candidate');
    await writeJSON(join(f.dir, 'frames-original.json'), frames);
    await writeJSON(join(f.dir, 'frames.json'), frames);
    await writeJSON(join(f.dir, 'selection-report.json'), { status: 'completed' });
    await writeJSON(join(f.dir, 'cards.json'), [{ card: 'record-daily', file: 'cards/record-daily.png', width: 1080, height: 1440 }]);
    await writeFile(join(f.dir, 'cards/record-daily.png'), 'cached offline card');
    f.job.phases.plan = await completedPhase(f.dir, ['plan.json']);
    f.job.phases.frames = await completedPhase(f.dir, ['frames-original.json', frameFile]);
    f.job.phases.selection = await completedPhase(f.dir, ['frames.json', 'selection-report.json']);
    f.job.phases.cards = await completedPhase(f.dir, ['cards.json', 'cards/record-daily.png']);
    f.job.context = context;
    await writeJSON(join(f.dir, 'browser-context.json'), context);
    const sourceFiles = {};
    for (const name of ['metadata.json', 'source.mp4', 'media-check.json']) sourceFiles[name] = await fingerprint(join(f.dir, name));
    if (mode !== 'fresh-acquisition') await writeJSON(join(f.dir, 'source-receipt.json'), { schemaVersion: 1, bvid, context, files: sourceFiles });
    if (mode !== 'source-checkpoint') delete f.job.phases.source;
    await writeJSON(f.statePath, f.job);
    let acquisitions = 0, muxes = 0;
    const runners = {
      plan: forbidden('plan'), selection: forbidden('selection'),
      acquire: async (receivedContext, requested, dir) => {
        acquisitions++;
        assert.equal(mode, 'fresh-acquisition', 'cached source reuse must not navigate the browser');
        assert.deepEqual(receivedContext, upload, 'new acquisition must start from the caller-observed page');
        assert.equal(requested, bvid);
        await writeJSON(join(dir, 'metadata.json'), metadata);
        await writeFile(join(dir, 'audio.m4s'), 'new acquired audio');
        await writeFile(join(dir, 'video.m4s'), 'new acquired video');
        await writeJSON(join(dir, 'browser-context.json'), acquiredContext);
        const files = {};
        for (const name of ['metadata.json', 'audio.m4s', 'video.m4s']) files[name] = await fingerprint(join(dir, name));
        await writeJSON(join(dir, 'acquisition.json'), { schemaVersion: 1, context: acquiredContext, files });
        return { context: acquiredContext, metadata };
      },
      run: async (bin, args) => {
        assert.equal(mode, 'fresh-acquisition', 'cached phases must not rerun tools');
        if (String(bin).includes('ffmpeg')) { muxes++; await writeFile(args.at(-1), muxedSource); return ''; }
        if (String(bin).includes('ffprobe')) return mockProbe(await readFile(args.at(-1)));
        assert.fail('completed ASR, plan, frames and cards must not run again');
      },
    };
    const result = await processEpisode(f.config, { bvid, context: upload, runners });
    assert.equal(result.job.status, 'ready');
    assert.deepEqual(result.context, mode === 'fresh-acquisition' ? acquiredContext : upload, mode);
    assert.equal(acquisitions, mode === 'fresh-acquisition' ? 1 : 0, mode);
    assert.equal(muxes, mode === 'fresh-acquisition' ? 1 : 0, mode);
    assert.deepEqual(result.job.phases.transcript, f.job.phases.transcript, 'successful ASR stays unchanged');
    assert.deepEqual(result.job.phases.cards, f.job.phases.cards, 'successful cards stay unchanged');
  }
});
