const BV = /^BV1[A-Za-z0-9]{9}$/;
const VIDEO_HOSTS = new Set(['www.bilibili.com', 'm.bilibili.com', 'bilibili.com']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' };

class DownloadError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const invalid = () => new DownloadError('INVALID_INPUT', '请粘贴一个 B 站视频链接、分享文案或完整 BV 号。');

function parseURL(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalid();
  if (VIDEO_HOSTS.has(url.hostname)) {
    const match = url.pathname.match(/^\/video\/(BV1[A-Za-z0-9]{9})\/?$/);
    if (match) return { bvid: match[1] };
  }
  if (url.hostname === 'b23.tv' && /^\/[A-Za-z0-9]{1,32}\/?$/.test(url.pathname)) {
    return { shortUrl: `https://b23.tv${url.pathname.replace(/\/$/, '')}` };
  }
  throw invalid();
}

export function parseInput(input) {
  if (typeof input !== 'string' || input.length > 4096) throw invalid();
  const value = input.trim();
  if (BV.test(value)) return { bvid: value };
  const links = value.match(/(?:https?:\/\/|(?<![A-Za-z0-9._\/@-])(?:www\.|m\.)?bilibili\.com\/|(?<![A-Za-z0-9._\/@-])b23\.tv\/)[^\s<>"'，。！？【】（）()]+/gi) ?? [];
  if (links.length !== 1) throw invalid();
  const candidate = links[0].replace(/[.,;:!?，。；：！？、）)】\]}]+$/u, '');
  try { return parseURL(new URL(/^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate)); }
  catch { throw invalid(); }
}

export async function resolveInput(input, fetcher = fetch) {
  let parsed = parseInput(input);
  if (parsed.bvid) return parsed.bvid;
  const signal = AbortSignal.timeout(7000);
  const visited = new Set();
  // These are redirects in one user-initiated request, never state polling/retries.
  for (let hop = 0; hop < 3; hop++) {
    if (visited.has(parsed.shortUrl)) break;
    visited.add(parsed.shortUrl);
    try {
      const response = await fetcher(parsed.shortUrl, { method: 'GET', redirect: 'manual', signal });
      const location = response.headers.get('location');
      if (response.body) await response.body.cancel();
      if (!REDIRECTS.has(response.status) || !location) break;
      parsed = parseURL(new URL(location, parsed.shortUrl));
      if (parsed.bvid) return parsed.bvid;
    } catch { break; }
  }
  throw new DownloadError('SHORT_LINK_FAILED', '这个短链接暂时无法解析，请在 B 站打开视频后复制完整链接或 BV 号。', 502);
}

async function readBounded(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw new DownloadError('TOO_LARGE', '链接内容过长，请只粘贴一条视频链接。', 413);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new DownloadError('TOO_LARGE', '链接内容过长，请只粘贴一条视频链接。', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function findVideo(env, request, bvid) {
  try {
    const response = await env.ASSETS.fetch(new Request(new URL('/catalog.json', request.url)));
    if (!response.ok) throw new Error('catalog unavailable');
    const catalog = JSON.parse(await readBounded(response, 1024 * 1024));
    if (!Array.isArray(catalog.videos)) throw new Error('invalid catalog');
    return catalog.videos.find(video => video.bvid === bvid);
  } catch {
    throw new DownloadError('CATALOG_UNAVAILABLE', '图集目录暂时无法读取，请稍后再试。', 503);
  }
}

function packageURL(video, origin) {
  // The target comes exclusively from our deployed catalogue, never from input.
  const url = new URL(video.download?.url ?? '', origin);
  const ownPackage = url.origin === origin && url.pathname === `/downloads/${video.bvid}.zip`;
  const originalOSS = url.hostname === 'jacky-bucket-hk.oss-cn-hongkong.aliyuncs.com' && url.pathname === `/michael-damaige-gallery/2026-11-03/${video.bvid}.zip`;
  if (url.username || url.password || url.search || url.hash || (!ownPackage && !(originalOSS && url.protocol === 'https:' && !url.port))) {
    throw new DownloadError('PACKAGE_UNAVAILABLE', '这一期的下载包暂时不可用，你可以先阅读图集。', 503);
  }
  return ownPackage ? url.pathname : url.href;
}

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...HEADERS, ...headers } });
const redirect = location => new Response(null, { status: 302, headers: { ...HEADERS, location } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/resolve') {
        if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED', message: '请通过下载页面提交链接。' }, 405, { allow: 'POST' });
        if ((request.headers.has('origin') && request.headers.get('origin') !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
          return json({ code: 'FORBIDDEN', message: '请在本站下载页面提交链接。' }, 403);
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
          return json({ code: 'INVALID_INPUT', message: '请通过下载页面提交链接。' }, 415);
        }
        const raw = await readBounded(request, 16 * 1024);
        let body;
        try { body = JSON.parse(raw); } catch { throw invalid(); }
        const bvid = await resolveInput(body?.input);
        const video = await findVideo(env, request, bvid);
        if (!video) throw new DownloadError('NOT_COLLECTED', '这期视频暂未收录。你可以浏览已有图集，或换一条链接。', 404);
        const downloadUrl = packageURL(video, url.origin);
        return json({ bvid, title: video.title, imageCount: video.images.length, bytes: video.download.bytes, sha256: video.download.sha256, downloadUrl, readUrl: `/#video=${bvid}`, sourceUrl: `https://www.bilibili.com/video/${bvid}/` });
      }
      if (url.pathname.startsWith('/api/')) return json({ code: 'NOT_FOUND', message: '没有这个接口。' }, 404);
      if (url.pathname.startsWith('/video/') || url.pathname.startsWith('/download/BV')) {
        if (!['GET', 'HEAD'].includes(request.method)) return json({ code: 'METHOD_NOT_ALLOWED', message: '请使用下载链接。' }, 405, { allow: 'GET, HEAD' });
        const match = url.pathname.match(/^\/(?:video|download)\/(BV1[A-Za-z0-9]{9})\/?$/);
        if (!match) return redirect('/download/?error=invalid');
        const video = await findVideo(env, request, match[1]);
        if (!video) return redirect(`/download/?bvid=${match[1]}`);
        const target = packageURL(video, url.origin);
        if (url.searchParams.get('raw') === '1') return redirect(target);
        return redirect(`/download/?video=${video.bvid}&auto=1`);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof DownloadError) return json({ code: error.code, message: error.message }, error.status);
      console.error(JSON.stringify({ operation: 'link-download', code: 'UNEXPECTED_ERROR' }));
      return json({ code: 'UNAVAILABLE', message: '暂时无法获取图集，请稍后再试。' }, 503);
    }
  },
};
