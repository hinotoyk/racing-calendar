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
| 视频 | YouTube 搜索页解析（无 API key，src/global/video.mjs），按场缓存 `data/global-graded/video-cache.json`；UI 另给 YT/X 检索跳转兜底 |

## 数据流

```
既有采集器（不重写）                    过滤/归一/标注                 交付
collect-races.js (JBIS 日本)   ─┐
collect-sources.js (8 个海外源) ┴→ data/races/*.json.gz ──→ src/global/collect.mjs ──→ data/global-graded/graded.json
                                                          （gradeOf + countryOf + diFlags）      ↓
src/global/server.mjs (127.0.0.1:9094)  ←── site/global-graded.html / .js
```

- 海外源与国家码对照（实测）：racingpost→GB/IE/FR/HK/SA/AE/US、racingaustralia→AU、
  loveracing→NZ、sanisidro+laplata→AR、turfeonline→BR、teletrak→CL、tjk→TR。
  映射单源：src/global/config.mjs `COUNTRIES`。
- `graded.json` schema：`global.graded/v1`，races[] 带 runners[]（马名/骑手/调教师/父/父父/母父/di 标注），
  顶层 counts/countries/countryMeta 供 UI chips。

## 用法

```bash
npm run graded:collect   # 扫描现有 data/races → graded.json（秒级，可反复跑）
npm run graded:fetch     # = --fetch：先跑日本+海外既有采集器刷新原始数据，再扫描（分钟级）
npm run graded:serve     # 起 9094 API+静态服务 → http://127.0.0.1:9094/global-graded.html
```

页面控件：
- **↻ 重新检索全部比赛**：POST /api/collect 后台跑 `graded:fetch`，轮询 /api/status，完成后自动重载。
- 地区 tabs：全部 / 日本 JRA / 日本 NAR / 海外；国家 chips（带计数，点击筛选）。
- 级别 chips：G1…Jpn3 多选；血统按钮：全部血统 / **DI 直系** / **DI 母父**；马名搜索框。
- 视频列：▶解析（调 /api/video，YouTube 首个结果，缓存）+ YT/X 检索跳转兜底。

## 已知边界（独立成项目前的待办）

1. **曾孙代**：runners 只有父/父父两级父链，DI 曾孙（父父父=DI）需接 netkeiba 血统页三级解析（enrich 阶段）。
2. **法国速步（trot）**：Vincennes 的 Attele Group 3 会按赛名命中收录，血统过滤天然排掉，级别层面暂不区分。
3. **南非/阿联酋**：源在 racingpost（SAF/UAE），近期无重赏赛日则计数为 0。
4. **只走出走表**：当前数据是 entries（非结果）；成绩/着顺接入复用主站 collect-results 系即可。
5. 视频解析依赖 YouTube 搜索页结构，风控/改版时 UI 自动退化为检索跳转。
