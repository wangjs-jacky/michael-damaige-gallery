# Michael大麦哥 · 影像摘录

一个非官方视频字幕长图集：**121期、382张1080像素宽的原图**。保留原画面和原话，支持按视频标题、已选字幕搜索，单期长图阅读、B站原片回查、单张/单期/全部原图下载。

- 在线图集：https://michael-damaige-gallery.jacky-openbird.workers.dev
- 原作者：https://space.bilibili.com/324213598
- [全部原图 ZIP](https://jacky-bucket-hk.oss-cn-hongkong.aliyuncs.com/michael-damaige-gallery/2026-11-03/michael-damaige-121-videos-382-images.zip)
- [公开作品索引](public/catalog.json)：逐期来源、图片尺寸、字节数、SHA-256、已选字幕与原图包。

## 内容边界

历史20期116张与新增101期266张合并，每个BVID只收录一个允许版本。14期90张获整理委托者内容认可；107期292张待认可，其中2期6张是早期样例，不代表已满足当前整期覆盖标准。认可不是原作者授权，也不是事实认证。被否定的摘要版及旧替代版未收录。

未完成全片逐字音频听校，未独立核实全部科学、健康和心理学论断。图片保留作者观点及原片语境；画面与原话权利归原作者所有。本仓库不对第三方内容授予再许可。

## 本地预览与维护

需要 Node.js 22 或更高版本，以及 curl。先下载公开原图并逐张核对 SHA-256：

```bash
npm ci
npm run restore-images
npm run check
node scripts/serve.mjs
```

网络需要代理时，在当前命令环境设置 `HTTPS_PROXY` 后运行恢复命令；工具不会修改全局代理。

打开 http://127.0.0.1:8798 。只预览目录时可不下载图片；完整阅读与部署需要先恢复原图。图片较大，独立存储，不进入 Git 历史。仓库不包含视频、音频、全量转写、凭据或私有处理日志。

`public/` 是唯一部署目录；页面仅在打开时读取一次目录，交互在本机处理，无状态轮询、服务端脚本或数据库。原图保留 PNG 原字节；ZIP 使用 Store，不二次压缩图片。`scripts/zip.mjs` 提供确定性打包函数。

新增内容时更新 `public/catalog.json` 的视频与图片条目，复核来源、认可状态、图片尺寸及哈希，同时更新页面总量与日期。ZIP 上传到独立版本前缀后，更新公开下载地址及哈希。不要把私有原始记录复制到 `public/`。

## 发布

```bash
npm run check
npx wrangler deploy --dry-run
npm run deploy
```

使用自己的 Cloudflare 登录和独立 Worker 名；新账号需更新站点地址及 `scripts/restore-images.mjs` 默认来源。图片由 Workers Static Assets 分发，原图包存放 OSS 独立前缀。仅对该前缀上传的包设置对象公开读取，不修改 Bucket 整体 ACL。发布后应下载核对全部资源与ZIP，实际检查桌面/手机宽度浏览和下载；命令成功不等于验收完成。

全量 ZIP：410564239 字节，SHA-256 `9db59d384e6289975d8c82d281a18ce04b13ee5b8b939d24e748585c497a07a9`。
