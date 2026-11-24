<p align="center">
  <img src="docs/readme/hero.png" width="100%" alt="大麦哥 · 话留在画面里：Michael大麦哥视频字幕长图集，把值得重读的画面与原话留下来">
</p>

# Michael大麦哥 · 影像摘录

**话，留在画面里。**

把 [Michael大麦哥](https://space.bilibili.com/324213598) 的视频画面与原话字幕整理成一张张可直接翻看、收藏与分享的纵向长图卡片——搜一句话，就能回到说话的那一刻。

[在线浏览图集 ↗](https://damaige.paws.rodeo/) · [下载全部原图](https://jacky-bucket-hk.oss-cn-hongkong.aliyuncs.com/michael-damaige-gallery/2026-11-03/michael-damaige-121-videos-382-images.zip) · [去 B 站关注原作者 ↗](https://space.bilibili.com/324213598)

## 动机

我很喜欢 Michael大麦哥。他的声音很沉静，聊的都是生活、焦虑、自我接纳、亲密关系和如何成为自己——没有居高临下的说教，却常常在很平常的一句话里让人松一口气。

做这个图集的起因其实很简单：有段时间我自己心情比较低落，听他的视频会觉得心里安定很多。但看视频本身是一件节奏偏慢的事，想重温某一段打动过自己的话，往往要在几十分钟的进度条里来回翻找。

于是便有了把**视频直接变成「画面 + 字幕」长图卡片**的想法：

- **读得更快**：几秒就能扫完一期核心观点，随时翻出来给自己充个电；
- **留得住语境**：连同说话时的神情和氛围一起留下来，比纯文字摘抄更有温度；
- **方便分享**：遇到共鸣的句子，保存一张长图就能直接发到社媒或转给身边的朋友。

## 浏览与阅读

<p align="center">
  <img src="docs/readme/showcase.png" width="100%" alt="大麦哥图集界面与长图阅读展示：左侧为 damaige.paws.rodeo 真实作品墙与搜索筛选界面，右侧为 1080px 字幕长图样张">
</p>

| 体验 | 说明 |
|---|---|
| **一句话搜全库** | 输入标题、年份或字幕里的任意关键词，立刻定位到那一期 |
| **原画面纵向卡片** | 完整保留原片画面与原话字幕，适合手机和电脑快速翻阅或社媒分享 |
| **一键回看原片** | 每张卡片均附带原片时间点，随时跳回 B 站看完整上下文 |
| **随手保存原图** | 支持单张保存、按期下载，或一次性打包收藏全部长图 |

## 版权与说明

- 本站点为个人整理的影像阅读集，**所有视频画面与原话权利均归原作者 [Michael大麦哥](https://space.bilibili.com/324213598) 所有**；欢迎去 B 站关注支持原片。
- 字幕内容由视频整理而来，部分观点请结合 B 站原片上下文阅读。

<details>
<summary>本地运行与仓库维护</summary>

需要 Node.js 22+ 与 `curl`，恢复公开原图后即可本地启动预览（原图独立托管，不进入 Git 历史）：

```bash
npm ci && npm run restore-images && node scripts/serve.mjs
```

更多目录索引与素材记录见 [`public/catalog.json`](public/catalog.json) 与 [docs/readme/SOURCES.md](docs/readme/SOURCES.md)。

</details>
