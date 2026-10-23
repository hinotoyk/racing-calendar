# racing-calendar

JBIS（jbis.or.jp）**出走表**（出馬表）采集与检索：按 **中央 / 地方、竞马场、父、父父、母父、比赛格** 组合筛选、分组、导出 CSV，并按 ISO 周生成固定 Excel。

纯 Node.js（零依赖，内置 `fetch`），数据以 JSON 文件存于 `data/`，构建为静态站点可部署 GitHub Pages。

- **设计文档**：[docs/DESIGN.md](docs/DESIGN.md)（URL 结构、数据契约、比赛格归一、采集与导出）
- **数据**：`data/races/{日期}/{场}.json`（每日 × 场一张出走表）+ `data/races/manifest.json`
- **血统缓存**：`data/pedigree/`（父→父父、马→全血统；不进 git、不发布）

## 快速开始

```bash
npm start              # 采集 → 构建 → 启动 http://127.0.0.1:9090/ 并打开浏览器
npm run collect        # 仅采集（今天起 3 天）
npm run build          # 仅构建（生成 _site/，含每周 Excel）
npm run serve          # 仅启动本地服务（默认 9090；可 npm run serve -- --port 9180 --no-open）
```

按日期抓取：

```bash
node src/collect-races.js --dates 2026-10-24,2026-10-25
node src/collect-races.js --days 7 --force
node src/collect-races.js --tracks 105,231
```

多源（Racing Post 海外卡片，架构与字段映射见 [docs/DESIGN.md](docs/DESIGN.md) §8）：

```bash
npm run collect:rp                                   # 英国当日 GB+IRE 卡片（默认）
node src/collect-sources.js --source racingpost --countries all
```

> RP 源抓取层为 Racing Post 集团旗下 sportinglife.com（racingpost.com 直连有 WAF）；
> 发走时刻为英国当地时间（源口径），落盘同时标注场地时区（date 标签口径）与绝对时刻。

> 出馬表只在开赛前 1–2 日公开：地方 ≈ 前日，中央 ≈ 开赛前 2 日。窗口外的日期显示 0 头，重跑会补齐。

## 页面

单页 `index.html`（视觉规范对齐 [yunji-web](Z:\IdeaProjects\yunji-web) 方案 F：青绿 `#0aa7a0` × shadcn Neutral，筛选卡 + dense 表格 + JBIS 配色等级徽章；列基准参考其「比赛记录 · RACES」跨马表）：

- 日期标签每次加载按北京时间现算：默认窗口 = 今天±2 共 5 天（‹ › 翻页、可回「今天」），可勾选任意有数据日
- 场地：全部 / JRA / NAR / 国家组码（GB、IRE、FR、USA…动态来自数据源；日本源按场馆名单判 JRA/NAR，海外按 SL country.short_name 归并国家组），**默认 JRA；所选日期无中央出走表时自动改为 NAR**
- 竞马场 chips 常驻展示名单 17 场 + 有数据的海外场（无数据置灰并显示 0）
- 级别 13 桶（半角标签对齐 yunji-web）：G1-3 / Jpn1-3 / JG1-3 / OP / L / 地方重赏（JBIS 重賞·準重賞）/ 普通比赛（新馬·未勝利·1-3勝·地方班级·Class 等；数据键为「无级别」）
- 表格列：当地比赛时间（场馆R + 日付 + 当地発走）/ 北京时间（由带时区绝对时刻换算）/ 比赛名+级别徽章 / 距离（草1400）/ 枠 / 番 / 馬名 / 性齢 / 斤量 / 騎手 / 調教師 / 父 / 父父 / 母 / 母父
- 父 / 父父 / 母父 下拉（按入头数排序）
- 关键字（馬名 / 騎手 / 生産牧場 / 調教師 / 馬主 / レース名）
- 分组：按父 / 父父 / 母父 / 騎手 / 調教師（与血统下拉同款搜索下拉，空 = 不分组；组头显示头数与场次）
- 导出 CSV（含北京时间、时区、级别、原始比赛格、源）、每周 Excel 下载

## 每周 Excel

`_site/excel/races-{ISO周}.xlsx`，4 个 sheet：

| sheet | 内容 |
|---|---|
| 出走馬 | 30 列：日付 / 区分 / 場 / R / レース名 / 比赛格 / 芝ダ / 距離 / 枠 / 馬番 / 馬名 / 性齢 / 父 / 父父 / 母 / 母父 / 騎手 / 調教師 / 生産牧場 / 前走×3 … |
| 父集計 | 父马 × 出走頭数 / レース数 / 中央 / 地方 |
| 父父集計 | 父父 × 同上 |
| 母父集計 | 母父 × 同上 |

## 部署与自动运行（GitHub Pages）

站点为纯静态零依赖：`_site/` 即完整产物（全相对路径 + `.nojekyll`），任意 base path 可用。参照 yunji-web 的双 workflow 模式（[.github/workflows/](.github/workflows)）：

- **deploy.yml** — push main（代码变更/首次推送）→ `node src/build.js` → 发布 `_site/` 到 Pages
- **update-data.yml** — 每日一次（UTC 22:00 = **北京 06:00**，JST 07:00）采集 JBIS + Racing Post → 构建 → 有变化则 commit `data/races/` + `data/pedigree/` 回 main → **同一 workflow 内重新部署静态页面**（GitHub 规定 `GITHUB_TOKEN` 的 push 不触发其它 workflow，故不能依赖 deploy.yml 被 push 触发）；可手动触发；运行日志上传为 artifact（保留 14 天）

前置设置（一次性）：

1. Settings → Pages → Source 选 **GitHub Actions**
2. Settings → Actions → General → Workflow permissions 勾选 **Read and write permissions**（update-data 需要写入仓库）
3. 定时任务说明：cron 在高峰期可能延迟数分钟到数十分钟；定时 workflow 只在默认分支（main）生效；私有仓库连续 60 天无活动会被暂停、且每分钟计费（每日 1 次 × ~20 分钟 ≈ 600 分钟/月，免费额度 2,000 分钟；公开仓库不计费）

数据落库范围：`data/races/`（源文档 `.json.gz`）+ `data/pedigree/`（血统缓存**单文件包** `jbis-sire.json` / `jbis-horse.json` / `rp-horse.json`，文件数恒定、体积线性增长）——CI 每次运行增量复用缓存，不为已抓过的马重复请求上游。

## 已知限制

- 出馬表只在开赛前 1–2 日存在，赛后由结果页替换，错过窗口无法补抓当时状态。
- 枠順確定晚于出馬表，早抓的馬番可能变动；重跑按枠番/馬番指纹覆盖为最新。
- 中央出馬表模板以实测为准；采集器对 `/race/` 与 `/race/result/` 双向尝试，缺 母父 时回退马页。
- 个人研究用途，遵守 JBIS 利用規約，请求间隔 1.2s。
