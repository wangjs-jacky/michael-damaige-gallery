#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { readJSON, writeJSON, run, withLock, unlock, safeError } from './io.mjs';
import { openBrowser, discoverLatest, finishBrowser, BVID } from './bilibili.mjs';
import { processEpisode } from './episode.mjs';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const argv = process.argv.slice(2), command = argv.shift();
const options = {};
for (let i = 0; i < argv.length; i++) {
  const name = argv[i]; assert(name.startsWith('--'), '参数须以 -- 开头');
  options[name.slice(2)] = ['--apply', '--prepared'].includes(name) ? true : argv[++i];
}
const emit = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

export async function publishEpisode(config, job, apply, signal) {
  const { stageEpisode } = await import('./release.mjs');
  const currentPath = join(config.dataRoot, 'current-release.json');
  let baselineRelease;
  try { baselineRelease = (await readJSON(currentPath)).path; }
  catch (error) { if (error.code !== 'ENOENT') throw error; baselineRelease = config.baselineRelease; }
  const catalog = await readJSON(join(baselineRelease, 'public/catalog.json'));
  if (catalog.videos.some(v => v.bvid === job.bvid)) {
    job.status = job.release?.status === 'published' ? 'published' : 'already-present';
    await writeJSON(job.statePath, job);
    return { alreadyPresent: true, baselineRelease };
  }
  // After an uncertain write, require a human-triggered readback instead of blindly redeploying.
  assert(job.release?.status !== 'applying' && job.release?.status !== 'uncertain', '上次发布结果待核对，不能自动重发');
  let outputRelease = job.release?.outputRelease;
  if (outputRelease && job.release.baselineRelease !== baselineRelease) {
    // A previously staged candidate keeps its original proof and remains a
    // rollback artifact. Restage this episode from the now-current catalog.
    job.previousCandidates ||= []; job.previousCandidates.push(job.release);
    outputRelease = undefined;
  }
  if (!outputRelease) {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    outputRelease = join(config.deploymentRoot, 'releases', `${date}-episode-${job.bvid.toLowerCase()}-${randomUUID().slice(0, 8)}`);
    const staged = await stageEpisode({ baselineRelease, outputRelease, episodeDir: job.dir, projectRoot });
    job.release = { status: 'staged', outputRelease, baselineRelease, proof: staged.changeProofPath };
    await writeJSON(job.statePath, job);
  }
  await run(process.execPath, [join(projectRoot, 'scripts/deploy-link-download.mjs'), config.deploymentRoot, basename(outputRelease), basename(baselineRelease)], { signal });
  if (!apply) { emit({ bvid: job.bvid, status: 'staged', outputRelease }); return job.release; }
  job.release.status = 'applying'; await writeJSON(job.statePath, job);
  try {
    await run(process.execPath, [join(projectRoot, 'scripts/deploy-link-download.mjs'), config.deploymentRoot, basename(outputRelease), basename(baselineRelease), '--apply'], { signal });
    job.release.status = 'published'; job.release.completedAt = new Date().toISOString();
    await writeJSON(currentPath, { path: outputRelease, bvid: job.bvid, updatedAt: job.release.completedAt });
    job.status = 'published'; await writeJSON(job.statePath, job); emit({ bvid: job.bvid, status: 'published' });
    return job.release;
  } catch (error) { job.release.status = 'uncertain'; await writeJSON(job.statePath, job); throw error; }
}

async function main() {
  if (!options.config) {
    console.log('用法：node scripts/pipeline/cli.mjs discover|sync|process|status|reconcile|unlock --config 私有配置.json [--bvid BV…] [--episode-dir 资料目录 --prepared] [--apply]\n默认仅生成独立冻结快照；--apply 在每一期完成后增量发布。没有定时检查或状态轮询。'); return;
  }
  const config = await readJSON(resolve(options.config));
  for (const key of ['dataRoot', 'deploymentRoot', 'baselineRelease', 'videoCardsSkill', 'whisperPython', 'renderPython', 'font']) assert(typeof config[key] === 'string' && config[key].startsWith('/'), `缺少配置 ${key}`);
  if (command === 'unlock') { await unlock(config.dataRoot); emit({ status: 'unlocked' }); return; }
  if (command === 'reconcile') {
    assert(BVID.test(options.bvid), '缺少有效 --bvid');
    await withLock(config.dataRoot, async () => {
      const path = join(config.dataRoot, 'jobs', options.bvid + '.json'), job = await readJSON(path);
      assert(job.release && ['applying', 'uncertain'].includes(job.release.status), '该期没有待核对的发布');
      await run(process.execPath, [join(projectRoot, 'scripts/deploy-link-download.mjs'), config.deploymentRoot,
        basename(job.release.outputRelease), basename(job.release.baselineRelease), '--verify']);
      job.release.status = 'published'; job.release.completedAt = new Date().toISOString(); job.status = 'published';
      await writeJSON(path, job);
      await writeJSON(join(config.dataRoot, 'current-release.json'), { path: job.release.outputRelease, bvid: job.bvid, updatedAt: job.release.completedAt });
      emit({ bvid: job.bvid, status: 'reconciled', readOnly: true });
    }); return;
  }
  if (command === 'status') {
    const files = await readdir(join(config.dataRoot, 'jobs')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
    for (const file of files.filter(f => BVID.test(f.slice(0, -5)) && f.endsWith('.json'))) {
      const job = await readJSON(join(config.dataRoot, 'jobs', file)); emit({ bvid: job.bvid, status: job.status, phase: job.phase, error: job.error, release: job.release?.status });
    } return;
  }
  assert(['discover', 'sync', 'process'].includes(command), '未知命令');
  const controller = new AbortController();
  const cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  await withLock(config.dataRoot, async () => {
    let context = config.browserContext;
    let created = false;
    try {
      let videos;
      if (command === 'process') {
        assert(BVID.test(options.bvid), '缺少有效 --bvid');
        let baseline = config.baselineRelease;
        try { baseline = (await readJSON(join(config.dataRoot, 'current-release.json'))).path; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if ((await readJSON(join(baseline, 'public/catalog.json'))).videos.some(v => v.bvid === options.bvid)) { emit({ bvid: options.bvid, status: 'already-present' }); return; }
        videos = [{ bvid: options.bvid }];
      }
      else {
        if (!context) { context = await openBrowser({ runId: 'damaige-sync-' + randomUUID(), signal: controller.signal }); created = true; }
        let baseline = config.baselineRelease;
        try { baseline = (await readJSON(join(config.dataRoot, 'current-release.json'))).path; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const catalog = await readJSON(join(baseline, 'public/catalog.json'));
        const publication = await readJSON(join(baseline, 'public/video-publish-dates.json'));
        const discovery = await discoverLatest(context, { knownBvids: catalog.videos.map(v => v.bvid), knownPublications: publication.videos, signal: controller.signal }); context = discovery.context;
        await writeJSON(join(config.dataRoot, 'discovery.json'), discovery);
        let pending = [];
        try { pending = (await readJSON(join(config.dataRoot, 'pending.json'))).videos; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const known = new Set(catalog.videos.map(v => v.bvid));
        const queued = new Map([...pending, ...discovery.videos].map(v => [v.bvid, v]));
        pending = [...queued.values()].filter(v => !known.has(v.bvid));
        assert(pending.every(v => BVID.test(v.bvid)), '待处理目录包含无效编号');
        await writeJSON(join(config.dataRoot, 'pending.json'), { updatedAt: new Date().toISOString(), videos: pending });
        emit({ status: 'discovered', videos: discovery.videos, scope: discovery.scope, knownBoundaryFound: discovery.knownBoundaryFound });
        if (command === 'discover') return;
        assert(discovery.knownBoundaryFound, '当前页未遇到已收录边界；停止自动补全，需明确回填范围');
        videos = pending.toSorted((a, b) => (a.publishedDay || '').localeCompare(b.publishedDay || ''));
      }
      for (const video of videos) {
        if (!context && !options['episode-dir']) { context = await openBrowser({ runId: 'damaige-sync-' + randomUUID(), signal: controller.signal }); created = true; }
        const result = await processEpisode(config, { bvid: video.bvid, context, episodeDir: options['episode-dir'], adoptPrepared: options.prepared, signal: controller.signal, emit });
        context = result.context;
        await publishEpisode(config, result.job, options.apply, controller.signal);
      }
    } finally { if (created && context && !controller.signal.aborted) await finishBrowser(context).catch(error => emit({ status: 'browser-needs-attention', error: safeError(error) })); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
