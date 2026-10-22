# 出走表（Race Entries）设计

从 JBIS 赛历抓取「出馬表」（出走表），按 **中央/地方 × 场 × 父 / 父父 / 母父 / 比赛格** 组合筛选、分组与导出。

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
_site/excel/races-{ISO周}.xlsx            # 每周工作簿
```

扁平行字段：`date weekday scope track venue raceNo startTime raceName klass klassGroup grade surface distance heads frame num horseId horseName sex age color jockey weight trainer belongs owner breeder sire sireSire dam bms raceKey recent[]`。

XLSX 由 `src/lib/xlsx.js` 零依赖写出（ZIP store + inlineStr），Excel / LibreOffice / openpyxl 均可读。

## 6. 页面（`site/index.html` + `site/app.js`）

- 日期 chips：默认最新比赛周，可多选；
- 区分 / 场 / 比赛格 chips（计数，无数据置灰）；
- 父 / 父父 / 母父 下拉（按入头数排序，取前 400）；
- 关键字过滤；分组视图（父 / 父父 / 母父）；
- CSV 导出（UTF-8 BOM）与每周 Excel 下载；
- 深链：`?group=sire|sireSire|bms`。

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
- 无 枠番 / 生産牧場 / 父父 / 胜负用时；体重为英石-磅换算值。
- US 场的 Woodbine 实际在加拿大（SL 标 USA），时区覆写为 America/Toronto。
