import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildUploadMetadata, createAssetHasher, validateCloudSettings, validateConfigurationPair, validateHeadersPair,
} from './deploy-link-download.mjs';

const accountId = 'a'.repeat(32);
const baseline = {
  name: 'michael-damaige-gallery', account_id: accountId, compatibility_date: '2026-11-02',
  workers_dev: false, preview_urls: false,
  assets: { directory: './public', not_found_handling: '404-page' },
  routes: [{ pattern: 'damaige.paws.rodeo', zone_name: 'paws.rodeo', custom_domain: true }],
};
const moduleConfig = () => ({ ...structuredClone(baseline), main: 'worker.mjs',
  assets: { ...baseline.assets, binding: 'ASSETS', run_worker_first: ['/api/*', '/video/*', '/download/BV*'] } });
const settings = {
  compatibility_date: baseline.compatibility_date, compatibility_flags: [], logpush: false,
  usage_model: 'standard', bindings: [],
};

test('允许原静态站升级为限定模块，也允许完整回退', () => {
  validateConfigurationPair(moduleConfig(), baseline, accountId);
  validateConfigurationPair(baseline, moduleConfig(), accountId);
});

test('拒绝范围之外的账户、路由、入口、绑定及设置差异', () => {
  const mutations = [
    config => { config.account_id = 'b'.repeat(32); },
    config => { config.workers_dev = true; },
    config => { config.preview_urls = true; },
    config => { config.routes[0].pattern = 'other.paws.rodeo'; },
    config => { config.routes.push({ pattern: 'other.paws.rodeo' }); },
    config => { config.main = '../private.mjs'; },
    config => { config.assets.binding = 'OTHER'; },
    config => { config.assets.run_worker_first.push('/*'); },
    config => { config.assets.not_found_handling = 'single-page-application'; },
    config => { config.compatibility_date = '2026-11-26'; },
    config => { config.vars = { NEW_FLAG: 'unexpected' }; },
  ];
  for (const mutate of mutations) {
    const config = moduleConfig();
    mutate(config);
    assert.throws(() => validateConfigurationPair(config, baseline, accountId));
  }
});

test('只允许下载页追加再验证/no-transform，保留旧图集缓存与安全头', () => {
  const old = '/*\n  X-Frame-Options: DENY\n  Cache-Control: public, max-age=0, must-revalidate\n\n/images/*\n  Cache-Control: public, max-age=86400\n';
  const added = '\n/download/\n  ! Cache-Control\n  Cache-Control: public, max-age=0, must-revalidate, no-transform\n';
  validateHeadersPair(old + added, old);
  validateHeadersPair(old, old + added);
  assert.throws(() => validateHeadersPair(old.replace('86400', '0') + added, old));
  assert.throws(() => validateHeadersPair(old + added.replace('no-transform', 'immutable'), old));
});

test('云端基线须匹配当前静态或模块状态，意外秘密绑定不进入错误内容', () => {
  validateCloudSettings(settings, baseline);
  validateCloudSettings({ ...settings, bindings: [{ name: 'ASSETS', type: 'assets' }] }, moduleConfig());
  assert.throws(() => validateCloudSettings(settings, moduleConfig()));
  assert.throws(() => validateCloudSettings({ ...settings, compatibility_flags: ['nodejs_compat'] }, baseline));
  try {
    validateCloudSettings({ ...settings, bindings: [{ name: 'SECRET', type: 'secret_text', value: 'never-print-this' }] }, baseline);
    assert.fail('必须拒绝意外绑定');
  } catch (error) {
    assert(!error.message.includes('never-print-this'));
    assert.match(error.message, /预期之外/);
  }
});

test('模块上传连接完整资源集、原响应头及 ASSETS，不引入其他绑定', () => {
  const metadata = buildUploadMetadata(moduleConfig(), 'fake-completion', 'frozen-headers', settings);
  assert.equal(metadata.main_module, 'worker.mjs');
  assert.deepEqual(metadata.bindings, [{ name: 'ASSETS', type: 'assets' }]);
  assert.equal(metadata.assets.jwt, 'fake-completion');
  assert.equal(metadata.assets.config._headers, 'frozen-headers');
  assert.deepEqual(metadata.assets.config.run_worker_first, ['/api/*', '/video/*', '/download/BV*']);
  assert.equal(metadata.assets.config.not_found_handling, '404-page');
  assert.equal(metadata.keep_assets, undefined);
});

test('回退使用 Wrangler assets-only 元数据分支，移除模块和 ASSETS', () => {
  const metadata = buildUploadMetadata(baseline, 'fake-completion', 'old-headers', settings);
  assert(!Object.hasOwn(metadata, 'main_module'));
  assert(!Object.hasOwn(metadata, 'bindings'));
  assert(!Object.hasOwn(metadata.assets.config, 'run_worker_first'));
  assert.equal(metadata.assets.config._headers, 'old-headers');
  assert.equal(metadata.assets.config.not_found_handling, '404-page');
});

test('当前 Wrangler 官方资源哈希与旧版独立核对的 BLAKE3 向量一致', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gallery-asset-hash-'));
  try {
    const file = join(directory, 'example.png');
    await writeFile(file, 'hello');
    const hashAssetFile = await createAssetHasher();
    // Independently calculated with the previously installed blake3-wasm:
    // BLAKE3("aGVsbG8=" + "png").hex().slice(0, 32).
    assert.equal(hashAssetFile(file), '2739e70937f16e2eb481b5a8e7f742df');
  } finally { await rm(directory, { recursive: true }); }
});
