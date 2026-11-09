# 表头字段对照（显示文案 ↔ 数据字段 ↔ 数据源原名）

用途：统一译名时按这张表核对。**数据字段（key）是唯一契约**，改显示文案不影响采集/存储。

数据来源两位：**JBIS**（中央 JRA / 地方 NAR）、**Racing Post**（海外）。派生 = 本项目计算，无日文原名。

> 2026-11-07 已按定稿译名统一全站（主站 PC 表 / 手机卡片 / 分享卡两版式 / 兄弟站嵌入 / Excel）。下表「现行文案」即当前生效值。

---

## 1. 数据字段总表

### 比赛级

| 数据 key | 数据源原名 | 含义 | 现行文案 |
|---|---|---|---|
| `date` | —（采集日期） | 比赛日 | 日期 |
| `dateLabel` | —（派生） | 月-日短标签 | 不单独出现 |
| `weekday` | —（派生） | 星期（日文单字） | 曜日 |
| `scope` | 区分（JBIS 场地归属） | 中央 / 地方 / 海外 | 区分 |
| `country` | —（派生） | 国家码 | — |
| `track` | 競馬場コード | 场地码（3 位） | — |
| `venue` | **競馬場** | 场地名 | 竞马场（合并列叫「场次」） |
| `raceNo` | **R** | 第几场 | R |
| `raceName` | **レース名** | 比赛名（原始，含「サラ系…」前缀） | 比赛 |
| `klass` | **競走条件**（归一化） | 具体格：新馬 / 未勝利 / 1勝 / 2勝 / 3勝 / OP / GⅠ / L / 特選… | 比赛条件 |
| `klassGroup` | —（派生） | 粗分组：新馬 / 未勝利 / 1勝 / 重賞 / OP / 障害 / 一般 | 分组 |
| `level` | **格**（重赏级别） | 无级别 / GⅠ / GⅡ / GⅢ / L / OP / 地方重賞… | 级别 |
| `grade` | **格**（原始标记） | 原始级别码 | — |
| `surface` | **芝ダ** | 场地类型 | 赛道 |
| `distance` | **距離** | 距离（米） | 距离 |
| `heads` | **頭数** | 出走头数 | 头数 |
| `startTime` | **発走時刻**（当地） | 当地开跑时间 | 当地时间 |
| `startTimeTz` | —（派生） | 当地时区 | — |
| `startTimeInstant` | —（派生） | 带时区的绝对时刻 | 北京时间（换算后） |
| `raceKey` | —（派生） | 比赛唯一键 | — |
| `raceUrl` | —（派生） | 出馬表原页 | — |
| `source` | —（派生） | 采集源 | 源 |

### 出走马

| 数据 key | 数据源原名 | 含义 | 现行文案 |
|---|---|---|---|
| `horseId` | —（派生） | 马 ID | — |
| `horseName` | **競走馬名** | 马名（片假名） | 马名 |
| `horseNameEn` | —（派生/RP） | 英文名 | — |
| `horseCountry` | **生産国** | 出生国 | — |
| `frame` | **枠番**（地方有时只写「枠」） | 枠番 1–8 | 枠番（合并列叫「马号」） |
| `num` | **馬番** | 马号 | 马号 |
| `sex` | **性齢**（前半） | 牡 / 牝 / セ | 性龄 |
| `age` | **性齢**（后半） | 年龄 | 性龄 |
| `color` | **毛色** | 毛色 | 毛色 |
| `silk` | **勝負服** | 彩衣图路径 | 彩衣 |
| `jockey` | **騎手** | 骑手 | 骑手 |
| `weight` | **斤量** | 负重（kg） | 负重 |
| `trainer` | **調教師** | 练马师 | 练马师 |
| `belongs` | **所属** | 美浦 / 栗東（地方为厩舍） | 所属 |
| `owner` | **馬主** | 马主 | 马主 |
| `breeder` | **生産牧場** | 生产牧场 | 生产牧场 |
| `recent1` | **1走前** | 上一走 | 1前走 |
| `recent2` | **2走前** | 前二走 | 2前走 |
| `recent3` | **3走前** | 前三走 | 3前走 |

### 血统

| 数据 key | 数据源原名 | 含义 | 现行文案 | 备注 |
|---|---|---|---|---|
| `sire` | **父** | 父马 | 父 | 大马名带 `(USA)` 国码 |
| `sireSire` | **父父** | 父之父 | 祖父 | 原「父父」，2026-11-07 定为「祖父」 |
| `dam` | **母** | 母马 | 母 | |
| `bms` | **母父** | 母之父（外祖父） | 母父 | 缩写来自 **B**rood**m**are **S**ire |

---

## 2. 各视图现行文案

### 2.1 主站出走表 · PC 表格（`site/app.js` `COLS`）

顺序：竞马场 ｜ R ｜ 比赛 ｜ 距离 ｜ 当地时间 ｜ 北京时间 ｜ 马名 ｜ 枠番 ｜ 马号 ｜ 性龄 ｜ 彩衣 ｜ 负重 ｜ 骑手 ｜ 练马师 ｜ 父 ｜ 祖父 ｜ 母 ｜ 母父

| 显示 | 字段 |
|---|---|
| 竞马场 | `venue` |
| R | `raceNo` |
| 比赛 | `raceName`（经 `cleanRaceName` 清洗） |
| 距离 | `surface` + `distance`（同列：芝/ダ色点 + 距离） |
| 当地时间 | `startTime`（默认隐藏） |
| 北京时间 | `startTimeInstant` 换算 |
| 马名 | `horseName` |
| 枠番 / 马号 | `frame` / `num` |
| 性龄 | `sex` + `age` |
| 彩衣 | `silk` |
| 负重 | `weight` |
| 骑手 | `jockey` |
| 练马师 | `trainer`（默认隐藏） |
| 父 / 祖父 / 母 / 母父 | `sire` / `sireSire` / `dam` / `bms`（祖父、母默认隐藏） |

比赛分隔行：`福島1R 比赛名 11-07 08:45 北京 泥1700 · 当地时间 09:45 · 15頭`

### 2.2 主站出走表 · 移动端马卡片（`site/app.js` `mbCardHtml`）

| 显示 | 字段 |
|---|---|
| 练马师： / 父： / 祖父： / 母： / 母父： | `trainer` / `sire` / `sireSire` / `dam` / `bms` |
| （无标签） | 彩衣 `silk`、马号 `num`、枠色片 `frame`、马名 `horseName`、骑手 `jockey`、负重 `weight`、性龄 `sex`+`age` |

### 2.3 分享卡 · 紧凑一览（`site/share.js` `drawDense`）

固定列：北京时间（或当地时间）｜ 场次 ｜ 比赛 ｜ 赛道 ｜ 马号 ｜ 彩衣（有图才出现）｜ 马名 ｜ 性龄 ｜ 骑手
附加列（`EXTRA_COLS`，按勾选顺序）：负重 ｜ 练马师 ｜ 父 ｜ 祖父 ｜ 母父 ｜ 母 ｜ 马主 ｜ 生产牧场

### 2.4 分享卡 · 逐场分卡（`site/share.js` `drawCards`）

无时间列（时间在块头）：块头两行 = `比赛名 + 级别徽章` / `场R · 赛道 · 当地时间（可选） · 北京`
列：马号（单色块：色=枠番、字=马号）｜ 彩衣 ｜ 马名 ｜ 性龄 ｜ 骑手 ｜ 附加列（同 2.3）

### 2.5 兄弟站嵌入组件（`site/embed/entries-table.js` `COLS_TIERS`）

三档列集，label 相同：

| 显示 | 字段 |
|---|---|
| 北京时间 | `startTimeInstant` 换算 |
| 场次 | `venue` + `raceNo`（`R` 弱化） |
| 比赛 | `raceName`（清洗 + 级别徽章） |
| 赛道 | `surface` + `distance`（不带 m） |
| 马号 | `frame` + `num`（单色块：色=枠番、字=马号） |
| 马名 / 性龄 / 负重 / 骑手 | 同名 key |
| 母父（≥1180px）/ 练马师（≥1500px） | `bms` / `trainer` |

移动端（<720px）为逐场卡片：无表头，条头 `场次 + 北京时间`，行内 `马名 / 性龄+负重`、`骑手 / 母父`。

### 2.6 Excel 导出（`src/build.js` `COLS`）

日期 ｜ 曜日 ｜ 区分 ｜ 竞马场 ｜ R ｜ 当地时间 ｜ 比赛 ｜ 比赛条件 ｜ 分组 ｜ 赛道 ｜ 距离 ｜ 头数 ｜ 枠番 ｜ 马号 ｜ 马名 ｜ 性龄 ｜ 毛色 ｜ 骑手 ｜ 负重 ｜ 练马师 ｜ 所属 ｜ 马主 ｜ 生产牧场 ｜ 父 ｜ 祖父 ｜ 母 ｜ 母父 ｜ 1前走 ｜ 2前走 ｜ 3前走 ｜ 源 ｜ 当地时间(基准时刻)

### 2.7 分享卡 · 批量编辑表格（`site/share-grid.js`）

比赛头行：比赛 ｜ 级别 ｜ 日期 ｜ 竞马场 ｜ R ｜ 赛道 ｜ 距离 ｜ 当地时间
出走马行：枠番 ｜ 马号 ｜ 马名 ｜ 性龄 ｜ 骑手 ｜ 负重 ｜ 练马师

---

## 3. 仍存在的合并列（不是同一字段的多译名）

| 显示 | 实际字段 | 说明 |
|---|---|---|
| 场次 | `venue` + `raceNo` | 分享卡 / 嵌入组件把「场地 + R」合并成一格（内容如 `京都11R`），表头用「场次」 |
| 距离 | `surface` + `distance` | 主站 PC 表一列同时显示芝/ダ与距离，表头沿用「距离」 |
| 马号 | `frame` + `num` | 分享卡 / 嵌入组件的单色块：色 = 枠番、块内数字 = 马号，列名统一用「马号」 |

## 3.5 结果层字段（赛后从 `data/results/` 合并）

| 显示 | 字段 | 说明 |
|---|---|---|
| 着顺 | `finish` | 数字名次；异常态单字 `中 / 失 / 落 / 除 / 取 / 止 / 未`（口径见 `src/lib/abnormal-finish.js`）；赛前无值显示空 |
| 异常态说明 | `resultLabel` / `resultDesc` / `resultAbClass` / `resultReason` | 中文全称 / 含义 / 徽标配色 / 判定依据，由 build 按单字生成；主表直接显示全称，hover 显示含义与依据 |
| タイム | `resultTime` | 源原样（`1:01.1`），着顺列 tooltip，不数值化 |
| 着差 | `resultMargin` | 源原样（`アタマ` / `1.1/4`） |
| 最终人气 | `resultPop` | 赛后确定的单胜人气（整数），主表与 Excel 显示；1 番人气高亮。与「前走」的 `lastPop` 不同 |
| 単勝 / 後3F / 馬体重 | `resultOdds` / `resultLast3f` / `resultBody` | 结果与出走表字段区分，避免覆盖 `weight` 等既有列 |
| netkeiba 锚点 | `nkRaceId` / `nkId` | 场次级 / 马匹级关联键，供跨源校验与调试 |

主表显示 `finish`（1 着加红加粗）；异常态显示**中文全称徽标**（中止 / 失格 / 落马 / 除外 / 取消 / 拒跳 / 未完赛），按类别配色，hover 给出含义与判定依据，Excel 也写全称。完整结果另出 `derived/results-{date}.json`。合并键为 `raceKey|num`。

**异常态口径（单一出处 `src/lib/abnormal-finish.js`）**：这些是合法着顺，不是缺数据。日本源取 netkeiba 着顺栏原值；欧美源由 Sporting Life 严格分层判定 —— ① `ride_status=NONRUNNER`→`除`；② `casualty.reason`（`PulledUp→中`、`Disqualified→失`、`Fell/UnseatedRider/BroughtDown/SlippedUp→落`、`Refused/RanOut→止`）；③ 无 reason 时用 `ride_description` 关键词（`Withdrawn→取`、`pulled up→中`、`fell/unseated→落`、`refused→止`、`disqualified→失`）；④ 两者都无 → `未`（未完赛、源站未公布原因），**不臆断为中止或失格**。法国快步赛大量 `finish_position=0 + casualty={}` 属于第 ④ 类（实务上多为失格，但 SL 不给依据）。每条结果存 `abnormalReason`，tooltip 可看到具体来源（`casualty.reason=PulledUp` / `ride_description: ...` / `Sporting Life 未公布原因`）。

这类马**仍可能有最终人气**：人气来自赛前 SP 赔率排序，与是否完赛无关。校验（`checkCompleteness`）把它们单独计数，不算名次缺号、也不要求人气；`WEIGHEDIN` 终态下即使完赛马占比不足 80% 也不判半截结果。

## 4. 改文案的位置（改完 `npm run build`）

- `site/app.js`：`COLS`（PC 表头）、`mbCardHtml`（手机卡片标签）、`PED_TAG_LABEL`、筛选器 label
- `site/index.html`：静态 `<thead>`（首屏骨架）、搜索 placeholder、手动添加比赛的表单标签
- `site/share.js`：`EXTRA_COLS`、`drawDense` / `drawCards` 的 `cols.push`、时间开关 label、块头 meta 文案
- `site/embed/entries-table.js`：`COLS_TIERS`（三档共 11 个 label）
- `site/share-grid.js`：`RACE_FRONT_COLS` / `RACE_BACK_COLS` / `RUN_COLS`
- `src/build.js`：`COLS`（Excel 表头）+ `pivot()` 的汇总表头
