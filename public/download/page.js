const $ = selector => document.querySelector(selector);
const input = $('#video-link'), form = $('#download-form'), feedback = $('#feedback'), result = $('#result'), submit = $('#resolve');
const storageKey = 'damaige.contact-gallery.theme.v1';
let controller, downloadController, collection, revision = 0, autoDownload = false;

function setTheme(mode) {
  document.documentElement.dataset.theme = mode;
  $('#theme').textContent = mode === 'dark' ? '浅色' : '深色';
  $('#theme').setAttribute('aria-label', mode === 'dark' ? '切换浅色主题' : '切换深色主题');
  document.querySelector('meta[name="theme-color"]').content = mode === 'dark' ? '#181A1E' : '#EDEDEB';
}
let savedTheme;
try { savedTheme = localStorage.getItem(storageKey); } catch {}
setTheme(savedTheme === 'light' ? 'light' : 'dark');
$('#theme').addEventListener('click', () => {
  const mode = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(mode);
  try { localStorage.setItem(storageKey, mode); } catch {}
});

function status(message, invalid = false) {
  feedback.textContent = message;
  feedback.hidden = !message;
  input.setAttribute('aria-invalid', String(invalid));
}
function busy(value) {
  form.setAttribute('aria-busy', String(value));
  submit.disabled = value;
  submit.textContent = value ? '正在查找…' : '获取图集 →';
}
input.addEventListener('input', () => {
  revision++;
  controller?.abort();
  downloadController?.abort();
  $('#download').removeAttribute('aria-disabled');
  $('#download').textContent = '下载整期图片 ↓';
  collection = null;
  busy(false);
  result.hidden = true;
  status('');
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const startDownload = autoDownload;
  autoDownload = false;
  downloadController?.abort();
  $('#download').removeAttribute('aria-disabled');
  $('#download').textContent = '下载整期图片 ↓';
  collection = null;
  const value = input.value.trim();
  result.hidden = true;
  controller?.abort();
  const current = ++revision;
  if (!value) { status('请先粘贴一条 B 站视频链接或 BV 号。', true); input.focus(); return; }
  controller = new AbortController();
  busy(true);
  status('正在查找这一期的图集…');
  try {
    const response = await fetch('/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: value }), signal: controller.signal });
    const body = await response.json();
    if (current !== revision) return;
    if (!response.ok) { status(body.message || '暂时无法获取图集，请稍后再试。', response.status === 400); return; }
    collection = body;
    $('#result-title').textContent = body.title;
    $('#result-meta').textContent = `${body.imageCount} 张原图 · ${(body.bytes / 1000000).toFixed(1)} MB · ${body.bvid}`;
    $('#download').href = body.downloadUrl;
    $('#download').download = body.bvid + '.zip';
    $('#read').href = body.readUrl;
    $('#download-note').textContent = 'ZIP 包解压后，即可保存原图。';
    status('');
    result.hidden = false;
    $('#download').focus({ preventScroll: true });
    result.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    if (startDownload) $('#download').click();
  } catch (error) {
    if (current === revision && error.name !== 'AbortError') status('网络连接失败，请检查网络后重新获取。');
  } finally { if (current === revision) busy(false); }
});

function archiveEntries(selected) {
  if (typeof selected.bvid !== 'string' || selected.bvid.length !== 12 || !/^BV1[A-Za-z0-9]{9}$/.test(selected.bvid)) throw Error('invalid archive identifier');
  if (!Array.isArray(selected.entries) || selected.entries.length < 1 || selected.entries.length >= 0xffff || selected.imageCount !== selected.entries.length) throw Error('invalid archive members');
  const names = new Set();
  return selected.entries.map(entry => {
    if (!entry || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.png$/.test(entry.name) || /[^A-Za-z0-9_.-]/.test(entry.name)) throw Error('invalid member name');
    if (entry.src !== `/images/${selected.bvid}/${entry.name}`) throw Error('invalid member source');
    const folded = entry.name.toLowerCase();
    if (names.has(folded)) throw Error('duplicate member');
    names.add(folded);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 25 * 1024 * 1024 || !Number.isInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > 0xffffffff) throw Error('invalid member size or CRC');
    if (typeof entry.sha256 !== 'string' || entry.sha256.length !== 64 || /[^A-Fa-f0-9]/.test(entry.sha256)) throw Error('invalid member SHA');
    return { ...entry, sha256: entry.sha256.toLowerCase(), nameBytes: new TextEncoder().encode(entry.name) };
  });
}

async function verifyArchive(buffer, entries, verifier, checkActive) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer), footer = bytes.length - 22;
  const fail = () => { throw Error('ZIP layout does not match this collection'); };
  const range = (offset, length, limit) => { if (offset < 0 || length < 0 || offset + length > limit) fail(); };
  const nameMatches = (offset, name, limit) => {
    range(offset, name.length, limit);
    for (let index = 0; index < name.length; index++) if (bytes[offset + index] !== name[index]) fail();
  };
  range(footer, 22, bytes.length);
  if (view.getUint32(footer, true) !== 0x06054b50 || view.getUint16(footer + 4, true) !== 0 || view.getUint16(footer + 6, true) !== 0 || view.getUint16(footer + 8, true) !== entries.length || view.getUint16(footer + 10, true) !== entries.length || view.getUint16(footer + 20, true) !== 0) fail();
  const directoryBytes = view.getUint32(footer + 12, true), directoryOffset = view.getUint32(footer + 16, true);
  if (directoryOffset + directoryBytes !== footer) fail();
  const members = [];
  let cursor = 0;
  for (const entry of entries) {
    checkActive();
    range(cursor, 30, directoryOffset);
    if (view.getUint32(cursor, true) !== 0x04034b50 || view.getUint16(cursor + 4, true) !== 20 || view.getUint16(cursor + 6, true) !== 0x0800 || view.getUint16(cursor + 8, true) !== 0 || view.getUint16(cursor + 10, true) !== 0 || view.getUint16(cursor + 12, true) !== 0x0021 || view.getUint32(cursor + 14, true) !== entry.crc32 || view.getUint32(cursor + 18, true) !== entry.bytes || view.getUint32(cursor + 22, true) !== entry.bytes || view.getUint16(cursor + 26, true) !== entry.nameBytes.length || view.getUint16(cursor + 28, true) !== 0) fail();
    nameMatches(cursor + 30, entry.nameBytes, directoryOffset);
    const dataOffset = cursor + 30 + entry.nameBytes.length;
    range(dataOffset, entry.bytes, directoryOffset);
    members.push({ localOffset: cursor, dataOffset });
    cursor = dataOffset + entry.bytes;
  }
  if (cursor !== directoryOffset) fail();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    range(cursor, 46, footer);
    if (view.getUint32(cursor, true) !== 0x02014b50 || view.getUint16(cursor + 4, true) !== 20 || view.getUint16(cursor + 6, true) !== 20 || view.getUint16(cursor + 8, true) !== 0x0800 || view.getUint16(cursor + 10, true) !== 0 || view.getUint16(cursor + 12, true) !== 0 || view.getUint16(cursor + 14, true) !== 0x0021 || view.getUint32(cursor + 16, true) !== entry.crc32 || view.getUint32(cursor + 20, true) !== entry.bytes || view.getUint32(cursor + 24, true) !== entry.bytes || view.getUint16(cursor + 28, true) !== entry.nameBytes.length || view.getUint16(cursor + 30, true) !== 0 || view.getUint16(cursor + 32, true) !== 0 || view.getUint16(cursor + 34, true) !== 0 || view.getUint16(cursor + 36, true) !== 0 || view.getUint32(cursor + 38, true) !== 0 || view.getUint32(cursor + 42, true) !== members[index].localOffset) fail();
    nameMatches(cursor + 46, entry.nameBytes, footer);
    cursor += 46 + entry.nameBytes.length;
  }
  if (cursor !== footer) fail();
  // CRC is import-time metadata; hash original member bytes without recomputing CRC.
  for (let index = 0; index < entries.length; index++) {
    checkActive();
    const entry = entries[index], member = members[index];
    const digest = await verifier.digest('SHA-256', new Uint8Array(buffer, member.dataOffset, entry.bytes));
    checkActive();
    const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== entry.sha256) throw Error('member checksum mismatch');
  }
}

$('#download').addEventListener('click', async event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = $('#download'), note = $('#download-note'), selected = collection, current = revision;
  if (!selected) { event.preventDefault(); return; }
  const verifier = globalThis.crypto?.subtle;
  if (new URL(link.href).origin !== location.origin || !verifier || selected.entries == null || selected.bytes > 25 * 1024 * 1024) {
    note.textContent = '已请求直接下载，请在浏览器下载列表中查看。';
    return;
  }
  event.preventDefault();
  if (!selected || link.getAttribute('aria-disabled') === 'true') return;
  downloadController = new AbortController();
  const active = downloadController;
  const deadline = setTimeout(() => active.abort(new DOMException('下载超时', 'TimeoutError')), 180000);
  link.setAttribute('aria-disabled', 'true');
  link.textContent = '正在下载…';
  note.textContent = '正在获取原图包，请稍候。';
  const checkActive = () => {
    if (current !== revision) throw new DOMException('已取消旧图集', 'AbortError');
    if (active.signal.aborted) throw active.signal.reason;
  };
  try {
    const entries = archiveEntries(selected);
    if (!Number.isSafeInteger(selected.bytes) || selected.bytes < 1 || selected.bytes > 25 * 1024 * 1024) throw Error('invalid package size');
    const response = await fetch(selected.downloadUrl, { signal: active.signal });
    if (!response.ok || !/application\/(?:zip|octet-stream)/i.test(response.headers.get('content-type') ?? '')) throw Error('not a ZIP');
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > selected.bytes) { await reader.cancel(); throw Error('package grew'); }
      chunks.push(part.value);
      if (current === revision) note.textContent = `正在下载 ${(bytes / 1000000).toFixed(1)} / ${(selected.bytes / 1000000).toFixed(1)} MB…`;
    }
    if (bytes !== selected.bytes) throw Error('incomplete package');
    const blob = new Blob(chunks, { type: 'application/zip' });
    await verifyArchive(await blob.arrayBuffer(), entries, verifier, checkActive);
    checkActive();
    const url = URL.createObjectURL(blob), save = document.createElement('a');
    save.href = url; save.download = selected.bvid + '.zip';
    document.body.append(save); save.click(); save.remove();
    // One cleanup timer; no business status queries or retries.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    note.textContent = '图片包已校验并请求保存，请在浏览器下载列表中查看。';
  } catch (error) {
    if (current === revision && error.name !== 'AbortError') note.textContent = '下载未完成，请检查网络后重新点击下载。';
  } finally {
    clearTimeout(deadline);
    if (current === revision) { link.removeAttribute('aria-disabled'); link.textContent = '下载整期图片 ↓'; }
  }
});
$('#copy-example').addEventListener('click', async () => {
  const button = $('#copy-example');
  try { await navigator.clipboard.writeText($('#direct-example').textContent); button.textContent = '链接已复制'; }
  catch { button.textContent = '请长按或选中上方链接复制'; }
});
const params = new URLSearchParams(location.search);
const initial = params.get('video') ?? params.get('bvid') ?? params.get('url');
if (initial) input.value = initial.slice(0, 4096);
if (params.has('bvid')) status('这期视频暂未收录。你可以返回作品墙浏览已有图集。');
if (params.get('error') === 'invalid') status('下载链接格式不正确，请粘贴原始 B 站视频链接。', true);
if (params.get('auto') === '1' && /^BV1[A-Za-z0-9]{9}$/.test(params.get('video') ?? '')) {
  autoDownload = true;
  form.requestSubmit();
}
