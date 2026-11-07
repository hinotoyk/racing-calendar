# racing-calendar

JBIS（jbis.or.jp）**出走表**（出馬表）采集与检索：按 **中央 / 地方、竞马场、父、父父、母父、比赛格** 组合筛选、分组、导出 CSV，并按 ISO 周生成固定 Excel。

纯 Node.js（零依赖，内置 `fetch`），数据以 JSON 文件存于 `data/`，构建为静态站点可部署 GitHub Pages。

- **设计文档**：[docs/DESIGN.md](docs/DESIGN.md)（URL 结构、数据契约、比赛格归一、采集与导出）
- **采集链路全景**：[docs/pipeline.html](docs/pipeline.html)（各源抓取步骤、彩衣/马名富化、缓存与幂等、CI 调度、回填脚本族）
- **数据**：`data/races/{日期}/{场}.json`（每日 × 场一张出走表）+ `data/races/manifest.json`
- **血统缓存**：`data/pedigree/`（父→父父、马→全血统、名字→JBIS id 解析；入库供 CI 增量复用）

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
- 场地：全部 / JRA·中央 / NAR·地方 / 海外国家组码（GB、IRE、FR、USA…动态来自数据源；日本源按场馆名单判 JRA/NAR，海外按 SL country.short_name 归并国家组），分「中央·地方 ｜ 海外」三段陈列，**默认 JRA；所选日期无中央出走表时自动改为 NAR**
- 竞马场 chips 按 **中央 / 地方 / 海外** 分组，且只列当前场地选择下存在的场：选 JRA 只出中央 10 场、选 NAR 只出地方 15 场、选 FR（或 FR+GB、多国）只出对应国家的场（多国时一国一组「海外 FR」）；场地=全部 才三组全列（无数据置灰并显示 0）
- 级别 13 桶（半角标签对齐 yunji-web）：G1-3 / Jpn1-3 / JG1-3 / OP / L / 地方重赏（JBIS 重賞·準重賞）/ 普通比赛（新馬·未勝利·1-3勝·地方班级·Class 等；数据键为「无级别」）
- 表格列：当地比赛时间（场馆R + 日付 + 当地発走）/ 北京时间（由带时区绝对时刻换算）/ 比赛名+级别徽章 / 距离（草1400）/ 枠 / 番 / 馬名 / 性齢 / 斤量 / 騎手 / 調教師 / 父 / 父父 / 母 / 母父；行序 = 北京时间全局升序（早的在最上，跨日期交叉排）
- 父 / 父父 / 母父 下拉（按入头数排序）
- 血统快捷标签：点标签 → 对应下拉自动选中（父默认 コントレイル / キズナ / シルバーステート / リアルスティール，父父·母父默认 ディープインパクト）；「＋当前」存标签、✕ 移除、可恢复默认，存 localStorage（`rc.ped.tags.v1`，保存过以本地为准）
- 关键字（馬名 / 騎手 / 生産牧場 / 調教師 / 馬主 / レース名）
- 分组：按父 / 父父 / 母父 / 騎手 / 調教師（与血统下拉同款搜索下拉，空 = 不分组；组头显示头数与场次）
- 导出 CSV（含北京时间、时区、级别、原始比赛格、源）、每周 Excel 下载
- 出馬表分享卡双版式（勾选比赛 → 生成分享图）：**紧凑表**（默认；日期/北京时间/场地/场次/比赛名/赛道为合并单元格的连续大表，行高 24px，1080 宽幅，枠色片·性别·赛道配色锚点）/ **分卡**（每场一块；2026-11-07 定稿=**两行左对齐块头**：`岐阜金賞 [地方重賞]` / `笠松11R ダ1900 · 北京 10-22 14:50`（行1 只有比赛名+徽章，行2 = 场次 + 赛道（不带 m）+ 当地（可选）+ 北京时刻（带日期）；块内全部齐左），名字 17/700、时刻收到 meta 层、头底 hairline 分层；枠番列单色块内写馬番，与紧凑表同款）；版式·列·时间列（北京/当地）选择存 localStorage（`rc.share.layout.v1` 等）

### 嵌入引用（`embed/entries-table.js` 组件）

本站向种马档案站（yunji-web / kzn-web 等）提供**纯渲染组件**——宿主一行挂载，得到「某種牡馬产驹近期出走」的简洁结果视图（对齐 jbis-sire-rank-history `embed/sire-rank-chart.js` 的兄弟站统一引用模式）：

```html
<div id="entries"></div>
<script src="https://hinotoyk.github.io/racing-calendar/embed/entries-table.js"></script>
<script>
  RC_ENTRIES_EMBED.mount(document.getElementById("entries"), {
    base: "https://hinotoyk.github.io/racing-calendar/",
    sire: "コントレイル",   // 種牡馬日文名（JBIS 原形）；days 可控制未来侧日期数（默认 4）
  });
</script>
```

视图（v2.3.0，2026-11-07 定稿：**PC / MB 双形态 + 三档宽度自适应 + 全部/JRA·中央/NAR·地方/海外 分类 chips**：<720 卡片 / 720–1179 九列 / ≥1180 加母父 / ≥1500 再加調教師，字号与行距按 `clamp(1, 宽/1000, 1.3)` 同步放大；分类 chips 纯前端过滤、不写存储）= 头部（标题 + 共 N 頭 · M R + 本站外链）+ 按**组件自身宽度**（720px）切换的两种渲染：**PC = 分享卡「紧凑一览」同源的九列密表**（一整张连续 `<table>`，比赛级信息按 rowspan 合并成 北京时间 / 场次 / 比赛名+级别徽章 / 赛道，逐马一行：枠番色块（块内写馬番）/ 馬名 / 性齢 / 斤量 / 騎手；日期 = 跨列行「11月7日（土）」+ 青绿短竖条）；**MB = 逐场卡片**（一场一块：条头 场次 + 北京时间 → 比赛名 + 赛道 → 产驹每人两行「枠番 馬名 性齢 斤量」/「騎手 母父」）。视觉照搬 `share.js::drawDense` 的冷灰网格（表头浅灰 + 明细线 `#f0f2f4` + 结构竖线 + 极浅斑马，**无外框无圆角**——宿主卡片本身就是容器）；行高 ~30px / 正文 12.5px 比 1080 画布的分享卡（24px / 11.5px）松一档，适配兄弟站 90% 宽页面。赛事名显示层清洗（去「サラ系」前缀、去场次号、超长欧美冠名只留类型短语）；最近一周自动折叠；空态/加载/失败态内建；窄屏按组件自身宽度分两档收起次要列（ResizeObserver，不用 @media）；颜色走宿主 CSS 变量自动跟随换肤。组件自带数据编排（fetch `derived/` 产物并解包字典包），不写任何存储键。协议细节见 [docs/DESIGN.md](docs/DESIGN.md) §10；主站完整页 iframe 嵌入（`?embed=1`）作为附录保留，一般不用。

## 每周 Excel

`_site/excel/races-{ISO周}.xlsx`，4 个 sheet：

| sheet | 内容 |
|---|---|
| 出走馬 | 30 列：日付 / 区分 / 場 / R / レース名 / 比赛格 / 芝ダ / 距離 / 枠 / 馬番 / 馬名 / 性齢 / 父 / 父父 / 母 / 母父 / 騎手 / 調教師 / 生産牧場 / 前走×3 … |
| 父集計 | 父马 × 出走頭数 / レース数 / 中央 / 地方 |
| 父父集計 | 父父 × 同上 |
| 母父集計 | 母父 × 同上 |

## 部署与自动运行（GitHub Pages）

站点为纯静态零依赖：`_site/` 即完整产物（全相对路径 + `.nojekyll`），任意 base path 可用。参照 yunji-web 的 workflow 模式（[.github/workflows/](.github/workflows)，现为 3 条）：

- **deploy.yml** — push main（人工推代码）→ `node src/build.js` → 发布 `_site/` 到 Pages
- **update-data.yml（全量档）** — 每天 **UTC 18:00 = 北京 02:00**：JBIS 出馬表（今天起 3 天）+ Racing Post（`--countries all` 全国家，美国等夜间卡唯一窗口）→ 构建 → 有变化则 commit `data/races/` + `data/pedigree/` + `data/silks/` 回 main → **同一 workflow 内重新部署静态页面**
- **update-jbis.yml（补采档）** — 每天 **UTC 04:00 = 北京 12:00**：仅 JBIS 出馬表（当天日本场次枠順/馬番確定后的补采），不跑 RP；其余链路同上

两档已**拆成独立 workflow**：各自独立调度、独立 run 历史、各自可手动 `workflow_dispatch` 触发，共用 `concurrency: group: pages` 串行发布。GitHub 规定 `GITHUB_TOKEN` 的 push 不触发其它 workflow，故部署不能依赖 `deploy.yml` 被 push 触发，由两条 update workflow 在提交后直接 build + 发布 Pages。`update-full-log-<run_id>` / `update-jbis-log-<run_id>` artifact 保留 **30 天**，内含 `test-logs/*.log`、诊断摘要与逐条 `requests-*.jsonl`

前置设置（一次性）：

1. Settings → Pages → Source 选 **GitHub Actions**
2. Settings → Actions → General → Workflow permissions 勾选 **Read and write permissions**（update-data 需要写入仓库）
3. 定时任务说明：cron 按 **UTC** 填写（北京 = UTC+8）；cron 在高峰期可能延迟数分钟到数小时，整点档尤其明显（2026-11 实测曾整体后移 4–8 小时）；定时 workflow 只在默认分支（main）生效；私有仓库连续 60 天无活动会被暂停、且每分钟计费（每日 2 档合计约 40–75 分钟 ≈ 1,200–2,250 分钟/月，免费额度 2,000 分钟；公开仓库不计费）

数据落库范围：`data/races/`（源文档 `.json.gz`）+ `data/pedigree/`（血统/马名/彩衣缓存**单文件包**，`jbis-sire.json` / `jbis-horse.json` / `rp-horse.json` / `name-lookup.json` / `jbis-name.json` / `nk-*.json` / `wf-*.json` / `sl-silk.json`，文件数恒定、体积线性增长）+ `data/silks/`（按马主去重的彩衣图，必须入库，否则下次 checkout 会因缓存命中而永久缺图）——CI 每次运行增量复用缓存，不为已抓过的马重复请求上游。`.gitattributes` 将 `.gz` / `.gif` / `.png` 声明为二进制，避免行尾转换损坏快照。

## 马名归一（canonical 合并）

同一匹马在不同源写法不同（JBIS「Saxon Warrior(JPN)」/ RP「Saxon Warrior」、JBIS「ディープインパクト」/ RP「Deep Impact」），站点按 **canonical（JBIS id）合并**：

- 父 / 父父 / 母父下拉、分组、筛选按 canonical 聚合，展示名取行内最多写法，表格/CSV 保留原形
- 下拉搜索同时匹配全部别名（「deep impact」能搜到 ディープインパクト）
- 归一规则与别名数据见 `src/lib/horse-name.mjs`；构建产物 `derived/horse-aliases.json`
- 别名来源：JBIS 马页官方英文名（`nameEn`）+ JBIS 馬検索名字解析（`name-lookup.json`，消歧规则：名字精确匹配 +「種」标签 + 生年上下限，同名老马排除；同名异马冲突时现役种公马优先）

RP 源的父父（SL 档案父系 id 缺陷无法链查）同样借道 JBIS 馬検索补全；一次性回填用 `node src/backfill-lookup.js`（已缓存的自动跳过）。

## 马名权威化 / 彩衣 / 请求日志（2026-11-04）

### 马名：只认 JBIS id，登录名从马页读
出馬表里的马名是显示名，带装备标记「 B」（ブリンカー，190 例）与国名括注「(USA)」（141 例），按正则剥尾缀会误伤纯 ASCII 名。改为：拿到 10 位 JBIS id 后读 `/horse/{id}/`，一次取四样东西并缓存 `data/pedigree/jbis-name.json`（key=id）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `jp` | `hdg1-search h1` | 日文登录名；纯英文名马匹为 null |
| `en` | `hdg1-search__sub` | 英文名（去掉国籍括注），如 `Air Gene` |
| `country` | 同上括注 | `JPN` / `USA` / `GB` / `IRE` … |
| `foaled` | `生年月日` | 精确到日，彩衣唯一性判定基准 |

回写 runner：`horse.name`（日文名，无则英文名）、`horse.nameJp`、`horse.nameEn`、`horse.country`、`horse.foaled`。

```bash
node src/collect-races.js                       # 日常采集：出馬表后自动补马名（默认 1 并发 / 3.5s）
node src/backfill-names.js                      # 全量回填（新日期优先，缓存幂等，可随时中断重跑）
node src/backfill-names.js --dates 2026-11-04 --tracks 236 --limit-docs 1   # 小批量
```

> JBIS 马页有 WAF 限流：短时高频会整站返回 403（持续数分钟到数十分钟）。抓取层按「近浏览器请求头 + 单并发 + 3.5s」执行，403 不写缓存、暂停时长指数增长，连续 3 次则停批（缓存已落盘，重跑续采）。

### 彩衣：netkeiba 优先 → winfinal 兜底
- 日本源：`马名 + 生年` 先查 netkeiba（马名搜索 → 马主 id → `cdnv2.netkeiba.com/img/db/colours/{id}.png|gif` 直构）；未命中再查 `fuku.winfinal.com`（`?action=horse_name&q=` 完全一致検索，结果卡含生年月日与馬主名，唯一命中才采用）。图落 `data/silks/{ownerId}.{gif|png}` 与 `data/silks/wf-{xxxx}.gif`。
- 欧美源：Sporting Life racecard 的 `__NEXT_DATA__` 每个 ride 自带 `silk_filename`，直链 `https://www.sportinglife.com/images/silks/{filename}` 下载，按内容 sha1 去重落 `data/silks/sl-{hash}.png`。
- 回填：`node src/backfill-silks-v4.js [--dates ...] [--tracks ...] [--delay 1200]`（缓存 `nk-map` / `nk-owner-v3` / `wf-horse` / `wf-owner` / `sl-silk` 入库，重跑 0 请求）。
- 展示：出馬表 `silk` 列（默认隐藏，列菜单可开）、分享卡分卡版式彩衣列；欧美与日本同一 `silk.url` 口径。

### 请求日志
所有出站请求（JBIS / netkeiba / winfinal / Sporting Life / 彩衣图）逐条追加 `data/logs/requests-YYYYMMDD.jsonl`（JST 日切），字段 `ts / src / method / url / status / ok / ms / bytes / err`。`appendFileSync` 逐条落盘，进程被杀/超时也不丢已发出的请求。关闭用 `RC_REQLOG=0`，改目录用 `RC_REQLOG_DIR`。

**该目录已在 `.gitignore` 中，刻意不入库**：属于「每次运行」的诊断数据（今天本地 19,807 行 / 505 MB 传输量），入库会污染每日 data commit、放大 rebase 冲突。CI 里改为 artifact 留存 + 摘要直出：

| 位置 | 内容 | 用途 |
|---|---|---|
| Actions → **Diagnostics from JSONL request log** step | 请求总量/失败率/按源 403·404·5xx、彩衣覆盖（全站 / JRA / NAR / 欧美）、马名权威化覆盖、彩衣引用缺图数、build 是否产出、判定 `OK / WARN / FAIL` | **不下载任何文件**就能判断跑挂没跑挂；异常项以 `::warning::` / `::error::` 注解显示 |
| artifact `update-full-log-<run_id>` / `update-jbis-log-<run_id>` 的 `test-logs/summary.log`、`summary.json` | 同上，机器可读版；两档 artifact 名独立 | 复盘、跨次对比 |
| artifact `data/logs/requests-*.jsonl` | 每条请求原始记录（含具体 URL 与错误） | 定位到「哪个源、哪一页、什么时候开始 403」 |
| artifact `test-logs/jbis.log` / `rp.log` / `build.log` | 采集与构建 stdout（`rp.log` 仅全量档有） | 对应脚本报错堆栈 |

本地也能复现同一份摘要：`node src/ci-summary.js [--rp] [--since-minutes 300] [--out-dir test-logs]`（全量档带 `--rp`，补采档不带）。CI 中该步骤带 `if: always()`，采集/构建失败或 step 超时（JBIS 80min / **RP 120min** 仅全量档 / build 15min；job 安全网全量 240min、补采 100min，平台上限 360min）后仍会执行；Gate 放在 artifact 上传之后，日志一定留得下来。

**分级闸门（仅全量档）**：RP step 用 `shell: bash` + `${PIPESTATUS[0]}` 抓真实退出码（避免 `| tee` 吞掉），并写 `test-logs/rp-verdict.txt`——默认 `FAIL`，只有「退出码 0 + 打印 `manifest ->` 收尾行」才覆盖为 `OK`；step 被超时 kill 时文件仍是 `FAIL`。`ci-summary.js --rp` 另把「Sporting Life 0 请求 / 0 成功」判 FATAL，成功率低于一半只判 WARN。末尾 **Gate on diagnostics** 同时读 `verdict.txt` 与 `rp-verdict.txt`，任一 `FAIL` 才 `exit 1`。因为 `Deploy to Pages` 排在 Gate 之前，**标红只报警、不拦发布**，也不会像去掉 `continue-on-error` 那样把当天 JBIS 数据一起丢掉。

## 已知限制

- 出馬表只在开赛前 1–2 日存在，赛后由结果页替换，错过窗口无法补抓当时状态。
- 枠順確定晚于出馬表，早抓的馬番可能变动；重跑按枠番/馬番指纹覆盖为最新。
- 中央出馬表模板以实测为准；采集器对 `/race/` 与 `/race/result/` 双向尝试，缺 母父 时回退马页。
- 个人研究用途，遵守 JBIS 利用規約，请求间隔 1.2s。
