# 全球重赏收集（探索分支 feat/global-graded）

> 定位：探索任务「全球重赏收集」——只关注 G1/G2/G3 + JG1/JG2/JG3 的国际重赏。
> 做得好就独立成项目；在此之前**禁止合并进 main**（见 §分支策略）。

## 分支策略

- 分支 `feat/global-graded` 独立演进，**禁止合并到 main**。
- 守卫（本机已启用）：
  - `cp scripts/hooks/reference-transaction scripts/hooks/pre-push .git/hooks/ && chmod +x .git/hooks/*`
    —— 钩子装在 `.git/hooks/`（仓库外、跨分支常驻；**不要**用 `core.hooksPath=scripts/hooks`，
    那会让钩子文件随 feat 分支消失、切回 main 即失守）。
  - `reference-transaction`：main 引用更新时检查新指向是否含 feat/global-graded 提交，
    含则拒绝 —— 单点覆盖快进合并、真合并、pull（git 2.55 实测 pre-merge-commit
    触发时 MERGE_HEAD 尚未写入，拿不到合并来源，不可依赖）。
  - `pre-push`：push 的 main 里含该分支提交 → 拒绝（推送层兜底）。
- 覆盖不到的口子：squash merge、cherry-pick 到 main 产出新 sha、祖先关系不成立，
  钩子层无法识别，靠 review 把关；独立建仓后应开 GitHub 分支保护规则双保险。
- 版本管理沿用 git；依赖管理沿用根 package.json（本分支新增能力全部零依赖，node ≥ 18）。

## 范围

| 维度 | 口径 |
| --- | --- |
| 级别 | 日本：`gradeTag` ∈ G1-3 / JG1-3 / Jpn1-3（Jpn 开关 `INCLUDE_JPN`，src/global/config.mjs）；海外：赛名/Class 匹配 Group/Groupe/Grade N、(G1)-(G3) |
| 地区 | 日本（JRA 10 场 / NAR 地方）+ 海外 13 国：阿根廷、澳大利亚、巴西、智利、法国、英国、中国香港、爱尔兰、新西兰、南非、土耳其、阿联酋、美国（截图定稿 2026-11-19） |
| 血统 | 只收 Deep Impact：**直系**（父=DI 或 父父=DI，即儿子/孙子）与**母父**（bms=DI，即 DI 女儿之子），UI 按钮切换 |
| 名次 | 全部出走马带 `rank`（1=冠军）/ `finishRaw`（中/除/失/取…）；UI 可只看 1着 |
| 视频 | YouTube 搜索页解析（无 API key，src/global/video.mjs），按场缓存 `data/global-graded/video-cache.json`；UI 另给 YT/X 检索跳转兜底 |

## 数据流

```
日本：JBIS 月赛历(带 gradeTag) ─→ 只采重赏赛日 ─┐
   collect-races.js --dates --tracks --no-silks │
   （过往赛日走 /race/result/ 结果页模板，自带着順+父母）
                                                ├→ data/races/*.json.gz ─┐
海外 7 国（GB/IE/FR/HK/SA/AE/US）：             │                        │
   SL 日结果页 1 请求/天（赛名自带 Group/Grade）  │                        │
   命中重赏逐场取全序（骑手/调教师/着顺）          │                        │
   血统：SL 马匹 profile（sire/damsire，名字级）  │                        │
   → data/global-graded/sl/<date>.json          ┘                        │
                                                         src/global/collect.mjs
海外 3 国（TR/AR×2）：探针先行 → 只对重赏日跑采集器          （gradeOf+countryOf
   country-probe.mjs：tjk 节目CSV klassCode、               +diFlags+结果join）↓
   sanisidro 节目页 premios、laplata 月历+节目页      data/global-graded/graded.json
                                                                ↓
                                              server.mjs (127.0.0.1:9094) ← site/global-graded.html/.js
```

- 海外源与国家码对照（实测）：sportinglife/racingpost→GB/IE/FR/HK/SA/AE/US、
  racingaustralia→AU、loveracing→NZ、sanisidro+laplata→AR、turfeonline→BR、
  teletrak→CL、tjk→TR。映射单源：src/global/config.mjs `COUNTRIES`。
- `graded.json` schema：`global.graded/v1`，races[] 带 runners[]（马名/骑手/调教师/父/父父/母父/rank/di 标注），
  顶层 counts/countries/countryMeta/years 供 UI chips；SL 文档按 raceId 与卡片数据去重（卡片行优先）。

## 回填（自然年检索的燃料）

| 命令 | 覆盖 | 机制 |
| --- | --- | --- |
| `node src/global/backfill.mjs --year 2026 --region japan` | JRA+NAR 全年 | JBIS 月赛历（每月 1 请求、自带 gradeTag）→ 只对重赏赛日×赛场跑 collect-races；过往赛日走 JBIS 结果页（着顺/父母直印，不需要 netkeiba 结算层） |
| `... --region overseas` | 海外 10/13 国 | ① SL 日结果页直扫 7 国（1 请求/天 + 每重赏场 1 请求，血统 profile 走 rp-horse.json 共享缓存）；② tjk/sanisidro/laplata 探针找重赏日 → 只对重赏日跑采集器 |
| `node src/global/overseas-backfill.mjs --year 2026 [--from --to --no-ped]` | SL 7 国单跑 | 幂等续跑：`data/global-graded/sl/<date>.json` 存在即跳过（空文档=无重赏日负缓存） |
| `node src/global/country-probe.mjs --source tjk --year 2026`（再 `--collect`） | TR/AR 单跑 | 探针结果落 `data/global-graded/probe/<source>.json`，`--list` 汇总 |

全部幂等可续跑；重复执行只补增量。

## 用法

```bash
npm run graded:collect   # 扫描现有数据 → graded.json（秒级，可反复跑）
npm run graded:fetch     # = --fetch：先跑日本+海外既有采集器刷新近期数据，再扫描
npm run graded:serve     # 起 9094 API+静态服务 → http://127.0.0.1:9094/global-graded.html
```

页面控件：
- **↻ 重新检索全部比赛**：POST /api/collect 后台跑近期刷新，完成后自动重载。
- **⏳ 回填日本全年 / 🌍 回填海外全年**：POST /api/backfill（分钟~小时级，同一任务槽）。
- 年份 chips（自然年 1/1-12/31）；地区 tabs：全部 / 日本 JRA / 日本 NAR / 海外；
  国家 chips（带计数）；级别 chips：G1…Jpn3 多选；名次筛选：全部 / **只看 1着** / 1-3着；
  血统按钮：全部血统 / **DI 直系** / **DI 母父**；马名搜索框。
- 视频列：▶解析（调 /api/video，YouTube 首个结果，缓存）+ YT/X 检索跳转兜底。

## 已知边界（独立成项目前的待办）

1. **海外历史回填的「DI 孙子」**：SL 马匹 profile 的相对马 id 恒等于自身（源数据缺陷），
   父父无法二跳链查 —— 海外 SL 侧直系只判「父=DI」，孙子判定仅日本（JBIS 卡片带父父）可靠。
2. **AU/NZ/CL/BR 历史回填**：racingaustralia 每页 5s 延迟、teletrak 是 PDF、
   turfeonline 索引可分页全扫（代价 1 请求/赛马日）、loveracing 历史走月历页 ——
   下一阶段补进 country-probe.mjs。BR 近期数据已由 turfeonline 采集器覆盖。
3. **法国速步（trot）**：Vincennes 的 Attele Group 赛按赛名命中收录，血统过滤天然排掉 DI。
4. **曾孙代**：需三级父链（父父父=DI），留 enrich 阶段接 netkeiba 血统页。
5. 视频解析依赖 YouTube 搜索页结构，风控/改版时 UI 自动退化为检索跳转。
6. TJK 的 A1-A3 级（土耳其重赏子级）未收录 —— 只认 G1-3，宁缺勿错。
