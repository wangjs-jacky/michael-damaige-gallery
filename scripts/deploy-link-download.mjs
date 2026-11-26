import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { validateEpisodeProof } from './pipeline/proof.mjs';

const scriptName = 'michael-damaige-gallery';
const origin = 'https://damaige.paws.rodeo';
const routePatterns = ['/api/*', '/video/*', '/download/BV*'];
const featureFiles = new Set(['index.html', 'download/index.html', 'download/page.css', 'download/page.js']);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const execute = promisify(execFile);
async function readPublicHomepage() {
  // Use the same proxy-aware CLI path as image restoration. This is one bounded
  // read, not an automatic readiness/retry loop after activation.
  try {
    const { stdout } = await execute('curl', ['--fail', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '40',
      '--header', 'Cache-Control: no-cache', origin + '/'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 45000 });
    return stdout;
  } catch { throw new Error('正式首页单次读取未完成；未自动重试。'); }
}
const same = (actual, expected, message) => assert(isDeepStrictEqual(actual, expected), message);
const bindingsFor = config => config.main ? [{ name: 'ASSETS', type: 'assets' }] : [];

export async function createAssetHasher() {
  // Use the same public helper that the installed Wrangler uses. Its BLAKE3
  // input is base64(file bytes) followed by the extension without its dot.
  const { createFileHasher } = await import('@cloudflare/workers-utils/asset-hash');
  return createFileHasher();
}

export function validateConfigurationPair(target, baseline, accountId) {
  assert.match(accountId ?? '', /^[a-f0-9]{32}$/, '部署工程没有有效的账户标识。');
  for (const config of [target, baseline]) {
    assert.equal(config.name, scriptName, 'Worker 名称不匹配。');
    assert.equal(config.account_id, accountId, '快照账户与部署工程不匹配。');
    assert.equal(config.workers_dev, false, '必须保持 workers.dev 关闭。');
    assert.equal(config.preview_urls, false, '必须保持版本预览关闭。');
    assert.equal(config.assets?.directory, './public', '公开资源目录不匹配。');
    assert.equal(config.assets?.not_found_handling, '404-page', '必须保留原 404 行为。');
    assert.equal(config.routes?.length, 1, '正式域名路由数量变化。');
    assert.equal(config.routes[0].pattern, new URL(origin).hostname, '正式域名变化。');
    assert.equal(config.routes[0].custom_domain, true, '必须使用原自定义域名。');
    if (config.main !== undefined) {
      assert.equal(config.main, 'worker.mjs', '只允许冻结的单文件 Worker 入口。');
      assert.equal(config.assets.binding, 'ASSETS', '资源绑定必须为 ASSETS。');
      same(config.assets.run_worker_first, routePatterns, 'Worker 优先路由超出本功能范围。');
    } else {
      assert.equal(config.assets.binding, undefined, '纯静态快照不应声明资源绑定。');
      assert.equal(config.assets.run_worker_first, undefined, '纯静态快照不应声明 Worker 优先路由。');
    }
  }
  const normalized = config => {
    const copy = structuredClone(config);
    delete copy.main;
    delete copy.assets.binding;
    delete copy.assets.run_worker_first;
    return copy;
  };
  same(normalized(target), normalized(baseline), '除本功能入口与资源绑定外，冻结配置必须保持一致。');
}

function headerRules(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.startsWith('/')) rules.push({ path: line.trim(), headers: [] });
    else {
      assert(rules.length && /^\s/.test(line), '响应头控制文件格式不正确。');
      rules.at(-1).headers.push(line.trim());
    }
  }
  return rules;
}

export function validateHeadersPair(target, baseline) {
  const featurePaths = new Set(['/download', '/download/', '/download/index.html']);
  const existingRules = text => headerRules(text).filter(rule => !featurePaths.has(rule.path));
  same(existingRules(target), existingRules(baseline), '原站响应头、安全策略或缓存发生变化。');
  for (const text of [target, baseline]) {
    for (const rule of headerRules(text).filter(rule => featurePaths.has(rule.path))) {
      same(rule.headers, ['! Cache-Control', 'Cache-Control: public, max-age=0, must-revalidate, no-transform'],
        '新增下载页的响应头超出允许范围。');
    }
  }
}

export function validateCloudSettings(settings, config) {
  assert.equal(settings.compatibility_date, config.compatibility_date, '云端兼容日期与基线不一致。');
  same(settings.compatibility_flags ?? [], config.compatibility_flags ?? [], '云端兼容标志与基线不一致。');
  assert.equal(settings.logpush ?? false, config.logpush ?? false, '云端日志配置与基线不一致。');
  assert.equal(settings.usage_model, 'standard', '云端使用模型已变化。');
  // Only compare names/types: an unexpected secret binding must never be printed.
  const bindings = settings.bindings ?? [];
  assert(Array.isArray(bindings), '云端绑定结构不正确。');
  assert(bindings.every(binding => binding?.type === 'assets' && binding.name === 'ASSETS'),
    '发现预期之外的绑定；停止且不输出绑定值。');
  same(bindings.map(({ name, type }) => ({ name, type })), bindingsFor(config), '云端绑定与基线快照不一致。');
}

const preservedSettings = settings => Object.fromEntries([
  'compatibility_date', 'compatibility_flags', 'logpush', 'usage_model', 'observability',
  'placement', 'limits', 'tail_consumers', 'streaming_tail_consumers', 'cache_options',
].filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));

export function buildUploadMetadata(config, completion, headers, settings = {}) {
  const metadata = {
    compatibility_date: config.compatibility_date,
    assets: {
      jwt: completion,
      config: {
        html_handling: config.assets.html_handling ?? 'auto-trailing-slash',
        not_found_handling: config.assets.not_found_handling,
        ...(config.assets.base_path ? { base_path: config.assets.base_path } : {}),
        _headers: headers,
        ...(config.main ? { run_worker_first: config.assets.run_worker_first } : {}),
      },
    },
  };
  if (config.main) {
    metadata.main_module = 'worker.mjs';
    metadata.bindings = bindingsFor(config);
  }
  // Match Wrangler's assets-only upload form on rollback (no main_module or bindings).
  for (const key of ['compatibility_flags', 'logpush', 'observability', 'placement', 'limits',
    'tail_consumers', 'streaming_tail_consumers', 'cache_options']) {
    if (settings[key] !== undefined) metadata[key] = settings[key];
  }
  return metadata;
}

async function readSnapshot(path, checkSite) {
  const manifest = await checkSite(path);
  const manifestBytes = await readFile(join(path, 'release-manifest.json'));
  const config = await readJSON(join(path, 'wrangler.json'));
  assert.equal(manifest.worker.name, scriptName, '清单的 Worker 名称不匹配。');
  assert.equal(manifest.worker.accountId, config.account_id, '清单账户与配置不匹配。');
  assert.equal(manifest.worker.compatibilityDate, config.compatibility_date, '清单兼容日期与配置不匹配。');
  const headers = await readFile(join(path, 'public/_headers'), 'utf8');
  let worker;
  if (config.main) {
    assert((await lstat(join(path, 'worker.mjs'))).isFile(), 'Worker 入口必须是普通文件。');
    worker = await readFile(join(path, 'worker.mjs'));
    assert.equal(worker.length, manifest.controls.worker?.bytes, 'Worker 字节数与冻结清单不匹配。');
    assert.equal(sha256(worker), manifest.controls.worker?.sha256, 'Worker SHA256 与冻结清单不匹配。');
    assert(!/^\s*import(?:\s|["'{*])/m.test(worker.toString()) &&
      !/\bimport\s*\(/.test(worker.toString()) &&
      !/^\s*export\b[^;\n]*\bfrom\s*["']/m.test(worker.toString()), 'Worker 必须是无外部导入的单文件模块。');
    try {
      execFileSync(process.execPath, ['--check', join(path, 'worker.mjs')], { stdio: 'pipe', timeout: 15000 });
    } catch {
      throw new Error('冻结的 Worker 未通过 Node.js 语法检查。');
    }
  } else assert.equal(manifest.controls.worker, undefined, '纯静态快照不应有 Worker 控制记录。');
  return { path, manifest, manifestSha256: sha256(manifestBytes), config, headers, worker };
}

export async function checkLocalReleasePair(project, targetName, baselineName) {
  const validName = name => /^\d{8}-[a-z0-9-]+$/.test(name ?? '');
  assert(validName(targetName) && validName(baselineName) && targetName !== baselineName, '需要两个不同的有效冻结版本名。');
  const skill = await realpath(join(homedir(), '.codex/skills/static-publish'));
  const { checkSite } = await import(pathToFileURL(join(skill, 'scripts/site.mjs')).href);
  const target = await readSnapshot(join(project, 'releases', targetName), checkSite);
  const baseline = await readSnapshot(join(project, 'releases', baselineName), checkSite);
  const site = await readJSON(join(project, 'site.json'));
  validateConfigurationPair(target.config, baseline.config, site.worker?.accountId);
  same(target.manifest.worker, baseline.manifest.worker, '发布清单的 Worker 元数据发生变化。');
  validateHeadersPair(target.headers, baseline.headers);
  const targetFiles = new Map(target.manifest.files.map(file => [file.source, file]));
  const baselineFiles = new Map(baseline.manifest.files.map(file => [file.source, file]));
  const changed = [];
  if (baseline.manifest.changeProof?.source === 'change-proof.json') {
    const proofBytes = await readFile(join(baseline.path, 'change-proof.json'));
    assert.equal(sha256(proofBytes), baseline.manifest.changeProof.sha256, '当前快照的回退证明已变化');
    const proof = JSON.parse(proofBytes);
    if (proof.baseline?.manifest?.sha256 === target.manifestSha256) {
      // Only the exact immediate parent is eligible; validate the complete
      // forward delta in reverse before allowing this explicitly chosen target.
      const reverse = await validateEpisodeProof(baseline, target);
      return { target, baseline, changed: reverse, direction: 'rollback', checkSite };
    }
  }
  if (target.manifest.changeProof) {
    const incrementalChanges = await validateEpisodeProof(target, baseline);
    return { target, baseline, changed: incrementalChanges, direction: 'forward', checkSite };
  }
  for (const source of new Set([...targetFiles.keys(), ...baselineFiles.keys()])) {
    const next = targetFiles.get(source), previous = baselineFiles.get(source);
    if (next?.sha256 === previous?.sha256 && next?.bytes === previous?.bytes) continue;
    assert(featureFiles.has(source), '发现本功能以外的公开文件变化：' + source);
    changed.push(source);
  }
  return { target, baseline, changed, checkSite };
}

function existingAuthorization(wrangler) {
  let output;
  try {
    output = execFileSync(process.execPath, [wrangler, 'auth', 'token', '--json'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
  } catch (error) {
    // Child-process errors can contain its stdout. Never propagate that object.
    throw new Error('读取已有 Wrangler OAuth 失败，退出状态：' + (error.status ?? '未完成'));
  }
  let payload;
  try { payload = JSON.parse(output); } catch { throw new Error('Wrangler OAuth 输出格式不正确；内容未记录。'); }
  assert(typeof payload.token === 'string' && payload.token.length, '没有可用的已有 Wrangler OAuth。');
  return payload.token;
}

async function applyRelease(project, targetName, baselineName, local, hashAssetFile) {
  const { target, baseline, checkSite } = local;
  const wrangler = join(repo, 'node_modules/wrangler/bin/wrangler.js');
  const token = existingAuthorization(wrangler);
  const api = `https://api.cloudflare.com/client/v4/accounts/${target.config.account_id}/workers`;
  const script = '/scripts/' + scriptName;
  async function request(path, options = {}, credential = token) {
    let response;
    try {
      response = await fetch(api + path, { ...options,
        headers: { ...options.headers, authorization: 'Bearer ' + credential },
        signal: AbortSignal.timeout(90000),
      });
    } catch (error) { throw new Error(`Cloudflare ${path} 请求未完成：${error.name}`); }
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`Cloudflare ${path} HTTP ${response.status} 返回非 JSON。`); }
    if (!response.ok || !payload.success) {
      const codes = (payload.errors ?? []).map(error => error.code).filter(code => typeof code === 'number');
      throw new Error(`Cloudflare ${path} HTTP ${response.status}，错误码 ${codes.join(',') || '未提供'}；未记录响应正文。`);
    }
    return payload.result;
  }
  async function identity() {
    const entry = (await request('/scripts')).find(item => item.id === scriptName);
    assert(entry?.has_assets && entry.tag && entry.modified_on, '未找到具有预期资源的既有 Worker。');
    return { tag: entry.tag, modified: entry.modified_on };
  }
  async function verifyProduction(snapshot) {
    const [domains, subdomain, settings, page] = await Promise.all([
      request('/domains'), request(script + '/subdomain'), request(script + '/settings'),
      readPublicHomepage(),
    ]);
    assert(domains.some(domain => domain.hostname === new URL(origin).hostname &&
      domain.service === scriptName && domain.environment === 'production'), '正式域名映射已变化。');
    assert(!subdomain.enabled && !subdomain.previews_enabled, '默认域或版本预览开关已变化。');
    const expected = snapshot.manifest.files.find(file => file.source === 'index.html');
    assert(sha256(page) === expected?.sha256, '正式首页与冻结基线 SHA256 不一致。');
    validateCloudSettings(settings, snapshot.config);
    return settings;
  }
  const [before, settings] = await Promise.all([identity(), verifyProduction(baseline)]);
  const filesById = new Map(), assets = {};
  for (const file of target.manifest.files) {
    assert(/^[A-Za-z0-9._/-]+$/.test(file.source) && !file.source.split('/').includes('..'), '资源路径不安全。');
    const path = join(target.path, 'public', file.source);
    const bytes = await readFile(path);
    assert(sha256(bytes) === file.sha256 && bytes.length === file.bytes, '资源在冻结后变化：' + file.source);
    const id = hashAssetFile(path);
    assets['/' + file.source] = { hash: id, size: bytes.length };
    filesById.set(id, { path, sha256: file.sha256, contentType: file.contentType });
  }
  const session = await request(script + '/assets-upload-session', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: assets }),
  });
  assert(typeof session.jwt === 'string' && Array.isArray(session.buckets) && session.buckets.every(Array.isArray), '资源上传会话结构不完整。');
  let completion = session.jwt, uploaded = 0;
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const id of bucket) {
      const file = filesById.get(id);
      assert(file, '服务请求了冻结清单以外的资源。');
      const bytes = await readFile(file.path);
      assert.equal(sha256(bytes), file.sha256, '暂存时资源已变化。');
      form.append(id, new Blob([bytes.toString('base64')], { type: file.contentType }), id);
    }
    const result = await request('/assets/upload?base64=true', { method: 'POST', body: form }, session.jwt);
    if (result?.jwt) completion = result.jwt;
    uploaded += bucket.length;
  }
  // A single pre-activation recheck; there is no status polling or retry loop.
  await checkSite(target.path);
  assert.equal(sha256(await readFile(join(target.path, 'release-manifest.json'))), target.manifestSha256, '发布清单在暂存期间发生变化。');
  if (target.worker) assert.equal(sha256(await readFile(join(target.path, 'worker.mjs'))), sha256(target.worker), 'Worker 在暂存期间发生变化。');
  const [staged, stagedSettings] = await Promise.all([identity(), verifyProduction(baseline)]);
  same(staged, before, '暂存期间另一次发布改变了 Worker，停止激活。');
  same(stagedSettings, settings, '暂存期间云端设置已变化，停止激活。');
  const form = new FormData();
  form.set('metadata', JSON.stringify(buildUploadMetadata(target.config, completion, target.headers, settings)));
  if (target.worker) form.set('worker.mjs', new Blob([target.worker], { type: 'application/javascript+module' }), 'worker.mjs');
  const receipt = {
    snapshot: targetName, baseline: baselineName, origin, worker: scriptName,
    manifestSha256: target.manifestSha256,
    workerSha256: target.worker ? sha256(target.worker) : null,
    mode: target.worker ? 'module' : 'assets-only', publicFiles: target.manifest.files.length,
    requestedAssetObjects: session.buckets.flat().length, uploadedAssetObjects: uploaded, before,
    independentVersionVerified: false, browserVerified: false,
  };
  const evidence = join(project, 'evidence', `${targetName}-link-api-${Date.now()}-${randomUUID()}.json`);
  await mkdir(dirname(evidence), { recursive: true });
  let deployed;
  try { deployed = await request(script, { method: 'PUT', body: form }); }
  catch (error) {
    await writeFile(evidence, JSON.stringify({ ...receipt, activation: 'unknown', postActivationVerified: false }, null, 2) + '\n', { flag: 'wx' });
    throw new Error(`${error.message} 激活结果未确认，禁止自动重发；回执：${evidence}`);
  }
  Object.assign(receipt, { deploymentId: deployed.deployment_id ?? null, versionId: deployed.version_id ?? null,
    activation: 'acknowledged' });
  try {
    const afterSettings = await verifyProduction(target);
    same(preservedSettings(afterSettings), preservedSettings(settings), '上线后非功能设置发生变化。');
    receipt.postActivationVerified = true;
  } catch (error) {
    await writeFile(evidence, JSON.stringify({ ...receipt, postActivationVerified: false }, null, 2) + '\n', { flag: 'wx' });
    throw new Error(`${error.message} API 已确认激活，需人工判断恢复；回执：${evidence}`);
  }
  await writeFile(evidence, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return { ...receipt, evidence };
}

export function validateReconciliationScope(target, baseline) {
  assert(target.manifest.changeProof && target.manifest.controls.worker?.sha256 === baseline.manifest.controls.worker?.sha256,
    '代码发生变化，不能仅凭首页对账；需要独立核对实际 Worker 源码或固化版本标记。');
  const page = manifest => manifest.files.find(f => f.source === 'index.html')?.sha256;
  assert(page(target.manifest) && page(target.manifest) !== page(baseline.manifest),
    '首页未变化，不能用首页摘要证明新资源版本已激活。');
}

async function verifyCurrentRelease(project, targetName, target, baseline) {
  validateReconciliationScope(target, baseline);
  const token = existingAuthorization(join(repo, 'node_modules/wrangler/bin/wrangler.js'));
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${target.config.account_id}/workers`;
  const get = async path => {
    const response = await fetch(endpoint + path, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(45000) });
    const payload = await response.json();
    assert(response.ok && payload.success, '云端只读核验失败：' + path);
    return payload.result;
  };
  const [domains, subdomain, settings, page] = await Promise.all([
    get('/domains'), get('/scripts/' + scriptName + '/subdomain'), get('/scripts/' + scriptName + '/settings'), readPublicHomepage(),
  ]);
  assert(domains.some(d => d.hostname === new URL(origin).hostname && d.service === scriptName && d.environment === 'production'), '正式域映射变化');
  assert(!subdomain.enabled && !subdomain.previews_enabled, '默认入口开关变化');
  validateCloudSettings(settings, target.config);
  const expected = target.manifest.files.find(f => f.source === 'index.html');
  assert(page.length === expected.bytes && sha256(page) === expected.sha256, '现网首页不是该冻结版本，禁止将结果标为成功');
  const receipt = { snapshot: targetName, readOnly: true, currentHomepageVerified: true, settingsVerified: true,
    independentVersionVerified: false, homepageSHA256: expected.sha256, verifiedAt: new Date().toISOString() };
  const evidence = join(project, 'evidence', `${targetName}-reconciled-${randomUUID()}.json`);
  await writeFile(evidence, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return { ...receipt, evidence };
}

export async function main(args = process.argv.slice(2)) {
  const [directory, targetName, baselineName, ...flags] = args;
  assert(directory && targetName && baselineName && (flags.length === 0 ||
    (flags.length === 1 && ['--apply', '--verify'].includes(flags[0]))),
  '用法：node scripts/deploy-link-download.mjs DEPLOYMENT_DIR TARGET_NAME BASELINE_NAME [--apply|--verify]');
  const project = await realpath(resolve(directory));
  const local = await checkLocalReleasePair(project, targetName, baselineName);
  if (flags[0] === '--verify') {
    const result = await verifyCurrentRelease(project, targetName, local.target, local.baseline);
    console.log(JSON.stringify(result, null, 2)); return result;
  }
  const hashAssetFile = await createAssetHasher();
  if (!flags.length) {
    const result = { ready: true, applied: false, cloudChecked: false, authorizationRead: false,
      snapshot: targetName, baseline: baselineName, publicFiles: local.target.manifest.files.length,
      mode: local.target.worker ? 'module' : 'assets-only', changedPublicFiles: local.changed,
      direction: local.direction || 'feature-update',
      manifestSha256: local.target.manifestSha256,
      workerSha256: local.target.worker ? sha256(local.target.worker) : null };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const result = await applyRelease(project, targetName, baselineName, local, hashAssetFile);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('发布停止：' + error.message); process.exitCode = 1; });
}
