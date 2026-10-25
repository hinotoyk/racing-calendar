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

礼貌抓取：间隔 `SITE.delayMs`（1.2s），UA 标识用途；单周约 250–400 次请求。

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
- 场地 chips 默认 JRA（当日无中央出走表时退回 NAR；全部 = 清空多选）；竞马场 / 级别 chips（计数，无数据置灰），级别展示名「无级别」→「普通比赛」；
- 父 / 父父 / 母父 下拉（按入头数排序，取前 400）：按 canonical 合并同名马——两源写法不同（JBIS「Saxon Warrior(JPN)」/ RP「Saxon Warrior」、JBIS「ディープインパクト」/ RP「Deep Impact」）归为一条，展示名取行内最多写法，搜索匹配全部别名（`src/lib/horse-name.mjs` 归一 + `derived/horse-aliases.json` 别名）；过滤、分组、Excel 透视同口径，表格/CSV 保留原始写法；
- 关键字过滤；分组下拉与血统下拉同款（父 / 父父 / 母父 / 騎手 / 調教師，空 = 不分组）；
- 前端内存分页：PC 一页 100 条、mb（<768px）一页 20 条，每页条数按设备固定不可选；页码按钮式分页条（移植 yunji-web races.html `.pager`），768px 断点 matchMedia 实时切换（老 Safari addListener 兜底）；筛选条件变化归第 1 页；分组视图整组分页——页内按整组装填，装不下整组移到下一页（最后一组不截断），单组超过一页容量才组内截断，跨页组自动重复组头，组头 `tr.sub` 不占条数；
- CSV 导出（UTF-8 BOM）与每周 Excel 下载；
- 深链：`?group=sire|sireSire|bms|jockey|trainer`。

## 7. 已知限制

- 出馬表只在开赛前 1–2 日存在，赛后即被结果页替换。
- 枠順確定晚于出馬表，早抓的马番可能变动；重跑覆盖为最新。
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

- **选择（行级）**：`#pick-mode` 开启勾选模式，复选框按行（馬）勾选，行键 = 比赛 + 馬番（`rowKeyOf`）；分享卡只包含勾选的行，同一场比赛的勾选行归入同一块（不整场塞入）。勾选框绝对定位在首格左侧预留区，不影响行内容排版。浮动条：已选 N 頭（点击展开上拉预览列表：馬名 · 场R · 比赛名，逐条可取消）+ 生成分享卡 + 清空；「完成勾选」在有勾选时直接进分享卡页。`?pick=demo` / `?share=demo` 为视觉自检深链（demoPick 按级别优先 G1→地方重赏→G2→G3→L 各取一场并展开为行级勾选）。
- **编辑**：块可删除 / 上下移；「＋ 手动添加比赛」表单（日期 / 场 / R / 比赛名 / 级别 / 芝ダ / 距离 / 当地时间 / 时区 + 出走馬文本区每行 `枠 番 馬名 性齢 騎手`，性齢/騎手可省略，全角数字自动归一）；北京时间由 startTimeInstant 现算，跨日自动带 MM-dd。
- **列配置**：附加列 chips（斤量 調教師 父 父父 母父 母 毛色 所属 馬主 生産牧場），默认斤量+父+母父；列宽按内容实测（每场独立），余量均摊占满行宽，超限按余量收缩 + 单元格省略号。配置存 localStorage（`rc.share.cols.v3` / `rc.share.scale`），追加列顺序恒按 EXTRA_COLS 排列。
- **出图**：纯 canvas 零依赖（无 html2canvas），默认 2×（≈1976px 宽，可选 1×/3×），「导出 PNG」或「复制到剪贴板」（ClipboardItem，需安全上下文）。
- **版式 v1.0.0**：报头「共 N 頭出走 M 场」（右上角不放日期信息）；卡内按 天 / 场地 分组标题（如「10月23日（金）」+ 场地小标题）；块头「场地NRR 比赛名」同行同字号 + **距离徽章**（ダ1900m）+ 级别徽章，标题与徽章实测避让右侧双时钟（海外 UTC+1 时区标更宽，放不下徽章则不画）；页脚左下两行（RACING CALENDAR / 「数据仅供个人学习、研究 · 赛马应援 · 非商业用途 · v1.0.0」）+ 右侧完整链接，QR 码暂注释（drawQR 保留随时可恢复）；附加列默认 斤量+父+母父（偏好键 rc.share.cols.v3），騎手在性齢后、追加列前。
- **新标签页**：「生成分享卡」/「完成勾选」把载荷写 sessionStorage（`rc.share.payload`，新标签页自动复制 opener 的 sessionStorage）后 `window.open('?share=open')`；新页 main() 读取并渲染，返回列表即关窗。
- **勾选数据源**：`rowsForPick()` 汇总**全部已加载日期**的行（不受当前筛选影响）——清空条件换场地继续勾选，之前勾的馬仍在卡里；卡片内比赛按日期升序、同日按数据序。
- **品牌**：顶部 6px 青绿条；页脚 RACING CALENDAR 字标 + `hinotoyk.github.io/racing-calendar` + QR 码（`site/vendor/qrcode.js`，MIT · Kazuhiko Arase，typeNumber 自动 / ECC M，`isDark` 逐模块画进 canvas）。
- **设计约定**：与主站 style.css 同 token（#0aa7a0 × shadcn Neutral，仅亮色）；枠番用 JRA 官方 8 枠色芯片（1白2黒3赤4青5黄6緑7橙8桃），级别徽章沿用主站 JBIS 配色；比赛名 / 距离 / 当地·北京时间编码进比赛块头（不逐行重复），行列为 枠 / 番 / 馬名 / 性齢 / 騎手（+ 附加列）。设计稿原型：`design/share-card.html`（样例数据由 `design/_extract.mjs` 生成）。

> 实现教训：canvas 重设 `width/height` 会重置画布状态（含变换矩阵）——必须先设尺寸再 `setTransform(scale)`，否则导出 PNG 内容缩在左上角、其余全透明。
