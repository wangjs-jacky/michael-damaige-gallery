import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageEpisode } from './pipeline/release.mjs';

const [baseline, output, episodeDir] = process.argv.slice(2);
assert(baseline && output, '用法：node scripts/prepare-link-download-release.mjs 当前冻结快照 新快照 [新一期资料目录]');
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const result = await stageEpisode({ baselineRelease: resolve(baseline), outputRelease: resolve(output), episodeDir: episodeDir ? resolve(episodeDir) : undefined, projectRoot });
console.log(JSON.stringify({ output: result.outputRelease, bvid: result.bvid, migrationOnly: result.migrationOnly,
  unchangedPreviousFiles: result.unchangedPreviousFiles, changedPreviousFiles: result.changedPreviousFiles, newFiles: result.newFiles }, null, 2));
