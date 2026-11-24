# README 素材与核验记录

## 视觉方向

沿用线上站点 [damaige.paws.rodeo](https://damaige.paws.rodeo/) 的暖深炭黑网格画廊 + 暖琥珀金 + 宋体大标题视觉语言，形成「深色影院 Hero 首屏 → 暖纸色作品墙与阅读样张展示」的明暗节奏，并融入站点既有品牌角色插画与整理者个人角色印记。

## 文件清单

| 文件 | 尺寸 | 用途与来源 |
|---|---|---|
| [hero.png](hero.png) | 1600 × 920 | 首屏主视觉：融合线上 `creator-reading.webp` 品牌角色、3 张来自已认可期数的真实 `1080px` 字幕长图（`BV1LwhB65E8e`、`BV1k2dhYMEEX`、`BV1SiBFBGEuG`）与整理者个人形象角标 |
| [showcase.png](showcase.png) | 1600 × 940 | 体验展示大图：融合线上 `creator-search.webp` 品牌角色、真实线上首页 `damaige.paws.rodeo` 桌面端 2× 截图，以及 2 张已认可期数的真实 `1080px` 长图样张（`BV1br7V6eEoL`、`BV1NbEr6gEB1`） |

## 核验说明

- 所有长图样张均选自 `public/catalog.json` 中 `approval: "approved"` 的已认可期数，未修改原画面或原话内容。
- 两张合成大图均经本地 Chrome 无头浏览器按实际尺寸渲染并人工目检，确认无文字裁切、无元素遮挡、明暗对比清晰。
- 运行 `readme-craft` 的 `audit_readme.py` 校验 `README.md` 全部相对路径、图片 alt 属性与隐私路径零泄漏。
