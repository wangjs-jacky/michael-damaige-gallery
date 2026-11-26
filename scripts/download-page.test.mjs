import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';

// Execute the shipped script with DOM, network and clock boundaries only.
// These tests verify integrity and save requests, not browser filesystem access.
const page = new Script(await readFile(new URL('../public/download/page.js', import.meta.url), 'utf8'), { filename: 'download/page.js' });
const origin = 'https://gallery.example';
const bvid = 'BV1LwhB65E8e';
const otherBvid = 'BV1fvpX6BEY5';
const packageBytes = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]);
const expectedSHA = createHash('sha256').update(packageBytes).digest('hex');
const expectedDigest = Uint8Array.from(createHash('sha256').update(packageBytes).digest()).buffer;
const collection = {
  bvid, title: '测试图集', imageCount: 9, bytes: packageBytes.length, sha256: expectedSHA,
  downloadUrl: `/downloads/${bvid}.zip`, readUrl: `/#video=${bvid}`,
  sourceUrl: `https://www.bilibili.com/video/${bvid}/`,
};
const zipResponse = (bytes = packageBytes) => new Response(bytes, { headers: { 'content-type': 'application/zip' } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function delayedDigest() {
  const started = deferred(), completed = deferred();
  return {
    crypto: { subtle: { digest() { started.resolve(); return completed.promise; } } },
    started: started.promise,
    finish: () => completed.resolve(expectedDigest),
  };
}

function createPage(options = {}) {
  const elements = new Map(), blobs = new Map(), timers = new Map();
  const saves = [], requests = [], revoked = [], automaticActions = [];
  const firstSave = deferred();
  let timerId = 0, blobId = 0;

  class Element {
    constructor() {
      this.listeners = new Map();
      this.attributes = new Map();
      this.value = this.textContent = '';
      this.hidden = true;
    }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    set href(value) { this.address = new URL(value, origin).href; }
    get href() { return this.address ?? origin + '/download/'; }
    focus() {}
    scrollIntoView() {}
    append(element) { element.connected = true; }
    remove() { this.connected = false; }
    requestSubmit() {
      const handler = this.listeners.get('submit');
      assert(handler, 'requestSubmit requires the registered form handler');
      automaticActions.push(Promise.resolve(handler(event())));
    }
    click() {
      const handler = this.listeners.get('click');
      if (handler) {
        automaticActions.push(Promise.resolve(handler(event())));
        return;
      }
      assert.equal(this.connected, true, 'the save link must be attached before activation');
      assert(blobs.has(this.href), 'the save request must use the verified Blob');
      saves.push({ filename: this.download, blob: blobs.get(this.href) });
      firstSave.resolve();
    }
  }

  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  }
  function event(extra = {}) {
    return { button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  }
  function dispatch(selector, name, extra) {
    const emitted = event(extra);
    const handler = element(selector).listeners.get(name);
    assert(handler, `missing ${name} handler for ${selector}`);
    return { event: emitted, done: Promise.resolve(handler(emitted)) };
  }
  class PageURL extends URL {
    static createObjectURL(blob) {
      const address = `blob:${origin}/${++blobId}`;
      blobs.set(address, blob);
      return address;
    }
    static revokeObjectURL(address) { revoked.push(address); blobs.delete(address); }
  }
  const context = createContext({
    document: {
      querySelector: element, documentElement: { dataset: {} }, body: new Element(),
      createElement(tag) { assert.equal(tag, 'a'); return new Element(); },
    },
    location: { origin, search: options.search ?? '' },
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { clipboard: { async writeText() {} } },
    URL: PageURL, URLSearchParams, Blob, Uint8Array, AbortController, DOMException,
    crypto: options.crypto === undefined ? webcrypto : options.crypto,
    setTimeout(callback, milliseconds) {
      const id = ++timerId;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, init) {
      requests.push({ url, init });
      if (url === '/api/resolve') {
        const input = JSON.parse(init.body).input;
        const body = options.resolve?.(input) ?? { ...collection, ...options.collection };
        return Response.json(body);
      }
      return options.download?.(url, init) ?? zipResponse();
    },
  });
  page.runInContext(context);

  return {
    element, saves, requests, revoked,
    firstSave: firstSave.promise,
    finishAutomaticActions: () => Promise.all(automaticActions),
    async submit(value = bvid) {
      element('#video-link').value = value;
      await dispatch('#download-form', 'submit').done;
    },
    async edit(value = otherBvid) {
      element('#video-link').value = value;
      await dispatch('#video-link', 'input').done;
    },
    clickDownload: () => dispatch('#download', 'click'),
    fireTimer(milliseconds) {
      const pending = [...timers].find(([, timer]) => timer.milliseconds === milliseconds);
      assert(pending, `expected a pending ${milliseconds} ms timer`);
      timers.delete(pending[0]);
      pending[1].callback();
    },
  };
}

function assertFailed(app) {
  assert.equal(app.saves.length, 0);
  assert.match(app.element('#download-note').textContent, /下载未完成/);
  assert.equal(app.element('#download').getAttribute('aria-disabled'), null);
  assert.match(app.element('#download').textContent, /下载整期图片/);
}

test('a valid video auto entry verifies and saves once without an extra user click', { timeout: 2000 }, async () => {
  const app = createPage({ search: `?video=${bvid}&auto=1` });
  await app.firstSave;
  await app.finishAutomaticActions();
  assert.equal(app.element('#video-link').value, bvid);
  assert.equal(app.saves.length, 1);
  assert.equal(app.saves[0].filename, bvid + '.zip');
  assert.deepEqual(new Uint8Array(await app.saves[0].blob.arrayBuffer()), packageBytes);
  assert.equal(app.requests.filter(request => request.url === '/api/resolve').length, 1);
  assert.equal(app.requests.filter(request => request.url === collection.downloadUrl).length, 1);
  assert.match(app.element('#download-note').textContent, /已校验并请求保存/);
  await app.submit();
  assert.equal(app.saves.length, 1, 'resubmitting must not reuse the consumed automatic download flag');
  assert.equal(app.requests.filter(request => request.url === collection.downloadUrl).length, 1);
});

test('invalid video parameters cannot trigger automatic resolve or save requests', { timeout: 2000 }, async () => {
  for (const search of [
    '?video=invalid&auto=1',
    `?video=${bvid}suffix&auto=1`,
    '?video=https%3A%2F%2Fevil.test%2Fvideo%2FBV1LwhB65E8e&auto=1',
    '?video=&auto=1',
    `?bvid=${bvid}&auto=1`,
  ]) {
    const app = createPage({ search });
    await app.finishAutomaticActions();
    assert.equal(app.requests.length, 0, search);
    assert.equal(app.saves.length, 0, search);
  }
});

test('a verified package requests exactly one Blob save despite another pending click', { timeout: 2000 }, async () => {
  const response = deferred();
  const app = createPage({ download: () => response.promise });
  await app.submit();
  const first = app.clickDownload(), second = app.clickDownload();
  response.resolve(zipResponse());
  await Promise.all([first.done, second.done]);
  assert.equal(first.event.defaultPrevented, true);
  assert.equal(app.requests.filter(request => request.url === collection.downloadUrl).length, 1);
  assert.equal(app.saves.length, 1);
  assert.equal(app.saves[0].filename, bvid + '.zip');
  assert.deepEqual(new Uint8Array(await app.saves[0].blob.arrayBuffer()), packageBytes);
  assert.match(app.element('#download-note').textContent, /已校验并请求保存/);
  assert.equal(app.element('#download').getAttribute('aria-disabled'), null);
  app.fireTimer(60000);
  assert.equal(app.revoked.length, 1);
});

test('a same-length package with the wrong SHA is refused and the download link recovers', { timeout: 2000 }, async () => {
  const damaged = packageBytes.slice();
  damaged[10] ^= 1;
  const app = createPage({ download: () => zipResponse(damaged) });
  await app.submit();
  await app.clickDownload().done;
  assertFailed(app);
});

test('a pending fetch is aborted after the 180 second deadline and can be retried', { timeout: 2000 }, async () => {
  let attempts = 0;
  const app = createPage({ download: (_url, { signal }) => {
    if (++attempts > 1) return zipResponse();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  await app.submit();
  const pending = app.clickDownload();
  app.fireTimer(180000);
  await pending.done;
  assertFailed(app);
  assert.equal(app.requests.at(-1).init.signal.aborted, true);
  await app.clickDownload().done;
  assert.equal(app.saves.length, 1);
  assert.match(app.element('#download-note').textContent, /已校验并请求保存/);
});

test('a deadline reached during SHA calculation reports failure rather than leaving download progress', { timeout: 2000 }, async () => {
  const digest = delayedDigest();
  const app = createPage({ crypto: digest.crypto });
  await app.submit();
  const pending = app.clickDownload();
  await digest.started;
  app.fireTimer(180000);
  digest.finish();
  await pending.done;
  assertFailed(app);
});

test('editing the input while SHA is pending prevents the old package from being saved', { timeout: 2000 }, async () => {
  const digest = delayedDigest();
  const app = createPage({ crypto: digest.crypto });
  await app.submit();
  const pending = app.clickDownload();
  await digest.started;
  await app.edit();
  digest.finish();
  await pending.done;
  assert.equal(app.saves.length, 0);
  assert.equal(app.element('#result').hidden, true);
  assert.equal(app.element('#download').getAttribute('aria-disabled'), null);
  assert.equal(app.requests.at(-1).init.signal.aborted, true);
});

test('resubmitting the form rejects an old package and preserves the new collection', { timeout: 2000 }, async () => {
  const digest = delayedDigest();
  const app = createPage({ crypto: digest.crypto, resolve: input => ({
    ...collection, bvid: input, title: input === bvid ? '旧图集' : '新图集', downloadUrl: `/downloads/${input}.zip`,
  }) });
  await app.submit();
  const pending = app.clickDownload();
  await digest.started;
  await app.submit(otherBvid);
  digest.finish();
  await pending.done;
  assert.equal(app.saves.length, 0);
  assert.equal(app.element('#result-title').textContent, '新图集');
  assert.equal(app.element('#result').hidden, false);
  assert.equal(app.element('#download').href, origin + `/downloads/${otherBvid}.zip`);
  assert.doesNotMatch(app.element('#download-note').textContent, /未完成|已校验/);
  await app.clickDownload().done;
  assert.equal(app.saves.length, 1);
  assert.equal(app.saves[0].filename, otherBvid + '.zip');
});

for (const [name, options] of [
  ['missing SHA', { collection: { sha256: undefined } }],
  ['missing crypto', { crypto: null }],
  ['an external package', { collection: { downloadUrl: `https://jacky-bucket-hk.oss-cn-hongkong.aliyuncs.com/michael-damaige-gallery/2026-11-03/${bvid}.zip` } }],
]) {
  test(`${name} keeps native download available without claiming SHA verification`, { timeout: 2000 }, async () => {
    const app = createPage(options);
    await app.submit();
    const clicked = app.clickDownload();
    await clicked.done;
    assert.equal(clicked.event.defaultPrevented, false);
    assert.equal(app.requests.length, 1, 'native fallback must not issue a CORS fetch');
    assert.equal(app.saves.length, 0);
    assert.match(app.element('#download-note').textContent, /已请求直接下载/);
    assert.doesNotMatch(app.element('#download-note').textContent, /已校验/);
  });
}
