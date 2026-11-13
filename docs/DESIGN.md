# 出走表（Race Entries）设计

从 JBIS 赛历抓取「出馬表」（出走表），按 **中央/地方 × 竞马场 × 父 / 父父 / 母父 / 比赛格** 组合筛选、分组与导出。

## 1. 数据来源与页面结构

| 层级 | URL | 结构 | 公开时机 |
|---|---|---|---|
| 赛历 | `/race/calendar/?year=YYYY&month=MM` | `li.calendar__track-1`（中央）/ `-2`（地方）+ `a[href=/race/calendar/YYYYMMDD/CCC/]`，含 `tag-race-*` 级别标签 | 长期 |
| 当日 | `/race/calendar/YYYYMMDD/CCC/` | `div.data-6-12`（中央）/ `div.data-6-35`（地方）：R、発走時刻、レース名、芝ダ、距離、頭数、勝馬 | 中央 ≈ 开赛前 2 日、地方 ≈ 前日 |
| 出馬表 | `/race/YYYYMMDD/CCC/RR/` | `div.data-6-27`：枠番、馬番、馬名、**父 / 母 / 母父**、性齢毛色、騎手斤量、調教師・馬主・生産牧場、前 3 走 | 同上（赛后转 `/race/result/…`） |
| 血统 | `/horse/{10位ID}/` | `div.data-3__inner`：父・父父・父母 / 母・母父・母母 | 永久 |

- **父父** 出馬表页不提供，由父马马页取「父」补齐；**母父** 出馬表页直接给出。
- 若某模板缺 母父，自动回退到该马的马页，一次拿全 父/父父/母/母父。
- 中央出馬表先试 `/race/`，失败再试 `/race/result/`；两者都无 `data-6-27` 则记 `pending`，下次运行重试。

## 2. 落盘格式

```
data/races/{YYYY-MM-DD}/{CCC}.json        # 日 × 场 一张出走表
data/races/_calendar/{YYYY-MM}.json       # 赛历快照
data/races/manifest.json                  # 采集状态索引
data/pedigree/sire/{id}.json              # 父马 → 父父（缓存，不进 git）
data/pedigree/horse/{id}.json             # 马 → 全血统（回退用）
```

`data/races/{date}/{CCC}.json`（`jbis.race.card/v1`）：

```json
{
  "schema": "jbis.race.card/v1",
  "date": "2026-10-24", "track": "231", "venue": "高知", "scope": "local",
  "source": "https://www.jbis.or.jp/race/calendar/20261024/231/",
  "races": [{
    "no": 1, "startTime": "15:05", "name": "C３－１２ C３",
    "surface": "ダ", "distance": 1400, "heads": 9,
    "klass": "C3", "klassGroup": "一般", "gradeTag": null,
    "raceKey": "20261024/231/01", "status": "entries",
    "runners": [{
      "frame": 1, "num": 1,
      "horse": {"id": "0001333127", "name": "アラタマファルクス"},
      "sex": "牝", "age": 5, "color": "芦毛",
      "jockey": {"id": "031372", "name": "塚本直之"}, "weight": 52,
      "trainer": {"id": "011251", "name": "胡本 友晴"}, "belongs": "高知",
      "owner": {"id": "…", "name": "中嶋弘士"},
      "breeder": {"id": "0000001404", "name": "槙本牧場"},
      "sire": {"id": "0001134867", "name": "レッドファルクス"},
      "sireSire": {"id": "…", "name": "スウェプトオーヴァーボード(USA)"},
      "dam": {"id": "0000989888", "name": "アイビー"},
      "bms": {"id": "0000225628", "name": "サクラバクシンオー"},
      "recent": [{"rank": "10着", "date": "2026-10-11", "venue": "高知",
                  "surface": "ダ", "distance": 1300, "going": "稍重",
                  "time": "1:30.0", "margin": 4.4, "bodyWeight": 406, "bodyDelta": -5}]
    }]
  }]
}
```

`status`：`entries`（已出表）/ `pending`（未公开或抓取失败）/ `result`（已出结果，不再重抓）。

## 3. 比赛格归一（`src/race-config.js`）

`klass` = 具体格，`klassGroup` = 粗分组。

| 来源 | klass 例 | group |
|---|---|---|
| 级别标签 `tag-race-*` | GⅠ GⅡ GⅢ JpnⅠ JpnⅡ JpnⅢ JGⅡ L 重賞 | 重賞（JG = 障害） |
| 中央赛名 | 新馬 未勝利 1勝 2勝 3勝 OP 障害 障害未勝利 | 同名 |
| 地方班别 | A1..A3 B1..B3 C1..C3（取首个班，如 `B3イC1ア` → B3） | 一般 |
| 其它 | 特選 交流 一般 準重賞 | 一般 / 交流 / 重賞 |

场地代码：1xx 中央（101-110），2xx 地方（210-246），未知按数值段推断。

## 4. 采集流程（`src/collect-races.js`）

1. 抓赛历（按月，1–2 次请求）→ `date + track + 级别`；
2. 抓当日页 → 赛事列表与 `status`；
3. 对 `entries` 抓出馬表 → 解析骑手 / 血统 / 前 3 走；
4. 补血统：父父走父马缓存，母父缺失回退马页；
5. 写 `data/races/{date}/{CCC}.json`，更新 manifest。

幂等：以 `[R, 头数, (马ID:馬番:枠番)]` 指纹比对，一致则跳过；`--force` 强制重写。

**覆盖保护（`src/lib/guard.js`，2026-11-10）**：采集失败时（源站假 404、页面结构变动、分页只取到部分场次）解析器会产出空壳或残缺文档，直接落盘会把已完整的旧文档冲掉——2026-10/11 实际发生过 3 例（10-31 高知 117 头→0、10-31 佐賀 125 头→0、11-04 Musselburgh 87 头→1R/12 头），只能从 git 历史手工恢复。判据：已经跑完的赛事不会整体或大幅消失，故 `guardOverwrite()` 在**全量与部分采集下一律生效**——

| 情形 | 处理 |
|---|---|
| 旧文档有 runners，本次 0 头（空壳） | 保留旧文档，日志 `[keep] …（空壳）` |
| 旧 ≥5 头，本次 < 旧 50%（腰斩） | 保留旧文档，日志 `[keep] …（腰斩(<50%)）` |
| `--limit`/`--tracks` 部分采集且少于旧文档 | 保留旧文档（原有行为） |
| `--force` | 一律放行（人工强制重采） |

整场取消出走通常只掉 1–3 头（18→15 放行），不会过半，因此阈值不误伤正常更新。保留时 **manifest 记录按实际落盘的旧文档写**（否则会记成空壳，正是历史脏记录的来源之一）。

**赛中级保护（2026-11-14）**：`guardOverwrite` 只在**整份文档**层面判「空壳 / 腰斩」，而同一文件里「部分场次已完赛、其余仍是 entries」时总头数可能仍过半 → 判据放行、已完赛场次的 `runners` 被写成空数组，枠順/馬番 丢失（`--force` 与手动重跑同样会踩到）。因此 `collectTrack` 对**非 `entries` 场次**（`result` / `pending`）整段继承上次快照的 `runners` 与 `heads`（`keepPrev`），`status` 仍按当日页真值记；两条路径都取不到出馬表时也沿用旧骨架（日志 `[keep] … 出馬表缺页`），不写空壳。番号的增量补采仍由 `backfill-waku.js` 负责，本处只保证不丢已有数据。

manifest 记录统一由 `manifestEntry()` 生成，**成功与失败路径共用同一套字段**：失败时沿用旧文档（或上一条记录）的 `races/decoded/runners`，`status` 仍反映文档实际状态（有 runners 即 `ok`），本次失败原因写 `lastError`——旧实现 catch 里只写 `{venue,status:"error"}`，导致 `undefinedR / undefined头` 的脏记录。

礼貌抓取：间隔 `SITE.delayMs`（1.2s），UA 标识用途；单周约 250–400 次请求。

### 4.1 枠番/馬番 轻量补采（`src/backfill-waku.js`，12:00 补采档）

全量档（北京 02:00）跑的时候，次日及以后场次的出馬表往往还没公开，落下来的是空壳文档（`runners=[]`）。12:00 补采档只有两件事，且**本地能解就不发请求**：

1. 读 `data/races/{date}/*.json.gz`（窗口 = **今天 + 明天**；`scope=overseas` 跳过，海外无「枠」概念）；
2. 本地先解（0 请求）：
   - 已完赛场次 → `data/results/{date}/{CCC}.json` 的 runner 带终态 `num`+`frame`（含取消马），按馬 id 直取；
   - 有 `num` 缺 `frame` → 枠番是「馬番 + 出走頭数」的函数（8 枠制：≤8 头一台一枠；9–16 头自 8 枠往前每枠 2 头；17 头以上再往前每枠 3 头），**只在馬番 1..N 连续且与当日页头数一致时**推导（有取消/欠番会错位，直接放弃）；
3. 仍缺才抓出馬表页 `/race/{ymd}/{CCC}/{RR}/`（失败回退 `/race/result/`），**1 场 1 请求**；
4. 有表缺号 → 按 **馬 id** 只填空值、不覆盖；整表缺失 → 整表写入并用 `data/pedigree` 缓存补齐：马名/英文名/国籍 ← `jbis-name.json`、父父 ← `jbis-sire.json`、彩衣 ← `nk-owner.json` / `wf-horse.json`（**0 额外请求**，实测 127 头复原结果与原文件逐字段一致）；
5. 有变化才写 gz：只补号的场次记 `wakuAt`，整表重建才更新 `capturedAt`；同时刷新 `manifest.json` 对应场次。

不跑赛历、不解析当日页、不抓马页/血统/彩衣（这些属于全量档职责）。请求量 = 仍缺数据的場次数（典型 = 空壳场次 12–36 场 → 12–40 次 / 30 秒–2 分钟；全部已完整时 **0 请求 0 写盘**）。CI 里 `changed=0` 时不 build、不提交、不部署。

## 5. 构建（`src/build.js`）

```
_site/index.html, app.js, style.css       # 静态页
_site/data/races/**                       # 原始快照（可选择不发布）
_site/derived/index.json                  # 日期 / 周 / 场 / 比赛格索引
_site/derived/{YYYY-MM-DD}.json           # 扁平行（表格与 CSV 共用）
_site/derived/horse-aliases.json          # 马名别名字典（canonical 合并同名马；下拉/分组/透视共用）
_site/excel/races-{ISO周}.xlsx            # 每周工作簿
```

扁平行字段：`date weekday scope track venue raceNo startTime raceName klass klassGroup grade surface distance heads frame num horseId horseName sex age color jockey weight trainer belongs owner breeder sire sireSire dam bms raceKey recent[]`。

XLSX 由 `src/lib/xlsx.js` 零依赖写出（ZIP store + inlineStr），Excel / LibreOffice / openpyxl 均可读。

## 6. 页面（`site/index.html` + `site/app.js`）

- 日期 chips：默认最新比赛周，可多选；
- 场地 chips 默认 JRA（当日无中央出走表时退回 NAR；全部 = 清空多选），分三段陈列：`全部 ｜ JRA·中央 NAR·地方 ｜ 海外 + 国家组码`（段间细竖线 + 「海外」组名）；竞马场 chips 按 **中央 / 地方 / 海外** 分组、**只列当前场地选择下存在的场**（JRA → 中央固定 10 场；NAR → 地方固定 15 场；选中海外国家 → 仅这些国家的场，多国时一国一组「海外 FR」；全部 → 三组全列），切场地即清空竞马场选择；级别 chips（计数，无数据置灰），级别展示名「无级别」→「普通比赛」；
- 父 / 父父 / 母父 下拉（按入头数排序，取前 400）：按 canonical 合并同名马——两源写法不同（JBIS「Saxon Warrior(JPN)」/ RP「Saxon Warrior」、JBIS「ディープインパクト」/ RP「Deep Impact」）归为一条，展示名取行内最多写法，搜索匹配全部别名（`src/lib/horse-name.mjs` 归一 + `derived/horse-aliases.json` 别名）；过滤、分组、Excel 透视同口径，表格/CSV 保留原始写法；
- 血统快捷标签行（血统行下方）：点标签 → 对应下拉按 canonical 自动选中（再点取消）；「＋当前」把下拉当前选择存为标签（每项上限 12 个）；✕ 移除；「恢复默认」还原出厂。默认 父=コントレイル / キズナ / シルバーステート / リアルスティール、父父=母父=ディープインパクト；存 localStorage（`rc.ped.tags.v1`），保存过就完全以本地为准（清空也是合法状态）；
- 关键字过滤；分组下拉与血统下拉同款（父 / 祖父 / 母父 / 骑手 / 练马师，空 = 不分组）；表格行全局按北京时间升序（早的发走排上，跨日期交叉排；同时刻按场次R/竞马场兜底，`cmpBjTime`）；
- 前端内存分页：PC 一页 100 条、mb（<768px）一页 20 条，每页条数按设备固定不可选；页码按钮式分页条（移植 yunji-web races.html `.pager`），768px 断点 matchMedia 实时切换（老 Safari addListener 兜底）；筛选条件变化归第 1 页；分组视图整组分页——页内按整组装填，装不下整组移到下一页（最后一组不截断），单组超过一页容量才组内截断，跨页组自动重复组头，组头 `tr.sub` 不占条数；
- CSV 导出（UTF-8 BOM）与每周 Excel 下载；
- 深链：`?group=sire|sireSire|bms|jockey|trainer`；
- **favicon**（2026-10-29）：站群品牌方块（friend-links.js 同款青绿 #0aa7a0 圆角方块 + 白字 RC）——`site/favicon.svg`（首选）+ `site/favicon.png` 64×64（不支持 SVG favicon 的浏览器兜底）+ `site/apple-touch-icon.png` 180×180 全出血方块（iOS 主屏，系统自带圆角遮罩）。此前未声明 favicon，浏览器标签页显示默认地球。

## 7. 已知限制

- 出馬表只在开赛前 1–2 日存在，赛后即被结果页替换。
- 出馬表公开时枠順 基本已确定（2026-11-14 实测：JRA 三场 + NAR 两场出表即 100% 有番号，本地 11-08 六个场 860 行 0 缺失），补采档实际补的是**整表缺失**与**个别缺号**，缺号优先由 `data/results` 终态值与「馬番→枠番」推导解决（§4.1），不是等源站晚公布。
- 中央出馬表模板以实测为准；当前有马页兜底。
- 数据仅用于个人研究，遵守 JBIS 利用規約。

## 8. 多源架构（`src/sources/`）

新增比赛源时只需实现一个适配器并注册，不改动采集/构建/展示的其余部分：

```
src/sources/
  registry.js     源注册表 + 适配器接口约定
  http.js         共享抓取（超时 / UA / __NEXT_DATA__）
  normalize.js    中间映射层：时区标注、单位换算、比赛格归一（纯函数）
  racingpost.js   Racing Post 适配器
  racingpost.probe.js  连通性自检（RP 直连 vs SL）
src/collect-sources.js 通用多源采集入口
```

适配器接口：`{ id, label, homeUrl, probe(), collect(opts) → [{date, file, doc}] }`。
`doc` 为 **canonical race.card/v2**：字段名以 JBIS 为主（`runners[].horse / sire / dam / bms / jockey / ...`），
源特有字段收进 `doc.<sourceId>` 命名空间（如 `runner.rp.formsummary`）。

### 8.1 Racing Post 源（`source: "racingpost"`）

- **抓取层**：racingpost.com 的 WAF 对非浏览器客户端一律 406（页面与 `/api/*` 同），
  无法从零依赖采集器直连。同属 RP 集团的 **sportinglife.com** 承载同一份 racecards 数据
  （RP verdict / Timeform 星级 / RP 官方卡片），且 robots.txt 无任何 Disallow —— 适配器以
  SL 为抓取层，`doc.fetchLayer` 标注；RP 直连探测保留在 `probe()`，解封即可切换。
- **数据窗口**：SL 只提供「英国当天」的卡片（日期 URL 307 回当日页）；美国夜场的
  `race.date` 标签可能是场地当地次日，按标签落盘到对应日期目录。
- **请求结构**：当日页 1 次（会议 + 场次 meta + 单场链接）→ 单场页 1 次/场（rides）→
  马匹档案 1 次/马（父 / 母 / 母父，缓存于 `data/pedigree/rp/horse/{id}.json`）。

### 8.2 时区约定（重要）

| 字段 | 含义 | RP 源 | JBIS 源 |
|---|---|---|---|
| `race.startTime` | 源展示的钟面时间 | 英国当地（Europe/London） | JST |
| `race.startTimeTz` | startTime 的时区 | `Europe/London` | `Asia/Tokyo`（build 缺省补齐） |
| `race.startTimeInstant` | 绝对时刻（ISO8601 含偏移） | 适配器计算 | build 按 +09:00 补齐 |
| `doc.date` | 场地当地比赛日标签 | `10-22`（US 夜场可能是当地次日） | JST 比赛日 |
| `doc.timeZone` | 展示口径时区 | `Europe/London` | `Asia/Tokyo` |
| `doc.localTimeZone` | date 标签口径时区（场地） | 按国家映射（USA 场个别覆写） | `Asia/Tokyo` |
| `race.startTimeLocal` | 场地当地钟面 | 例：Belmont `12:10` | 同 startTime |

> SL 的 `time` 一律是英国当地时间（实测：Abu Dhabi 13:00 = 当地 17:00、Belmont 17:10 = 当地 12:10、
> Turffontein 10:35 = 当地 12:35）；`date` 是场地当地比赛日。跨英国午夜的美国夜场，
> 由 `raceInstant()` 用场地时区反推正确的英国日历日，再生成 `startTimeInstant`。

Excel 末尾新增「源」「発走(基準時刻)」两列；区分含 `overseas`（海外）。

### 8.3 RP 字段映射（→ JBIS 主 schema）

| JBIS 字段 | RP/SL 来源 | 备注 |
|---|---|---|
| num | `cloth_number` | |
| frame | — | 英国无枠番，恒 null |
| horse.id | `rp:{horse_reference.id}` | `rp:` 前缀避免与 JBIS 10 位 id 撞号 |
| sex / age / color | `sex.type` / `age` / `horseColour` | c/f/g/m → 牡/牝/セ；b/br/ch/gr/bl → 鹿毛等 |
| weight | `handicap`（英石-磅） | 换算 kg，原始值存 `weightRaw` |
| jockey / trainer / owner | 同名字段 | |
| sire / dam / bms | 马匹档案页 | 相对 id 是 SL 数据缺陷（恒等于页面 id），故只取名字 |
| sireSire | — | 档案无父父且父马 id 不可反查 → null（父 / 母父分组不受影响） |
| klass / klassGroup | 赛名 + `race_class` | Group/Grade 1-3 → GⅠ-GⅢ、Listed → L、Hurdle/Chase → 障害、其余 `Class N` |
| surface / distance | `course_surface` / `"2m 1f 33y"` | TURF → 芝、AWT 等 → ダ；英里/化朗/码 → 米 |
| recent | `previous_results` | 含 odds / 走位评论，无胜负用时 |

采集命令：

```bash
npm run collect:rp                                  # GB+IRE（默认）
node src/collect-sources.js --source racingpost --countries all
node src/collect-sources.js --source racingpost --limit 3 --no-pedigree   # 快速试探
```

### 8.4 已知限制（RP 源）

- 抓取层依赖 SL 页面结构（Next.js `__NEXT_DATA__`）；`probe()` 可随时自检。
- 只覆盖英国当天卡片；赛前 1-2 日的未来卡片在 RP 站有但被 WAF 挡。
- 无 枠番 / 生産牧場 / 胜负用时；体重为英石-磅换算值。
- **父父补全借道 JBIS**：SL 档案父系引用 id 恒为页面自身 id（数据缺陷）无法链查，改为 父名/母父名 → JBIS 馬検索（`src/lib/horse-lookup.js`，缓存 `data/pedigree/name-lookup.json`）解析到 JBIS id 后取行内「父」列；消歧 = 名字归一精确匹配 +「種」标签 + 牡 + 生年 ≤ 当年-5 且 ≥ 当年-45（现代父系年龄下限，同名老马如 Highland Reel 1964 直接排除），英文名搜索但行内显示片假名时对前 5 行补抓马页核对官方英文名，不能唯一确定时留空。JBIS 未收录的名字（部分 US/挽马种公马）父父为空。
- **别名字典同名异马冲突**：build 时现役种公马（`jbis-sire.json` 缓存键，出馬表里当过「父」）优先于 lookup「種」标签命中、再优先于其它声明，同分先到先得并打日志（`node src/backfill-lookup.js --revalidate` 可按新规则重验冲突/老马误绑并重写文档）。
- US 场的 Woodbine 实际在加拿大（SL 标 USA），时区覆写为 America/Toronto。

## 9. 出馬表分享卡（`site/share.js`）

主表「勾选比赛」→ 浮动条「生成分享卡」（或「完成勾选」）→ canvas 渲染的分享卡页（新开一页数据、从顶部开始；返回列表保留勾选）。

- **选择（行级）**：`#pick-mode` 开启勾选模式，复选框按行（馬）勾选，行键 = 比赛 + 馬番（`rowKeyOf`）；分享卡只包含勾选的行，同一场比赛的勾选行归入同一块（不整场塞入）。勾选框绝对定位在首格左侧预留区，不影响行内容排版。浮动条：已选 N 頭（点击展开上拉预览列表：馬名 · 场R · 比赛名，按北京时间升序，逐条可取消）+ 生成分享卡 + 清空；「完成勾选」在有勾选时直接进分享卡页；汇总条「全选本页 / 取消本页」按钮（仅勾选模式显示，内联跟在计数文字后）= 当前筛选 + 当前页展示的全部行（含分组视图页内区间，`pageRows`）。`?pick=demo` / `?share=demo` 为视觉自检深链（demoPick 按级别优先 G1→地方重赏→G2→G3→L 各取一场并展开为行级勾选）。
- **编辑**：分享卡下方 = **Excel 式批量编辑表格**（`site/share-grid.js`，交互移植 yunji-web editor-table.js §104）：**三段式列序（2026-10-29 定稿）**——前段固定「比赛 + 级别」（先看是哪场）→ 中段出走马编辑列（枠番/马号/马名/性龄/骑手/负重/练马师）→ 后段固定上下文列（日期/竞马场/R/赛道/距离/当地时间），比赛头行的场操作（↑↓ ＋ ✕）跨中段列区；比赛级列只在比赛头行可编辑（改日期/时间自动重算 weekday/dateLabel/startTimeInstant），出走馬行灰显回显；键盘流按行内实际存在的列移动（比赛头行跳过中段跨列区）。行首勾选（表头全选 + 各场行头全选本场）→「删除所选」。就地编辑（输入框绝对定位盖满本格，不撑列宽）、Enter↓ / Tab→ / 方向键、Delete 清格、Ctrl+Z / Ctrl+Y 撤销重做（内存操作日志 ≤80 步，结构操作重建视图）；「📋 粘贴导入」读剪贴板 TSV（Excel 直接复制），按可见出走馬列序追加到目标比赛（最后点击的比赛 / 最后一场）。列显隐菜单（列 ▾）+ CSS 伪全屏（⛶，fixed inset-0，不依赖 Fullscreen API）。所有编辑即时回调 share.js 重绘画布；手机端隐藏表格只留提示。「＋ 手动添加比赛」表单保留（日期 / 场 / R / 比赛名 / 级别 / 芝ダ / 距离 / 当地时间 / 时区 + 出走馬文本区每行 `枠 番 馬名 性齢 騎手`，性齢/騎手可省略，全角数字自动归一；北京时间由 startTimeInstant 现算，跨日自动带 MM-dd）。`?share=demo&edit=1|2` 为编辑链路端到端自检深链（edit=2 顺带撤销 3 步复原）。
- **列配置**：附加列 chips（负重 练马师 父 祖父 母父 母 毛色 所属 马主 生产牧场），默认负重+父+母父；列宽按内容实测（每场独立），余量均摊占满行宽，超限按余量收缩 + 单元格省略号。配置存 localStorage（`rc.share.cols.v3` / `rc.share.scale`），追加列顺序恒按 EXTRA_COLS 排列。
- **出图**：纯 canvas 零依赖（无 html2canvas），默认 2×（≈1976px 宽，可选 1×/3×），「导出 PNG」或「复制到剪贴板」（ClipboardItem，需安全上下文）。
- **版式 v1.9.0 · 分卡（2026-11-07 定稿：比赛名独占行1 + 行2 赛事标签行，枠番单色块）**：
  - **块头两行、块内齐左**：
    ```
    ▎ サラ系３歳上１勝クラス [GⅡ]
      福島6R 芝2600 · 北京 11-07 11:35
    ```
  - 行1 = **比赛名 17/700 ink → 级别徽章**（只有这两件；日期/场次/赛道/时刻全部下到行2）
  - 行2 = **场次 13/600 墨灰 → 赛道 12/400 灰（距离不带 m）→ 当地 12/400 灰（可选）→ 北京 12.5/700 tealInk（带日期 `MM-DD HH:MM`）**，`·` 淡灰分隔。
  - 口径：日期只出现一次（跟在「北京」后），不再单独做日期标签 —— 之前「[11-07 福島6R] 标签 + 北京 11:35」会让人对着两个日期信息判断；场次紧挨赛道，读作 JBIS 式「場R + 芝ダ距離」。
  - 对齐：块内全部齐左（行2 首字 = 行1 比赛名首字 = 竖条右 14px），标签/缩进/定宽槽一概不用 —— 这个块头任何矩形留白都会被看见（前四轮返工结论）。
  - 青绿只出现两处：左侧 4×36 竖条 + 行2 的北京时刻。
  - `HEAD_H` 74 → **58**；几何常量 `HD_BAR_Y/HD_BAR_H/HD_BASE1/HD_BASE2/HD_LINE`（3/36/19/37/45），绘制与 H 累加共用，改一处必须同步。
  - **枠番合一一列 = 单色块**（与紧凑一览 `drawDense` 同款）：26×20 圆角块，**色 = 枠番、块内只写馬番**，一块一个数字；列宽 60 → 46。无枠海外场（整列无 1–8）仍退化为纯馬番列、不套灰块。
  - 其余不变：table 型网格（外框 + 竖向列分隔 + 表头底色）、行高 41 / 马名 18 / 表头 30（tokens `fs:{head:11,horse:18,body:15,extra:14.5,num:17}` + `ROW_H/COLH/GAP`）、级别徽章紧跟比赛名（「地方重賞」写全不缩写）、报头「共 N 頭出走 M 场」、时间开关 `rc.share.clock.v1`（至少一路，`&clock=local` 深链）、附加列默认 斤量+父+母父（`rc.share.cols.v3`）。
- **新标签页**：「生成分享卡」/「完成勾选」把载荷写 sessionStorage（`rc.share.payload`，新标签页自动复制 opener 的 sessionStorage）后 `window.open('?share=open')`；新页 main() 读取并渲染，返回列表即关窗。
- **勾选数据源**：`rowsForPick()` 汇总**全部已加载日期**的行（不受当前筛选影响）——清空条件换场地继续勾选，之前勾的馬仍在卡里；卡片内比赛块按**北京时间升序**（跨日交叉排，同刻按 场次R/竞马场 兜底，`collectShareRaces` 输出排序；手动添加漏填时刻殿后），画布按数组顺序换天 / 换场地画标题。
- **品牌**：顶部 6px 青绿条；页脚 RACING CALENDAR 字标 + `hinotoyk.github.io/racing-calendar` + QR 码（`site/vendor/qrcode.js`，MIT · Kazuhiko Arase，typeNumber 自动 / ECC M，`isDark` 逐模块画进 canvas）。
- **比赛名缩短**（2026-10-29）：`shortRaceName()`（share-grid.js 导出，卡片块头 + 批量表格显示共用，**纯展示**——原始数据与编辑值不变）。UK/IRE 命名规律：`赞助商… 类型 (级别) (Registered As The 注册名) (GBB Race) (Div n)`。规则：① 有 `(Registered As X)` → 直接采用官方注册名（跨年稳定；赞助商前缀无词典不可剥，如 squareintheair.com）；② 噪声标签剔除：GBB Race / GBBPlus / GBB/GBBPlus（繁育奖金计划）、Registered As 本体、Grade/Group/Listed（级别已由徽章与「格」列表达）；③ 其余标签**原位保留**：Div/Division（同场分流必须保留否则同名）、0-100 评级、Q.R.、F & M。例：`Oddschecker Novices' Hurdle (Grade 2) (Registered As The Sharp Novices' Hurdle) (GBB Race)` → `The Sharp Novices' Hurdle`。
- **版式参数**：主题 tokens 携带 `ROW_H`/`COLH`/`GAP`/`fs:{head,horse,body,extra,num}`（现值 41/30/26/{11,18,15,14.5,17}），枠号芯片尺寸随行高自适应；候选版式机制（masthead bar/press/thin、waku mono/frame/band、开放表、层级块头）已随样式下线一并移除，仅保留 strip 报头 + chip 枠号 + wakuNum 合列。
- **设计约定**：与主站 style.css 同 token（#0aa7a0 × shadcn Neutral，仅亮色）；枠番用 JRA 官方 8 枠色芯片（1白2黒3赤4青5黄6緑7橙8桃），级别徽章沿用主站 JBIS 配色；比赛名 / 距离 / 当地时间·北京时间都编码在**块头单行**里（不逐行重复），行列为 马号(枠番色块+马号合一列) / 马名 / 性龄 / 骑手（+ 附加列）。设计稿原型：`design/share-card.html`（样例数据由 `design/_extract.mjs` 生成）。

> 实现教训：canvas 重设 `width/height` 会重置画布状态（含变换矩阵）——必须先设尺寸再 `setTransform(scale)`，否则导出 PNG 内容缩在左上角、其余全透明。

## 10. 嵌入引用（兄弟站统一模式：`embed/` 组件 + derived 数据）

本站向种马档案站（yunji-web / kzn-web …）提供**纯渲染组件**，供其一行挂载——与 jbis-sire-rank-history 的 `embed/sire-rank-chart.js` 同一引用模式（宿主给一个挂载点 + 种马名，得到内嵌结果；不照搬整站页面）。

- **组件**：`site/embed/entries-table.js`（构建进 `_site/embed/`，零依赖单文件 IIFE，挂 `window.RC_ENTRIES_EMBED`）。API = `VERSION` / `load(base, opts)`（数据编排）/ `render(el, data, opts)`（纯渲染）/ `mount(el, opts)`（load + render + 内建加载/失败/重试态，宿主一行挂载）。
- **宿主用法**：动态加载组件脚本（Promise 缓存）后 `RC_ENTRIES_EMBED.mount(el, { base: "https://hinotoyk.github.io/racing-calendar/", sire: "コントレイル" })`。`sire` = 種牡馬日文名（JBIS 原形，宿主从自家 config 取，与数据行 sire 字段同源）；`days` 控制未来侧有数据日期数（默认 4）。
- **视图（v2.6.0，2026-11-08 定稿：马号色带 + 彩衣列 + 宿主联动 + 前走列）**：
  - **分类 chips**（头部计数右侧）：`全部 / JRA·中央 / NAR·地方 / 海外`，各带实时条数；点击即筛（纯前端 filter，不重新取数）。口径与主站筛选卡「场地」三段一致（`scope`：JRA / NAR / 其余国家组码与「海外」→ 海外）。**四个恒定展示**：计数为 0 的分类（如无海外出马时的「海外 0」）按钮照样在、样式更淡，点进去给对应空态而不是偷偷切回「全部」（用户要求：海外没有比赛也要有按钮）。选择只存在挂载点（`el.__rcScope`），不写任何存储键，刷新回到「全部」。
  - **形态/档位判定 = 组件自身宽度**（`ResizeObserver`，只在跨档时重绘；同档只更新字号系数不重排）：`<720` 卡片 / `720–1179` 十列 / `≥1180` 加「母父」/ `≥1500` 再加「练马师」+「前走」（十三列）。
  - **字号 fluid**：`--re-k = clamp(1, w/1000, 1.3)` 写在 `.rc-emb` 上，表格里所有字号与内距都写成 `calc(Npx * var(--re-k))` → 27 寸屏（容器 ~2000px）时正文 12.5→16.25px、行高 29→38px。头部标题用更缓的斜率（`13.5px + (k-1)*6px`），避免比表格还小。
  - **为什么加列而不是继续放大**：27 寸屏宽 2000px 时，九列的百分比布局会把每列拉得很空；母父 / 练马师 本来就在数据里（sire 站的父是常量、无信息量），正好把宽度换成信息。
  - **宽容器 = 密表**：比赛级 4 列按 `rowspan` 合并（北京时间 / 场次=「场地 + R 号」两段各自对齐 / 比赛+级别徽章 / 赛道），**合并列垂直居中**（与分享卡 `drawDense` 的 `midOf()` 同口径；顶端对齐会让两匹的场次左侧空出半块，宽表下很丑），逐马列（马号满格色带 / 彩衣 / 马名 / 性龄 / 负重 / 骑手 + 母父 + 练马师）；日期 = 跨列行「11月7日（土）」+ teal 短竖条；冷灰网格（表头 `#f3f5f7`、明细线 `#f0f2f4`、结构竖线 `#eef1f4`、斑马 `#fafbfc`），无外框无圆角。
  - **马号 = 满格色带**（2026-11-08 用户按参考站定稿）：底色**刷在 `td` 上**（表格单元格背景一定填满整个单元格盒，不受内容高度影响），零左右内距、无圆角、**上下不画横向分隔线** → 相邻两格颜色直接相接成一条竖带，同枠的产驹一眼连成一段；色 = 枠番（JRA 官方 8 色，与主站 `.waku`/分享卡同源），字 = 馬番，12.5px×系数 / 700。此前是 26×19 圆角芯片，色块之间被行线和留白割开，读不出一条带。
  - **彩衣列**（`data/silks/` 马主勝負服小图，构建时随站点发布）：紧跟马号，高 `19px × --re-k`、等比缩放、白底 + 1px 细描边（`data:` 无值时不占位）。整批行都没有彩衣（纯海外源 / 未覆盖马主）时**整列不摆**——空列比缺列更费解。
  - **无枠番的退化**（海外 RP 源恒无枠番 / 未確定页）：色带不刷底，退回普通居中馬番文本（`--re-muted`），**不套灰块**——灰块会被读成「字段坏了」；連馬番都没有才显示极淡的「–」。卡片态的马号仍是 24×19 小方块（横向不够一条带），彩衣 17px 跟在后面，第二行（骑手/母父）缩进 61px 与马名左缘对齐。
  - **窄容器（MB）= 逐场卡片**：日期分隔 → 一场一块（条头 `京都1R … 09:05` → 比赛 + 赛道 → 产驹两行「马号 + 彩衣 + 马名 + 性龄 + 负重」/「骑手 母父」）。换形态而不是收列：十列压进 390px 只能横滑或砍列。
  - 两形态共用：`groupByDate()`、`cleanRaceName()`、`wakuChip()`/`levelBadge()`、头部、最近一周折叠、空/加载/失败态。列宽按档位各给一套百分比（每档合计 100%），`table-layout:fixed` 下不会撑爆。
- **数据**：组件自带 load——fetch `derived/index.json` + `derived/{date}.json`（字典包，`unpackRows` 内联自 `src/lib/rows-codec.mjs`，两处同步改），**不写任何存储键**（缓存仅内存）。与 sire-rank-chart「宿主 fetch 数据」的契约差异是有意的：出走表多文件懒加载的编排成本不转嫁给宿主。
- **变量**：亮色单主题；颜色走宿主 CSS 变量（`--foreground/--muted-foreground/--border/--primary/--card` 等，缺省回退 #0aa7a0 × shadcn Neutral），与 friend-links.js 归一化变量同一做法——宿主换肤组件跟随；枠色/级别徽章 = JRA 官方枠色与 JBIS 配色（数据语义写死，同主站 `.waku`/`.yj-g*`）。冷灰网格的 `--re-line/--re-vline/--re-zebra/--re-headline/--re-racline/--re-dayline` 与 `share.js::drawDense` 的 `C_LINE/C_VLINE/C_ZEBRA/C_HEAD_LINE/C_RACE_LINE/C_DAY_LINE` 一一对应，**改色必须两边同步**（漂移只有并排截图能发现）。
- **CORS**：GitHub Pages 全站带 `Access-Control-Allow-Origin: *`；本地 `npm run serve` 已对齐（`src/server.js` 全响应头补 ACAO *），供宿主站本地联调（宿主把 base 切到 `http://127.0.0.1:9093/`）。本站端口单源 = 项目根 `serve.config.json`（9093，四兄弟站之一）。
- **缓存与版本戳（2026-11-08 定稿：内容哈希，不是手写版本号、也不是随机数）**：构建时把 `embed/entries-table.js` 的 **sha1 前 10 位**写进 `embed/manifest.json`（`{file, hash, version, bytes, builtAt}`，`version` 从文件里的 `var VERSION` 抓）。宿主**运行时**先取这个小文件（`fetch(..., {cache:"no-store"})`），再拼 `?v=<hash>` 插 script：内容不变 → URL 不变 → 浏览器/CDN 缓存命中；改一行 → 哈希变 → 立即取新文件。口径与宿主站自身的 vite `autoVersionPlugin` 同款（同一 sha1-10）。
  - **不手写版本串**（`?v=2.5.0` 那种）：必然忘记 bump，结果线上永远是旧组件。
  - **也不用纯随机数**（`?v=` + `Math.random()`）：每个随机 URL 都是一次缓存未命中 —— 52KB 组件每次进页面重下、CDN 每个伪 URL 各自回源，还失去「用户报障能对上是哪个版本」这条线索。随机数买到的是「绝对新鲜」，代价是把缓存收益整份扔掉；内容哈希两者都要。
  - 唯一残留延迟来自 `manifest.json` 自身的 CDN 缓存（Pages 约 10 分钟，浏览器侧 `no-store` 已绕过）——这是平台地板，不是方案缺陷。
  - 取不到 manifest（旧部署 / 断网 / `file://`）时宿主退回裸 URL：功能不受影响，最多吃一次旧缓存。
- **宿主联动（v2.6.0，2026-11-08 定稿）**：组件**只管显示**；与宿主相关的事一律由宿主注入，`mount(el, { base, sire, host })`：

  | 回调 | 签名 | 语义 | 缺省（未注入） |
  |---|---|---|---|
  | `name` | `(jbisId) → { zh, kind } \| null` | 中文译名；`kind`：`"hk"` 港译 / `"self"` 自译 | 不显示译名 |
  | `horse` | `(jbisId) → url \| null` | 马名点击跳转（新标签） | 纯文本、不可点 |
  | `race` | `(row) → url \| null` | 比赛页地址覆盖 | 行内 `raceUrl`（JBIS 出馬表/結果页） |

  - **全部同步**（宿主先 await 自己的数据再 mount，云迹侧 `YJ.cache.fetch("basic")` 12h 缓存）；任一回调抛错或返回空 → 该能力静默降级，组件不崩、不留空行。
  - **译名优先级在宿主**（云迹：`香港馬名` → `自译馬名`）。组件只做两件事：自译名前置 `*`；在表格下方补一行 `* 为自译名`（**只在真有自译名时出现**，没译名就整行不摆）。显示形如 `ゴーイントゥスカイ/通天飞`、`セイウンサイフィー/*剑影星云`——同一行、中文名灰一档、长名一起省略，hover 出「（自译：xxx）」。
  - **相对 URL 直接用**：组件跑在**宿主 DOM 里**（不是 iframe），`href="profile.html?horse=39"` 天然按宿主页面解析。但宿主的马匹页认自家内部 id，`jbis_id → 内部 id` 的映射留在宿主侧，组件不掺和。
  - **为什么不做「RC 去拉宿主的名字表」**：跨域、数据格式耦合、版本得两头对，三样都不值当；回调注入零协议成本，宿主换数据源组件也不用改。
  - 宿主参考实现（云迹 `front/pages/entries.html`，kzn 模板站照抄这段即可）：
    ```js
    var MAP = null;                                  // jbis_id → basic.json 里的马记录
    function ensureMap() { return YJ.cache.fetch("basic").then(function (b) {
      MAP = new Map(((b && b.horses) || []).filter(h => h.jbis_id).map(h => [String(h.jbis_id), h]));
      return MAP; }); }
    ensureMap().then(function () { RC_ENTRIES_EMBED.mount(el, { base: RC_BASE, sire: SIRE, host: {
      name:  function (id) { var h = MAP.get(String(id)); if (!h) return null;
               return h["香港馬名"] ? { zh: h["香港馬名"], kind: "hk" }
                    : h["自译馬名"] ? { zh: h["自译馬名"], kind: "self" } : null; },
      horse: function (id) { var h = MAP.get(String(id)); return h && h.id != null ? "profile.html?horse=" + h.id : null; }
    } }); });
    ```
- **前走列（v2.6.0）**：`比赛名 · 人气 · 着顺` 一列三段（比赛名可省略、数字不省略），只在 tier2（≥1500）出现、排在练马师之后；点比赛名跳该场結果页。
  - 比赛名/着顺 = 出馬表前 3 走（已有）；**人气出馬表没有** → `src/collect-recent-pop.js`（`npm run collect:pop -- --sire コントレイル`）从 JBIS 馬頁競走成績回填 `data/recent-pop.json`：该页表头含「人気」，每行比赛名直链 `/race/result/{raceKey}/`，一匹马一次请求、永久缓存。
  - **按种马圈定而非全量**：20 天窗口有 2 万匹在跑，全量是 6 小时级；兄弟站都是按种马筛产驹，200~400 匹/种马（≈5 分钟），周增量只碰新出走的马（`seenDate` / 12h TTL 判重）。
  - **命中判定 = raceKey 一致**：缓存里那条前走必须与本行 `recent[0].raceKey` 对上才采信（马又跑了一场 → 自动判未命中，绝不串数据）；没跑过的新馬显示「新馬」，缺人气就只显示两段。
  - 每匹马缓存最近 3 场：本场行与「最近一周」历史行各自都能对上自己的前走。

- **主站完整页嵌入（附录，一般不用）**：`index.html?embed=1` + §6 筛选深链——`<html data-embed>`（head 内联脚本）收起装饰层（页头/页脚/站群导航）、`#page` 占满、锁亮色（暗色 token 收窄为 `:root:not([data-embed])`）；`app.js` syncUrl 保留 `embed=1`。适合确需完整功能（多维筛选/分享卡）的 iframe 场景，日常引用一律走组件。

---

## 11. 结果层（着顺，2026-11-09）

- **来源与动机**：JBIS 结果页中央滞后约一周、地方滞后一天，netkeiba 赛后当天即有全序（地方 `nar.*`、中央 `race.*`）。以 netkeiba 为结果主源，JBIS 仅作跨源校验。
  - 修正（2026-11-09 复盘）：初版只依赖 `/race/list/{date}/` 枚举口，该口当天不列中央 id，曾把 11-07/11-08 中央误判为「源侧缺口」。实际上 `race.netkeiba.com/race/result.html?race_id=...` 已有完整结果，只是需要中央 race_id 的另一条构造路径。
- **关联键**：`raceKey (YYYYMMDD/CCC/RR)` ↔ netkeiba `race_id`（地方 `YYYY+jyo+MMDD+RR`、中央 `YYYY+jyo+回+日+RR`）。`/race/list/{yyyymmdd}/` 一次枚举当天全部 id，按「场码 + R」对齐；中央场码 = JBIS 码 − 100（105 東京→05、108 京都→08）。
  - 枚举口当天未列中央时，从 **JBIS 当日页 title**「`2026年11月8日(日) 5回 東京 2日｜JBISサーチ`」解析 `{kaisai:5, day:2}`，0 请求构造中央 id（`2026050502{RR}`）；每天每场仅 1 个 JBIS 请求，结果缓存。11-07 東京 `202605050101` 与实测一致。实现 `src/lib/nk-race-id.mjs`、`collect-results.js::kaisaiDayOf()`。
- **马级对齐**：赛前出馬表 `parseNkShutubaMap()` 得「归一马名 → nkId」（NAR `id="umalink_{id}"`、JRA `href=".../horse/{id}"`），结果页按「马号优先、马名兜底」写回，产出 `horse.nkId`。赛前建的 race_id 赛后直接复用，不做单马反查（当天马页成绩未回填）。
- **三套模板（`parseNkResult` 按页面自动分派）**：① `All_Result_Table` 表头驱动，`nar.*/result.html`（NAR 14 列）与 `race.*/result.html`（JRA 15 列，多「コーナー通過順」）共用；② `table.race_table_01`（`db.*/race/{id}/`，25 列按 td 顺序，EUC-JP 由 `fetchNkHtml` 解码）作中央回退。中央结果页优先 `race.*`，无结果表才回退 `db.*`。归一出口实现 `src/lib/parse-nk-result.js`，字段口径 `docs/FIELDS.md §3.5`。
- **落盘**：`data/results/{date}/{track}.json`，`schema: jbis.race.result/v1`，按「日 × 场」与 `data/races/` 对齐；已 `result` 且完整则重跑 0 请求（幂等键 `raceKey`，`--force` 覆盖）。
- **构建**：`src/build.js::resultsOf()` 按 `raceKey|num` 把 `finish / resultTime / resultMargin / resultPop / resultOdds / resultLast3f / resultBody / nkRaceId / nkId` 合并进扁平行；另出 `derived/results-{date}.json` 与 `index.json::resultDates`。主表「着顺」（1 着强调；异常态显示中文全称徽标、按类别配色，hover 给含义与判定依据）与「最终人气」（`resultPop`，1 番人气高亮；区别于前走 `lastPop`）两列，移动端卡片、分享卡字段白名单、Excel 表头同步（Excel 写全称）。异常态口径单一出处 `src/lib/abnormal-finish.js`，build 阶段生成 `resultLabel / resultDesc / resultAbClass / resultReason`。
- **空态口径**：`ok / soft（200 无结果表）/ noid（枚举口与构造均无 id）/ error` 分开计数，不能合成一个 fail；另有 `fallback`（中央 db.* 回退命中）单独统计。`noid` 现在只会在枚举口与 JBIS 页眉都拿不到回/日时出现，属真异常。
- **触发**：按 `startTime` 判开赛，不用 JBIS `status=result`；滚动 `--days 2` 天然补 T+1 / T+7 缺口。CI 挂全量档 `update-data.yml` 的 Build 之前，`continue-on-error: true`，`data/results/` 随数据提交。
- **增量模式（2026-11-09，同日调整为小时档）**：`--days 1` 跑 **JST 今天 + 昨天**（滚动窗口，跨零点 / 漏抓场次自动补），`--settle-min 10` 要求开赛满 10 分钟，`--min-pop-ratio` 可调人气覆盖阈值（默认 0.8）。定时调度在 **GitHub Actions** `.github/workflows/results-intraday.yml`：cron `0 0-12 * * *`（UTC 整点 0–12 时 = 北京 8:00–20:00 每 1 小时），共用 `concurrency: group: pages`，`workflow_dispatch` 可手动触发。步骤 = 采集 → `src/verify-results.js` 全库体检 → 按 `.results-dirty` 决定是否 build / commit `data/results/` / 部署 Pages → 日志 artifact + Gate 告警。GitHub cron 排队可能延迟，靠滚动窗口 + 开赛时间 + 幂等兜住。欧美源拆到独立档 `.github/workflows/results-intraday-rp.yml`（cron `0 0,6,12 * * *` = 北京 8/14/20 点每 6 小时，同 `--days 1` 口径），此前同档混跑 30 分钟一版。
- **完整性校验（`src/lib/result-completeness.js`，纯本地）**：判 `partial` 的条件 = 结果为空 / 无数字着顺 / 名次缺号 / 结果行数 < 出馬表头数−2（只放前三名）/ 最大着顺明显不足 / 数字名次行的人气覆盖率 < 80%。`partial` **不入库**，下一轮自动重抓；已落盘缓存也要通过同一校验才算幂等命中。`除 / 中 / 失 / 取 / 止` 合法且不要求人气。
  - **同着（关键口径）**：日本赛马并列第 N 着 c 匹时下一着顺为 N+c（如 4 着并列两匹 → 没有 5 着、下一名 6 着），这是合法跳号。名次缺号用「游标」判定：`cursor=1`，读到名次 r 的计数 c 后 `cursor += c`，只有游标落在计数为 0 的名次才算缺号。初版用 `1..maxRank` 全覆盖判断，曾把 17 场同着误报为半截结果，已修正。
  - 入库记录带 `completeness` 指标；`src/verify-results.js` 用同一规则扫描全库体检，CI 每轮调用。有新入库写 `.workbuddy/imports/.results-dirty`，CI 据此决定是否 build / 部署（本地手动跑时也可据此重建预览）。

## 11.1 欧美源结果层（Sporting Life，2026-11-09）

- **`src/lib/sl-result.mjs` + `src/collect-results-rp.js`**，落 `data/results/{date}/rp-{trackId}.json`（`rp.race.result/v1`）。链路 = 日级 `/racing/results/{date}` 枚举（1 请求/天，`race_stage` 为 WEIGHEDIN/RESULT）→ 单场四段 URL（1 请求/场）→ `pageProps.race.rides[]` 的 `finish_position` 全序 + `cloth_number` 直接对齐本地 `num` → `betting.current_odds` 分数赔率换算 `1..N` 人气（同赔率并列跳号；`No Forecast Available.` 场次人气留空）→ 完整性校验 → 落盘。`build.js::resultsOf()` 的 `raceKey|num` 无需改动：RP 的 raceKey 就是 SL race id；实测 11-08 本地 112 个 raceKey 与日级列表 **112/112 命中**。
- **简化点（相对日本源）**：结果页自带马号与赔率，省掉「出馬表关联」的 1 请求/场（2 → 1 请求/场）；无需 race_id 构造、JBIS 当日页「回/日」、三套 HTML 模板、EUC-JP 解码与代理；`__NEXT_DATA__` 是 UTF-8 JSON。`--no-index` 可再省掉日级请求，纯本地卡片 + `startTimeInstant` 判定已开赛（但对未完赛场次会多发单场请求）。
- **异常态（精确分类）**：单字与中文全称/说明/配色统一在 `src/lib/abnormal-finish.js`。判定严格分层：`ride_status=NONRUNNER→除(除外)` → `casualty.reason`（`PulledUp→中(中止)`、`Disqualified→失(失格)`、`Fell/UnseatedRider/BroughtDown/SlippedUp→落(落马)`、`Refused/RanOut→止(拒跳)`）→ `ride_description` 关键词（`Withdrawn→取`、`pulled up→中`、`fell→落`…）→ 都无则 `未(未完赛，源站未公布原因)`。旧版把 `Fell` 误标成「失格」、把无原因一律标成「中止」，已修正；`--recheck-abnormal` 只重抓历史含异常态场次做升级（不全量重跑）。每条 runner 存 `abnormalReason`，前端 tooltip 展示依据。`NONRUNNER` 不进 runners（记在 `nonRunners`），故 `heads` = 实际 RUNNER 数。SL 只有整场 `winning_time`（仅 1 着有值）、`tote_win` 派彩，无逐匹完走时间/着差/馬体重。
- **校验口径（含一次误判修正）**：SL `WEIGHEDIN` 是终态，`finish_position=0` 是合法异常态（法国快步赛失格马 `casualty={}` 也记 0，`ride_count` 与 `rides.length` 一致），**不能按完赛比例判半截结果** —— 首版用 `minFinishRatio=0.8` 误拦了 102 场（多为 FR trot），已改为「结果表 `rides.length` vs 本地卡片 `runners.length`」防御。`checkCompleteness` 只新增 `requirePop`（无赔率场次只校验着顺），`minFinishRatio` 保留为可选参数但两个源都不启用；`verify-results.js` 按 schema 自动切换，日本源默认行为不变。`favourite` 与赔率最低者（1 番人气）交叉校验，不一致只告警。

