import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run, writeJSON, fingerprint } from './io.mjs';

export const CREATOR_UID = 324213598;
export const BVID = /^BV[0-9A-Za-z]{10}$/;
const marker = 'GALLERY_RESULT:';

async function execute(source, options = {}) {
  const output = await run(options.egoBin || 'ego-browser', ['nodejs', '-e', source], { signal: options.signal, timeout: 8 * 60_000, captureStderr: true });
  const result = output.split('\n').find(line => line.startsWith(marker));
  if (!result) throw new Error('Ego 未返回结构化采集回执。');
  return JSON.parse(result.slice(marker.length));
}

const contextCode = context => `
const task = await taskSpace(${JSON.stringify(context.spaceId)});
if(task.ownership!=='agent') throw new Error('浏览器控制权已改变，停止采集');
const tab=(await task.tabs()).find(t=>t.label===${JSON.stringify(context.page)});
if(!tab || tab.targetId!==${JSON.stringify(context.targetId)} || tab.url!==${JSON.stringify(context.expectedUrl)})
 throw new Error('浏览器目标或地址已改变，停止采集');
const page=task.page(${JSON.stringify(context.page)});
`;

export async function openBrowser({ runId, egoBin, signal } = {}) {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(runId || '')) throw new Error('缺少独立浏览器 runId');
  return execute(`const task=await taskSpace(${JSON.stringify('大麦逐期同步-' + runId)});
const page=task.page('p1');const tab=(await task.tabs()).find(t=>t.label==='p1');
console.log('${marker}'+JSON.stringify({spaceId:task.spaceId,page:'p1',targetId:tab.targetId,expectedUrl:tab.url,runId:${JSON.stringify(runId)}}));`, { egoBin, signal });
}

const shanghaiDay = milliseconds => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(milliseconds));

export function publicationDay(label, now = Date.now()) {
  label = label.replace(/年|月/g, '-').replace(/日$/, '');
  const today = shanghaiDay(now);
  if (/刚刚|分钟前|小时前|^今天$/.test(label)) return today;
  if (label === '昨天' || /^\d+天前$/.test(label)) {
    const days = label === '昨天' ? 1 : Number(label.match(/^\d+/)[0]);
    if (days > 31) throw new Error('投稿相对日期超出可核对范围');
    return shanghaiDay(now - days * 86400_000);
  }
  const match = label.match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new Error('无法核对投稿日期，停止查新');
  let year = Number(match[1] || today.slice(0, 4));
  const month = Number(match[2]), day = Number(match[3]);
  let value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!match[1] && value > today) value = `${--year}-${value.slice(5)}`;
  const date = new Date(value + 'T00:00:00+08:00');
  if (!Number.isFinite(date.getTime()) || shanghaiDay(date.getTime()) !== value) throw new Error('投稿日期无效');
  return value;
}

export function selectNewVideos(videos, knownBvids, knownPublications, now = Date.now()) {
  const known = new Set(knownBvids);
  const days = Object.entries(knownPublications || {}).filter(([id, v]) => known.has(id) && v && (v.publishedDate || v.publishedAt)).map(([, v]) => v.publishedDate || shanghaiDay(Date.parse(v.publishedAt)));
  if (!days.length || days.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day))) throw new Error('缺少已收录视频的发布日期边界');
  const cutoffDay = days.sort().at(-1);
  const dated = videos.map(v => ({ ...v, publishedDay: publicationDay(v.dateLabel, now) }));
  return { videos: dated.filter(v => !known.has(v.bvid) && v.publishedDay >= cutoffDay), cutoffDay,
    knownBoundaryFound: dated.some(v => known.has(v.bvid) && v.publishedDay <= cutoffDay) };
}

export async function discoverLatest(context, { knownBvids = [], knownPublications, now = Date.now(), ...options } = {}) {
  const url = `https://space.bilibili.com/${CREATOR_UID}/upload/video`;
  const result = await execute(contextCode(context) + `
await page.goto(${JSON.stringify(url)});
await page.waitForFunction(()=>document.querySelectorAll('.upload-video-card .bili-video-card__title a[href*="/video/BV"]').length>0,undefined,{timeout:30000});
if(await page.url()!==${JSON.stringify(url)}) throw new Error('作者列表地址变化');
const videos=await page.evaluate(()=>{
 const seen=new Set(), out=[];
 for(const a of document.querySelectorAll('.upload-video-card .bili-video-card__title a[href*="/video/BV"]')){
  const match=a.href.match(/\\/video\\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/);
  const title=(a.getAttribute('title')||a.textContent||'').trim();
  if(!match || !title || a.querySelector('img') || /^\\d[\\d\\s:.万亿]*$/.test(title)||seen.has(match[1]))continue;
  const dateLabel=a.closest('.bili-video-card__details')?.querySelector('.bili-video-card__subtitle')?.textContent.trim();
  if(!dateLabel)throw new Error('投稿日期缺失');
  seen.add(match[1]);out.push({bvid:match[1],title,dateLabel,source:'https://www.bilibili.com/video/'+match[1]+'/'});
 }return out;
});
if(!videos.length)throw new Error('当前作者列表没有可核对的视频标题');
console.log('${marker}'+JSON.stringify({videos,observed:videos.length,scope:'当前最新投稿页',context:{...${JSON.stringify(context)},expectedUrl:${JSON.stringify(url)}}}));`, options);
  return { ...result, ...selectNewVideos(result.videos, knownBvids, knownPublications, now) };
}

export async function acquireEpisode(context, bvid, outDir, options = {}) {
  if (!BVID.test(bvid)) throw new Error('无效 BV 号');
  await mkdir(outDir, { recursive: true });
  const canonical = `https://www.bilibili.com/video/${bvid}/`;
  const prior = new URL(context.expectedUrl);
  const observedSource = context.bilibiliSource || (prior.hostname === 'www.bilibili.com' ? prior.searchParams.get('vd_source') : null);
  // Carry only a previously observed tracking value through our own navigation.
  // Bilibili can otherwise append it late, correctly tripping URL isolation.
  const url = canonical + (typeof observedSource === 'string' && /^[a-f0-9]{32}$/.test(observedSource) ? '?vd_source=' + observedSource : '');
  const capture = options.happyCapture ? `
const cdp=(m,p)=>page.cdp(m,p),pageInfo=()=>page.evaluate(()=>({url:location.href,w:innerWidth,h:innerHeight}));
const currentTab=async()=>(await task.tabs()).find(t=>t.label===${JSON.stringify(context.page)});
const useOrCreateTaskSpace=async id=>({id:(await taskSpace(id)).spaceId});
const {captureVerifiedBrowserStep}=await import(${JSON.stringify('file://' + options.happyCapture.helperPath)});
const frame=await captureVerifiedBrowserStep({cdp,pageInfo,currentTab,listTaskSpaces,useOrCreateTaskSpace},expected,${JSON.stringify({ sessionId: options.happyCapture.sessionId, runId: context.runId, skillName: 'ego-browser', taskSpaceId: context.spaceId, targetId: context.targetId })});
browserStep={path:frame.path,label:'核对并采集新一期 '+${JSON.stringify(bvid)},runId:${JSON.stringify(context.runId)},skillName:'ego-browser'};
` : '';
  const result = await execute(contextCode(context) + `
await page.goto(${JSON.stringify(url)});
await page.waitForFunction(()=>window.__INITIAL_STATE__?.videoData && window.__playinfo__?.data?.dash && document.querySelector('video')?.readyState>=2,undefined,{timeout:45000});
const expected=await page.url();const actual=new URL(expected),canonical=new URL(${JSON.stringify(canonical)});
if(actual.origin!==canonical.origin||actual.pathname!==canonical.pathname||[...actual.searchParams.keys()].some(k=>k!=='vd_source'))throw new Error('作品地址或分P变化');
const selected=await page.evaluate(({bvid,uid})=>{
 const s=window.__INITIAL_STATE__,d=s.videoData,p=window.__playinfo__.data;
 if(d.bvid!==bvid||d.owner.mid!==uid||s.p!==1||d.pages.length!==1)throw new Error('作品身份不匹配或多P尚未支持');
 for(const v of document.querySelectorAll('video')){v.pause();v.autoplay=false;}
 const resources=performance.getEntriesByType('resource').filter(e=>/\\.m4s(?:\\?|$)/.test(e.name));
 const key=u=>{const q=new URL(u);return q.hostname+q.pathname;};
 const choose=list=>{
  const candidates=list.map(x=>({x,urls:[x.baseUrl,x.base_url,...(x.backupUrl||x.backup_url||[])].filter(Boolean)}))
   .map(o=>({...o,loaded:resources.filter(e=>o.urls.some(u=>key(u)===key(e.name)))})).filter(o=>o.loaded.length);
  if(candidates.length!==1)throw new Error('播放器实际媒体候选不唯一');
  const {x,loaded,urls}=candidates[0];return {urls:[...new Set([...loaded.toReversed().map(e=>e.name),...urls])].slice(0,4),id:x.id,codecs:x.codecs,width:x.width,height:x.height};
 };
 const audio=choose(p.dash.audio),video=choose(p.dash.video);
 return {metadata:{bvid,title:d.title,author:d.owner.name,uid:d.owner.mid,cid:d.cid,page:1,source:'https://www.bilibili.com/video/'+bvid+'/',publishedAt:new Date(d.pubdate*1000).toISOString(),duration:d.duration,mediaDuration:p.timelength/1000,width:video.width,height:video.height,acquiredAt:new Date().toISOString()},audio,video};
},${JSON.stringify({ bvid, uid: CREATOR_UID })});
const fs=await import('node:fs/promises');
const verifiedContext={...${JSON.stringify(context)},expectedUrl:expected,...(actual.searchParams.has('vd_source')?{bilibiliSource:actual.searchParams.get('vd_source')}:{})};
await fs.writeFile(${JSON.stringify(join(outDir, 'browser-context.json'))},JSON.stringify(verifiedContext)+'\\n',{mode:0o600});
const fetchReceipt={};
for(const type of ['audio','video']){
 let complete=false,attempts=0;
 for(const url of selected[type].urls){
  attempts++;
  try{const response=await page.fetch(url,{saveAs:${JSON.stringify(outDir)}+'/'+type+'.m4s',timeout:180000});complete=response.ok;}catch{/* Only try another address of this same verified player track. */}
  if(await page.url()!==expected)throw new Error('下载期间作品发生变化');
  if(complete)break;
 }
 if(!complete)throw new Error(type+'媒体读取失败；本次播放器提供的地址均未完成');
 fetchReceipt[type]={id:selected[type].id,codecs:selected[type].codecs,attempts};
}
await fs.writeFile(${JSON.stringify(join(outDir, 'media-fetch.json'))},JSON.stringify(fetchReceipt)+'\\n',{flag:'wx',mode:0o600});
await fs.writeFile(${JSON.stringify(join(outDir, 'metadata.json'))},JSON.stringify(selected.metadata,null,2)+'\\n',{flag:'wx',mode:0o600});
let browserStep;${capture}
console.log('${marker}'+JSON.stringify({metadata:selected.metadata,context:verifiedContext,browserStep}));`, options);
  const files = {};
  for (const name of ['metadata.json', 'audio.m4s', 'video.m4s']) files[name] = await fingerprint(join(outDir, name));
  await writeJSON(join(outDir, 'acquisition.json'), { schemaVersion: 1, context: result.context, files });
  return result;
}

export async function finishBrowser(context, options = {}) {
  return execute(contextCode(context) + `await task.finish({keep:[]});console.log('${marker}'+JSON.stringify({finished:true}));`, options);
}
