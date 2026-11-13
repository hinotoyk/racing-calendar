# racing-calendar

JBIS（jbis.or.jp）**出走表**（出馬表）采集与检索：按 **中央 / 地方、竞马场、父、父父、母父、比赛格** 组合筛选、分组、导出 CSV，并按 ISO 周生成固定 Excel。

纯 Node.js（零依赖，内置 `fetch`），数据以 JSON 文件存于 `data/`，构建为静态站点可部署 GitHub Pages。

- **设计文档**：[docs/DESIGN.md](docs/DESIGN.md)（URL 结构、数据契约、比赛格归一、采集与导出）
- **表头字段对照**：[docs/FIELDS.md](docs/FIELDS.md)（每个视图的显示文案 ↔ 数据字段 ↔ JBIS 原名，统一译名改这里）
- **采集链路全景**：[docs/pipeline.html](docs/pipeline.html)（各源抓取步骤、彩衣/马名富化、缓存与幂等、CI 调度、回填脚本族）
- **数据**：`data/races/{日期}/{场}.json`（每日 × 场一张出走表）+ `data/races/manifest.json`
- **血统缓存**：`data/pedigree/`（父→父父、马→全血统、名字→JBIS id 解析；入库供 CI 增量复用）

## 快速开始

```bash
npm start              # 采集 → 构建 → 启动 http://127.0.0.1:9093/ 并打开浏览器
npm run collect        # 仅采集出走表（今天起 3 天）
npm run collect:results # 仅采集着顺（默认回看 2 天，见下）
npm run build          # 仅构建（生成 _site/，含每周 Excel）
npm run serve          # 仅启动本地服务（端口固定 9093；--no-open 不弹浏览器）
npm test               # 采集覆盖保护 / manifest schema 回归测试（零依赖、纯逻辑、不联网）
```

> 端口 / 服务根 / 绑址单源 = 项目根 **`serve.config.json`**（本站 9093）。四兄弟站约定
> yunji-web 9090 / kzn-web 9091 / jbis-sire-rank-history 9092 / 本站 9093。端口被占用时**直接报错退出，
> 不自动顺延**，也不再支持 `--port` 临时改口——宿主站云迹 `entries.html` 把本站端口写死成 9093，
> 改端口必须两边同步。

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

## 着顺（结果）层

赛后从 netkeiba 补齐着顺与最终人气，落 `data/results/{日期}/{场}.json`（`jbis.race.result/v1`）；构建时按 `raceKey|马号` 合并进 `derived/{日期}.json`，主表新增「着顺」「最终人气」两列（1 着 / 1 番人气高亮）、Excel 同步带列，另导出 `derived/results-{日期}.json` 与 `index.json::resultDates`。设计详见 [docs/DESIGN.md](docs/DESIGN.md) §11，实测过程见 `docs/RESULTS.md`（本地文件，未入库）。

```bash
npm run collect:results                               # 默认回看 2 天（--days 2）
node src/collect-results.js --dates 2026-11-08        # 指定日期
node src/collect-results.js --dates 2026-11-08 --tracks 210 --limit 3 --dry
node src/collect-results.js --days 2 --no-shutuba     # 跳过出馬表关联，只抓结果页
```

- **关联两级**：场次级用 `db.netkeiba.com/race/list/{yyyymmdd}/` 枚举口（1 请求/天）按「场码 + R」对齐，地方可 0 请求直接构造 `race_id`；马级用赛前出馬表（NAR `nar.*/shutuba.html`、JRA `race.*/shutuba.html`）按归一马名取 `nkId`，结果页再按「马号 + nkId」写回具体马。
- **赛前建的 `race_id` 赛后直接复用**：同一 id 贯穿出馬表与结果页，不需重新锚定；不要用单匹马反查场次（当天马页成绩未回填）。
- **触发不依赖 JBIS `status=result`**（中央源侧滞后约一周），改按 `startTime` 判是否已开赛。空态分四类：`ok / soft（结果未生成）/ noid（无 race_id）/ error`。
- **中央 JRA 当天也有结果**：`/race/list/{date}/` 当天较晚才列中央 race_id，但 `race.netkeiba.com/race/result.html?race_id=...` 赛后即有全序。为不依赖枚举口时机，采集器从 JBIS 当日页页眉解析「N回 場 M日」直接构造中央 id（`YYYY + 场码 + 回 + 日 + R`，场码 = JBIS 码 − 100，如 11-08 東京 5回2日 → `202605050201`）；结果页优先 `race.*`（`All_Result_Table`），无结果表时回退 `db.*`（25 列 `race_table_01`）。两套模板统一按表头名解析。
- 部分网络环境需代理：`RC_NK_PROXY=http://127.0.0.1:10809 npm run collect:results`（Node 22 内置环境代理，零依赖）。CI 对应仓库 secret `RC_NK_PROXY`，该 step 失败只告警不拦发布。

### 赛后增量采集与完整性校验

定时调度在 **GitHub Actions**：`.github/workflows/results-intraday.yml`，cron `0 0-12 * * *`（UTC = **北京时间 08:00–20:00 每 1 小时整点**），另支持 `workflow_dispatch` 手动触发。每轮跑 `node src/collect-results.js --days 1 --settle-min 10 --delay 1200`，处理 **JST 今天 + 昨天**、开赛满 10 分钟、且着顺/人气尚未完整入库的场次；已完整入库的幂等跳过。
> 步骤：采集（含本地完整性校验）→ `node src/verify-results.js` 全库体检 → 有新结果才 build / 提交 `data/results/` / 发布 Pages；共用 `concurrency: group: pages` 与其它档串行。GitHub cron 实际触发可能有排队延迟，脚本按开赛时间判定，迟到或重复触发由幂等兜住。

```bash
node src/collect-results.js --today --dry --settle-min 10   # 手动试跑，不写盘
```

- **完整性校验**（`src/lib/result-completeness.js`，纯本地逻辑）：只放出前三名（结果行数远少于出馬表头数）、名次缺号、数字名次行的人气覆盖率低于 80% → 判 `partial`，**不入库**，下一轮自动重抓；已落盘缓存也要通过同一校验才算幂等命中，能自动修复历史上的半截结果。
- **异常态与同着**：`中 / 失 / 落 / 除 / 取 / 止 / 未` 是合法着顺（主表显示中文全称 + hover 说明与判定依据，见 `docs/FIELDS.md §3.5`），单独计数、不要求人气；并列第 N 着 c 匹时下一着顺应为 N+c（同着跳号合法），校验用「名次游标」判定缺号，避免把同着误报成半截结果。
- **全库体检**：`node src/verify-results.js`（`--strict` 时退出码 1）扫描 `data/results/` 用同一规则复核，CI 每轮也会跑一次。
- 每条入库记录带 `completeness`（heads / rows / numeric / abnormal / maxRank / missingRanks / popRatio），便于排查。
- 定时任务只更新本地 `data/results/` 与本地预览；线上 Pages 由 `update-data.yml` 更新。

### 欧美源结果（Sporting Life）

`npm run collect:results:rp`（`src/collect-results-rp.js`）：**日级枚举 → 单场全序 → 人气换算 → 落 `data/results/{date}/rp-{trackId}.json` → 前端「着顺 / 最终人气」两列自动显示**。`build.js` 按 `raceKey|num` 合并，RP 的 raceKey 就是 SL race id，无需改动。

```bash
node src/collect-results-rp.js --dates 2026-11-08 --tracks 176 --limit 3 --dry
node src/collect-results-rp.js --today --no-index   # 更省：跳过日级列表，纯本地卡片驱动
```

- **链路比日本源短**：结果页 `rides[]` 自带 `cloth_number + finish_position + betting.current_odds` —— ① 不需要额外抓出馬表做马级关联（**每场 1 请求**，日本源 2 请求）；② 无需构造 race_id / 解析「回·日」/ 双模板 / EUC-JP / 代理；③ `__NEXT_DATA__` 直接 JSON 解析。日级列表 1 请求/天给出全部已完赛场次与 course slug。
- **人气换算**：英式分数赔率（`10/3`）转小数排序得 `1..N` 人气，同赔率并列并跳号（与日本源同着游标一致）；`favourite` 标记作交叉校验。中国香港沙田等 `No Forecast Available.` 场次无赔率 → 人气留空，但着顺照常入库。
- **异常态精确分类**：`NONRUNNER→除外`；`casualty.reason` → `PulledUp 中止 / Disqualified 失格 / Fell·UnseatedRider 落马 / Refused 拒跳`；无 reason 时用 `ride_description` 关键词（`Withdrawn 取消`、`pulled up 中止`、`fell 落马` 等）；两者都无 → **未完赛（源站未公布原因）**，不臆断中止/失格。每条结果存 `abnormalReason`，主表徽标直接显示中文全称、hover 显示含义与依据。口径见 `src/lib/abnormal-finish.js`。`--recheck-abnormal` 可只重抓历史含异常态的场次做分类升级。SL 只有整场 `winning_time`（仅 1 着），无逐匹完走时间。
- **完整性校验**：SL 的 `WEIGHEDIN` 是终态（`finish_position=0` 是合法异常态，法国快步赛大量失格也记 0），不像 netkeiba 会先放前三名，因此**不按完赛比例**判半截结果，改用「结果表行数 vs 卡片马数」防御；复用 `checkCompleteness` 校验名次连续 / 同着跳号 / 人气覆盖，无赔率场次用 `requirePop=false` 只校验着顺。`verify-results.js` 按 `rp.race.result/v1` 自动切换口径。
- 欧美源有独立的定时档 `.github/workflows/results-intraday-rp.yml`：cron `0 0,6,12 * * *`（UTC = **北京时间 08:00 / 14:00 / 20:00 每 6 小时**），每轮跑 `node src/collect-results-rp.js --days 1 --settle-min 10 --delay 1200`，同样抓 **JST 今天 + 昨天** 未完整入库的场次；已完整的幂等跳过，错过窗口的由滚动窗口下一轮补上。

## 页面

单页 `index.html`（视觉规范对齐 [yunji-web](Z:\IdeaProjects\yunji-web) 方案 F：青绿 `#0aa7a0` × shadcn Neutral，筛选卡 + dense 表格 + JBIS 配色等级徽章；列基准参考其「比赛记录 · RACES」跨马表）：

- 日期标签每次加载按北京时间现算：默认窗口 = 今天±2 共 5 天（‹ › 翻页、可回「今天」），可勾选任意有数据日
- 场地：全部 / JRA·中央 / NAR·地方 / 海外国家组码（GB、IRE、FR、USA…动态来自数据源；日本源按场馆名单判 JRA/NAR，海外按 SL country.short_name 归并国家组），分「中央·地方 ｜ 海外」三段陈列，**默认 JRA；所选日期无中央出走表时自动改为 NAR**
- 竞马场 chips 按 **中央 / 地方 / 海外** 分组，且只列当前场地选择下存在的场：选 JRA 只出中央 10 场、选 NAR 只出地方 15 场、选 FR（或 FR+GB、多国）只出对应国家的场（多国时一国一组「海外 FR」）；场地=全部 才三组全列（无数据置灰并显示 0）
- 级别 13 桶（半角标签对齐 yunji-web）：G1-3 / Jpn1-3 / JG1-3 / OP / L / 地方重赏（JBIS 重賞·準重賞）/ 普通比赛（新馬·未勝利·1-3勝·地方班级·Class 等；数据键为「无级别」）
- 表格列：当地时间（场馆R + 日付 + 当地発走）/ 北京时间（由带时区绝对时刻换算）/ 比赛+级别徽章 / 距离（草1400）/ 枠番 / 马号 / 马名 / 性龄 / 负重 / 骑手 / 练马师 / 父 / 祖父 / 母 / 母父；行序 = 北京时间全局升序（早的在最上，跨日期交叉排）
- 父 / 父父 / 母父 下拉（按入头数排序）
- 血统快捷标签：点标签 → 对应下拉自动选中（父默认 コントレイル / キズナ / シルバーステート / リアルスティール，父父·母父默认 ディープインパクト）；「＋当前」存标签、✕ 移除、可恢复默认，存 localStorage（`rc.ped.tags.v1`，保存过以本地为准）
- 关键字（马名 / 骑手 / 生产牧场 / 练马师 / 马主 / 比赛名）
- 分组：按父 / 祖父 / 母父 / 骑手 / 练马师（与血统下拉同款搜索下拉，空 = 不分组；组头显示头数与场次）
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

视图（v2.3.0，2026-11-07 定稿：**PC / MB 双形态 + 三档宽度自适应 + 全部/JRA·中央/NAR·地方/海外 分类 chips**：<720 卡片 / 720–1179 九列 / ≥1180 加母父 / ≥1500 再加练马师，字号与行距按 `clamp(1, 宽/1000, 1.3)` 同步放大；分类 chips 纯前端过滤、不写存储）= 头部（标题 + 共 N 頭 · M R + 本站外链）+ 按**组件自身宽度**（720px）切换的两种渲染：**PC = 分享卡「紧凑一览」同源的九列密表**（一整张连续 `<table>`，比赛级信息按 rowspan 合并成 北京时间 / 场次 / 比赛+级别徽章 / 赛道，逐马一行：马号色块（色=枠番、块内写马号）/ 马名 / 性龄 / 负重 / 骑手；日期 = 跨列行「11月7日（土）」+ 青绿短竖条）；**MB = 逐场卡片**（一场一块：条头 场次 + 北京时间 → 比赛 + 赛道 → 产驹每人两行「马号 马名 性龄 负重」/「骑手 母父」）。视觉照搬 `share.js::drawDense` 的冷灰网格（表头浅灰 + 明细线 `#f0f2f4` + 结构竖线 + 极浅斑马，**无外框无圆角**——宿主卡片本身就是容器）；行高 ~30px / 正文 12.5px 比 1080 画布的分享卡（24px / 11.5px）松一档，适配兄弟站 90% 宽页面。赛事名显示层清洗（去「サラ系」前缀、去场次号、超长欧美冠名只留类型短语）；最近一周自动折叠；空态/加载/失败态内建；窄屏按组件自身宽度分两档收起次要列（ResizeObserver，不用 @media）；颜色走宿主 CSS 变量自动跟随换肤。组件自带数据编排（fetch `derived/` 产物并解包字典包），不写任何存储键。协议细节见 [docs/DESIGN.md](docs/DESIGN.md) §10；主站完整页 iframe 嵌入（`?embed=1`）作为附录保留，一般不用。

## 每周 Excel

`_site/excel/races-{ISO周}.xlsx`，4 个 sheet：

| sheet | 内容 |
|---|---|
| 出走馬 | 30 列：日期 / 区分 / 竞马场 / R / 比赛 / 比赛条件 / 赛道 / 距离 / 枠番 / 马号 / 马名 / 性龄 / 父 / 祖父 / 母 / 母父 / 骑手 / 练马师 / 生产牧场 / 1–3前走 … |
| 父集計 | 父马 × 出走頭数 / レース数 / 中央 / 地方 |
| 父父集計 | 父父 × 同上 |
| 母父集計 | 母父 × 同上 |

## 部署与自动运行（GitHub Pages）

站点为纯静态零依赖：`_site/` 即完整产物（全相对路径 + `.nojekyll`），任意 base path 可用。参照 yunji-web 的 workflow 模式（[.github/workflows/](.github/workflows)，现为 3 条）：

- **deploy.yml** — push main（人工推代码）→ `node src/build.js` → 发布 `_site/` 到 Pages
- **update-data.yml（全量档）** — 每天 **UTC 18:00 = 北京 02:00**：JBIS 出馬表（今天起 3 天）+ Racing Post（`--countries all` 全国家，美国等夜间卡唯一窗口）→ 构建 → 有变化则 commit `data/races/` + `data/pedigree/` + `data/silks/` 回 main → **同一 workflow 内重新部署静态页面**
- **update-jbis.yml（补采档）** — 每天 **UTC 04:00 = 北京 12:00**：窗口 **今天 + 明天**，只处理「整表缺失（02:00 时出馬表还没公开）」和「缺 枠番/馬番」两类场次（`src/backfill-waku.js`）。本地能解就不发请求：已完赛场次取 `data/results` 的终态号、有馬番缺枠番按时按头数推导；仍缺才抓出馬表页（**1 场 1 请求**）。整表重建用 `data/pedigree` 缓存挂马名/血统/彩衣，**0 额外请求**。全部完整时 **0 请求 0 写盘**；**无变化不 build、不提交、不部署**（旧实现是全量重采，1000+ 请求 / 20–45 分钟）

两档已**拆成独立 workflow**：各自独立调度、独立 run 历史、各自可手动 `workflow_dispatch` 触发，共用 `concurrency: group: pages` 串行发布。GitHub 规定 `GITHUB_TOKEN` 的 push 不触发其它 workflow，故部署不能依赖 `deploy.yml` 被 push 触发，由两条 update workflow 在提交后直接 build + 发布 Pages。`update-full-log-<run_id>` / `update-jbis-log-<run_id>` artifact 保留 **30 天**，内含 `test-logs/*.log`、诊断摘要与逐条 `requests-*.jsonl`

前置设置（一次性）：

1. Settings → Pages → Source 选 **GitHub Actions**
2. Settings → Actions → General → Workflow permissions 勾选 **Read and write permissions**（update-data 需要写入仓库）
3. 定时任务说明：cron 按 **UTC** 填写（北京 = UTC+8）；cron 在高峰期可能延迟数分钟到数小时，整点档尤其明显（2026-11 实测曾整体后移 4–8 小时，甚至整天丢失）；定时 workflow 只在默认分支（main）生效；私有仓库连续 60 天无活动会被暂停、且每分钟计费（补采档轻量化后单次约 1–3 分钟，两档合计约 25–50 分钟/天 ≈ 750–1,500 分钟/月，公开仓库不计费）

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

本地也能复现同一份摘要：`node src/ci-summary.js [--rp] [--since-minutes 300] [--out-dir test-logs]`（全量档带 `--rp`，补采档不带）。CI 中该步骤带 `if: always()`，采集/构建失败或 step 超时（JBIS 80min / **RP 120min** 仅全量档 / build 15min；job 安全网全量 240min、补采 60min，平台上限 360min）后仍会执行；Gate 放在 artifact 上传之后，日志一定留得下来。补采档的 light 采集步（`backfill-waku.js`）超时 30min，且**只在 `changed>0` 时才跑 build/诊断/提交/部署**——0 变化是正常收尾，直接结束（不产生 verdict）。

**分级闸门（仅全量档）**：RP step 用 `shell: bash` + `${PIPESTATUS[0]}` 抓真实退出码（避免 `| tee` 吞掉），并写 `test-logs/rp-verdict.txt`——默认 `FAIL`，只有「退出码 0 + 打印 `manifest ->` 收尾行」才覆盖为 `OK`；step 被超时 kill 时文件仍是 `FAIL`。`ci-summary.js --rp` 另把「Sporting Life 0 请求 / 0 成功」判 FATAL，成功率低于一半只判 WARN。末尾 **Gate on diagnostics** 同时读 `verdict.txt` 与 `rp-verdict.txt`，任一 `FAIL` 才 `exit 1`。因为 `Deploy to Pages` 排在 Gate 之前，**标红只报警、不拦发布**，也不会像去掉 `continue-on-error` 那样把当天 JBIS 数据一起丢掉。

## 已知限制

- 出馬表只在开赛前 1–2 日存在，赛后由结果页替换，错过窗口无法补抓当时状态。
- 出馬表公开时枠順 基本已确定（2026-11-14 实测 JRA/NAR 出表即 100% 有番号）；补采补的是整表缺失与个别缺号，缺号优先由 `data/results` 终态值与「馬番→枠番」推导解决（`src/backfill-waku.js`）。
- 中央出馬表模板以实测为准；采集器对 `/race/` 与 `/race/result/` 双向尝试，缺 母父 时回退马页。
- 个人研究用途，遵守 JBIS 利用規約，请求间隔 1.2s。
