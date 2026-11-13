/* ============================================================
 * entries-table.js —— Racing Calendar 出走表 嵌入式组件（零依赖 · 单文件）
 * ------------------------------------------------------------
 * 定位（2026-11-02 与云迹定稿）：本仓库对外发布的「出走表结果组件」，供
 *   种马档案站（yunji-web / kzn-web …）一行挂载——对齐兄弟站统一引用模式
 *   （jbis-sire-rank-history embed/sire-rank-chart.js 同款）：宿主给
 *   一个挂载点 + 种马名，得到一个简洁的「该種牡馬产驹近期出走」结果视图。
 *   不照搬主站全功能页（无多维筛选卡/分享卡/CSV/Excel），只出结果。
 *
 * 视图（v2.7.0）= **同一份数据的双形态 + 三档宽度自适应**（2026-11-11 更新）：
 *   · **计数口径 = 未来（含今天）**（2026-11-11）：头部「共 X 頭 / N R」与分类 chips 的计数
 *     只统计未来（含今天）的出走——出走表是前瞻视图，最近一周折叠区只是兜底，
 *     不该把头部数字撑大；chips 过滤同时作用于主视图与折叠区。
 *   · 卡片态（2026-11-11）：条头时间补「北京时间」小标（裸 13:55 会被读成当地时间）；
 *     比赛名行的赛道距离不再 margin-left:auto 推到最右（短名时中间一大段空白）；
 *     斤量从第一行性齢后挪到第二行騎手后（孤零零一个数字读不出含义）；
 *     性齢的 セ/セン 显示为汉字「骟」（骟3），卡片与宽表同口径。
 *   宽容器再按宽度分三档（27 寸屏「太空洞」的反馈）：
 *   · 头部带「全部 / JRA·中央 / NAR·地方 / 海外」分类 chips（2026-11-07）：纯前端过滤，
 *     计数实时显示，**四个恒定展示**（0 条的也留着，点进去给空态）；状态存在挂载点上
 *     （不写存储，刷新回到全部）。
 *   · 头部带「全部 / JRA·中央 / NAR·地方 / 海外」分类 chips（2026-11-07）：纯前端过滤，
 *     计数实时显示，**四个恒定展示**（0 条的也留着，点进去给空态）；状态存在挂载点上
 *     （不写存储，刷新回到全部）。
 *   · 档位（2026-11-13 用户定稿）：<720 卡片；720–1179 基础十列；≥1180 加「前走」；
 *     ≥1500 再加「母父」+「調教師」。列序恒为 …騎手→母父→調教師→前走，档位只控显隐
 *     —— 超宽屏把多出来的宽度换成信息，而不是把每列拉得更空；
 *     字号/行距同步 fluid 放大（--re-k = clamp(1, w/1000, 1.3)，16px 级），密度不变但有分量。
 *   · 宽容器（≥720px，PC）= 紧凑一览式的密表：比赛级 4 列按 rowspan 合并
 *     （北京时间/场次/比赛名/赛道），逐马只占一行（马号色带·彩衣·馬名·性齢·斤量·騎手），
 *     冷灰网格（表头浅灰 + 明细线 #f0f2f4 + 结构竖线 + 极浅斑马），无外框无圆角
 *     —— 宿主卡片本身就是容器。
 *   · **马号 + 彩衣（v2.5.0，2026-11-08 用户按参考站定稿）**：马号列从「圆角小芯片」改为
 *     **满格色带**——色 = 枠番（JRA 官方 8 色）、字 = 馬番，单元格零内距、无圆角、无左右留白，
 *     上下相邻两格的颜色直接相接成一条竖带（同枠的产驹一眼连成一段）；右侧紧跟**彩衣**列
 *     （马主勝負服小图，高 19px×系数、等比、白底细描边）。参考站是「马号 彩衣」两列挨着，
 *     色带负责扫读、彩衣负责辨认马主，二者互补，不能只留其一。
 *   · **宿主联动 + 前走列（v2.6.0，2026-11-08 用户四点定稿）**：宿主可用 `host.name/horse/race`
 *     三个同步回调注入译名（港译→自译）、马匹页、比赛页（协议见 docs/DESIGN.md §10「宿主联动」）；
 *     译名与日文名同一行写作 `日文名/中文名`，**自译前置 `*`**，并在表下补一行 * 号说明。
 *     tier2（≥1500）在练马师后新增「前走」= 比赛名 · 人气 · 着顺（人气由 collect-recent-pop 从
 *     JBIS 馬頁競走成績回填，出馬表本身不含人气）。
 *   · 色带只在**确有枠番**时着色：无枠番（海外/未確定）退化为普通居中的馬番文本（不刷灰底，
 *     灰底会让整列像一堆坏掉的占位块——v2.4.0 的实测问题）；連馬番都没有时显示极淡的「–」。
 *   · 窄容器（<720px，MB）= 逐场卡片：一场一块（场次/北京时刻做条头，比赛名+赛道
 *     一行，产驹两行：马号 + 彩衣 + 馬名 + 性齢 / 騎手 + 斤量 + 母父），单列竖排。
 *   ★ 为什么不用「收列」而用「换形态」：十列压进 390px 只能靠横滑或砍列，两者都难读；
 *     卡片把「哪场 + 谁跑」摊成竖排，拇指滚动即可。
 *   ★ 断点看**组件自身宽度**（ResizeObserver），不看视口——宿主有侧栏/90% 宽/卡片内距，
 *     按视口算会误判（1024px 窗口实测曾把 11 列裁掉右半边）。
 *
 * 与 sire-rank-chart 的契约差异（有意为之）：出走表数据 = index + 逐日
 *   字典包多文件懒加载，编排成本不该转嫁给每个宿主 → 本组件自带 load()
 *   数据编排（fetch derived/index.json + derived/{date}.json 并解包），
 *   但**不写任何存储键**（对齐契约：缓存仅内存 Map，页面生命周期内）。
 *
 * 用法：
 *   <div id="entries"></div>
 *   <script src="https://hinotoyk.github.io/racing-calendar/embed/entries-table.js"></script>
 *   RC_ENTRIES_EMBED.mount(el, { base: "https://hinotoyk.github.io/racing-calendar/",
 *                                sire: "コントレイル" });
 *
 * API：
 *   RC_ENTRIES_EMBED.VERSION
 *   RC_ENTRIES_EMBED.load(base, opts)  → Promise<{dates, rows}>  数据编排（内存缓存）
 *   RC_ENTRIES_EMBED.render(el, data, opts)                      纯渲染（自适应形态）
 *   RC_ENTRIES_EMBED.mount(el, opts)   → Promise                load + render + 状态管理
 *
 * opts：
 *   base    （必填）本站根 URL，如 "https://hinotoyk.github.io/racing-calendar/"
 *   sire    （必填）種牡馬日文名（JBIS 原形；宿主从自家 config 的种马名取，
 *           与数据行 sire 字段同源同写法）。未传/空 → 不按种马筛（出全表，调试用）
 *   days    未来侧展示的有数据日期数（默认 4）；今天之前的日期收进底部
 *           <details>「最近一周」折叠区（出走表是前瞻视图，历史只做兜底可查）
 *   title   头部标题（默认 "<sire> 产驹 · 近期出走"）
 *   link    头部是否带「Racing Calendar ↗」外链（默认**不展示**；宿主显式传 true 才有）
 *
 * 数据契约 = docs/DESIGN.md §2：derived/index.json（dates 概览）+
 *   derived/{date}.json（race.rows.bundle/v1 字典包，本文件内联 unpackRows 解码——
 *   单一出处 src/lib/rows-codec.mjs，内联副本改动必须同步该文件）。
 *
 * 视觉：亮色单主题；颜色走宿主 CSS 变量（--foreground/--muted-foreground/--border/
 *   --primary/--card…，缺省回退 #0aa7a0 × shadcn Neutral 与本站同 token），
 *   与 friend-links.js 归一化变量同一做法——宿主换肤组件跟随。枠色/级别徽章 =
 *   JRA 官方枠色与 JBIS 徽章配色（数据语义，与主站 .waku/.yj-g* 同源写死）。
 * ============================================================ */
(function () {
  "use strict";

  var VERSION = "2.8.2";
  var WIDE_MIN = 720;   /* 容器宽 ≥ 此值走十列密表，否则走逐场卡片 */

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- 字典包解码（内联自 src/lib/rows-codec.mjs::unpackRows，改一处必须同步另一处） ---------- */
  function unpackRows(b) {
    var keys = b.k, s = b.s, dict = b.dict, rows = b.rows;
    var strSet = {};
    for (var i = 0; i < s.length; i++) strSet[s[i]] = 1;
    return rows.map(function (row) {
      var o = {};
      for (var i = 0; i < keys.length; i++) {
        var v = row[i];
        if (v == null) continue;
        o[keys[i]] = strSet[i] ? dict[v] : v;
      }
      return o;
    });
  }

  /* ---------- 数据编排（内存缓存；不写任何存储键） ---------- */
  var memIndex = {};   /* base → index.json */
  var memDay = {};     /* base + "|" + date → rows[] */
  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function todayBJ() {
    return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  }
  function minusDays(iso, n) {
    return new Date(Date.parse(iso + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
  }
  /* 北京时间 "11:40"（startTimeInstant 绝对时刻 → +8 格式化，口径同主站 bjOf） */
  function bjTime(instant) {
    var t = Date.parse(instant);
    if (isNaN(t)) return "";
    var d = new Date(t + 8 * 3600e3);
    return ("0" + d.getUTCHours()).slice(-2) + ":" + ("0" + d.getUTCMinutes()).slice(-2);
  }
  /* "2026-11-04" → "11月4日"（不补零，日式表头写法） */
  function mdJP(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
    if (!m) return String(date || "");
    return (+m[2]) + "月" + (+m[3]) + "日";
  }

  function loadIndex(base) {
    var key = base.replace(/\/+$/, "");
    if (!memIndex[key]) {
      memIndex[key] = fetchJson(key + "/derived/index.json").then(function (j) {
        return j && Array.isArray(j.dates) ? j : Promise.reject(new Error("index.json 契约不符"));
      });
    }
    return memIndex[key];
  }
  function loadDay(base, date) {
    var root = base.replace(/\/+$/, "");
    var key = root + "|" + date;   /* 仅作内存缓存键，不进 URL */
    if (!memDay[key]) {
      memDay[key] = fetchJson(root + "/derived/" + date + ".json").then(function (b) {
        return b && b.rows ? unpackRows(b) : [];
      });
    }
    return memDay[key];
  }

  /**
   * load(base, opts) → Promise<{dates, rows, sire}>
   * dates.future = 未来侧 days 个有数据日期；dates.past = 今天之前最近 7 个自然日
   * （对齐「最近一周」折叠区，不再把整月历史都拉下来）。rows = sire 过滤后按北京时间升序。
   */
  function load(base, opts) {
    opts = opts || {};
    if (!base) return Promise.reject(new Error("缺少 base（RC 站根 URL）"));
    var sire = String(opts.sire || "").trim();
    var days = Math.max(1, +opts.days || 4);
    var today = todayBJ();
    var weekAgo = minusDays(today, 6);   /* 含今天往前 7 个自然日 */
    return loadIndex(base).then(function (index) {
      var all = index.dates.map(function (d) { return d.date; }).sort();
      var future = all.filter(function (d) { return d >= today; }).slice(0, days);
      var past = all.filter(function (d) { return d < today && d >= weekAgo; });
      var need = future.concat(past);
      return Promise.all(need.map(function (d) { return loadDay(base, d); })).then(function (dayRows) {
        var rows = [];
        dayRows.forEach(function (rs) {
          for (var i = 0; i < rs.length; i++) {
            var r = rs[i];
            if (!sire) { rows.push(r); continue; }
            var s = String(r.sire || "").trim();
            if (s === sire || (sire && s.indexOf(sire) >= 0)) rows.push(r);
          }
        });
        rows.sort(function (a, b) {
          var ta = Date.parse(a.startTimeInstant || ""), tb = Date.parse(b.startTimeInstant || "");
          ta = isNaN(ta) ? Infinity : ta; tb = isNaN(tb) ? Infinity : tb;
          return ta - tb || (a.raceNo ?? 0) - (b.raceNo ?? 0) ||
                 String(a.venue || "").localeCompare(String(b.venue || ""), "ja");
        });
        return { dates: { future: future, past: past }, rows: rows, sire: sire,
                 base: base.replace(/\/+$/, "") };
      });
    });
  }

  /* ---------- 赛事名清洗（只影响显示，数据原文不动） ----------
   * 1) JBIS 源重复拼接（"C２二組 C２二組"）→ 取前半
   * 2) 「サラ系」品種前缀：JRA/NAR 条件名固有前缀（サラ系２歳 未勝利 / サラ系障害…），
   *    全表逐行重复、零信息量 → 删（后面的「２歳 未勝利」仍保留）
   * 3) "Race 3 - " 场次号前缀（UAE/USA 源格式）：场次号已在名首 3R 标签里 → 删
   * 4) 欧美超长冠名（赞助商名/推广语，常 40 字符以上）→ 只留赛事类型短语
   *    （"Magnet, Better. By Design Handicap Chase" → "Handicap Chase"）。
   *    日文名无空格分词、长度短，天然不受影响；≤NAME_MAX 的正式名（Mercury Stakes）也不动。
   */
  var NAME_MAX = 40;
  var TYPE_WORDS = { hurdle: 1, hurdles: 1, chase: 1, chases: 1, stakes: 1, plate: 1,
    cup: 1, trophy: 1, sprint: 1, derby: 1, oaks: 1, guineas: 1, handicap: 1,
    allowance: 1, claiming: 1, maiden: 1, novice: 1, novices: 1, nursery: 1,
    bumper: 1, race: 1, flat: 1, classic: 1 };
  var MOD_WORDS = { mares: 1, fillies: 1, colts: 1, geldings: 1, juvenile: 1, novice: 1,
    novices: 1, maiden: 1, handicap: 1, listed: 1, group: 1, grade: 1, class: 1,
    restricted: 1, optional: 1, selling: 1, claiming: 1, apprentice: 1, amateur: 1,
    conditional: 1, jockeys: 1, riders: 1, work: 1, hunters: 1, nh: 1, ebf: 1, open: 1,
    weight: 1 };

  function normWord(x) {
    return String(x || "").toLowerCase().replace(/[.,;:'’"]+$/g, "");
  }
  /* 超长欧美名 → 只留尾部「类型短语」：从最后一个词往前，凡属 类型词/修饰词 就连续吸收，
     遇到冠名词（含数字、点号、赞助商名）即停。
     "GA Wilson Plastering Open NH Flat Race" → "Open NH Flat Race"（复合类型短语完整保留） */
  function stripSponsor(s) {
    if (s.length <= NAME_MAX) return s;
    var tail = "", m;
    /* 反复剥离尾部条件括号 "(GBB Race)/(Div 1)" 与赛种后缀 " - Awt"，作为结果尾巴接回 */
    while ((m = /((?:\s*\([^()]*\))+|\s+-\s+[A-Za-z]{2,6})\s*$/.exec(s))) {
      tail = m[1] + tail;
      s = s.slice(0, m.index);
    }
    var w = s.split(/\s+/).filter(Boolean);
    var start = w.length, i = w.length - 1;
    while (i >= 0 && (TYPE_WORDS[normWord(w[i])] || MOD_WORDS[normWord(w[i])])) { start = i; i--; }
    if (start === w.length) return (s + tail).trim();          /* 找不到类型词 → 原样返回 */
    /* 只剩类型词一个 → 再补一个词保住赛事名；但补的是 "Er"/"96" 这类残片就不补 */
    if (start === w.length - 1 && start > 0 && normWord(w[start - 1]).length > 3) start--;
    return (w.slice(start).join(" ") + tail).trim();
  }
  function cleanRaceName(name) {
    var s = String(name || "").replace(/\s+/g, " ").trim();
    var parts = s.split(" ");
    if (parts.length === 2 && parts[0] === parts[1]) s = parts[0];
    var half = s.length / 2;
    if (Number.isInteger(half) && s.slice(0, half) === s.slice(half)) s = s.slice(0, half);
    s = s.replace(/^サラ系\s*/, "");
    s = s.replace(/^Race\s*\d+\s*[-–—]\s*/i, "");
    return stripSponsor(s);
  }

  /* ---------- 视觉素材（数据语义，与主站 share.js::drawDense / .waku 同源写死） ---------- */
  var WAKU = {
    1: ["#ffffff", "#0a0a0a", "#c9ccd1"], 2: ["#26262a", "#ffffff"],
    3: ["#d0342c", "#ffffff"], 4: ["#2b62b0", "#ffffff"], 5: ["#f2c500", "#4a3b00"],
    6: ["#1e7d46", "#ffffff"], 7: ["#e8791e", "#ffffff"], 8: ["#ef8bab", "#8c2748"],
  };
  var LEVEL_BG = {
    G1: "#d5302a", Jpn1: "#d5302a", JG1: "#d5302a", GI: "#d5302a",
    G2: "#0a3b7e", Jpn2: "#0a3b7e", JG2: "#0a3b7e", GII: "#0a3b7e",
    G3: "#087220", Jpn3: "#087220", JG3: "#087220", GIII: "#087220",
    L: "#dca026", OP: "#0aa7a0", 地方重赏: "#c2318e", 地方重賞: "#c2318e",
  };
  var LEVEL_TXT = {
    G1: "GⅠ", Jpn1: "JpnⅠ", JG1: "JGⅠ", G2: "GⅡ", Jpn2: "JpnⅡ", JG2: "JGⅡ",
    G3: "GⅢ", Jpn3: "JpnⅢ", JG3: "JGⅢ", L: "L", OP: "OP",
    地方重赏: "重賞", 地方重賞: "重賞",
  };
  var LEVEL_FG = { OP: "#ffffff", L: "#ffffff" };
  /* 芝ダ列：芝=青绿墨、ダ=褐、障=绿（与 share.js::SURF_C 同色） */
  var SURF_FG = { 芝: "#0b6b64", ダ: "#9a5b1f", 障: "#1e7d46", AW: "#0b6b64" };
  /* 性別配色（与 share.js::SEX_C 同色） */
  var SEX_FG = { 牡: "#2b62b0", 牝: "#c2318e", 骟: "#0aa7a0" };
  /* 性齢显示归一（2026-11-11）：数据源是 JBIS 原文「セ / セン」，中文宿主直接摆出来
     是半个生字——统一换成汉字「骟」（骟3），牡/牝不动 */
  function sexCN(s) { s = String(s || ""); return s === "セ" || s === "セン" ? "骟" : s; }

  /* ---------- 样式（一次性注入；颜色走宿主 CSS 变量，缺省回退同站 token） ----------
   * 冷灰网格 token 与 share.js::drawDense 的 C_LINE/C_VLINE/C_ZEBRA/C_HEAD_LINE/C_RACE_LINE/
   * C_DAY_LINE 一一对应，改色请两边同步（一眼看不出漂移，只有并排截图能发现）。 */
  var styleEl = null;
  var SID = "rc-emb-style";
  function injectStyle() {
    if (styleEl && styleEl.parentNode) return;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = SID;
    }
    styleEl.textContent = [
      ".rc-emb{--re-fg:var(--foreground,#131418);--re-body:var(--foreground,#40424a);",
      "--re-muted:var(--muted-foreground,#7c8792);--re-border:var(--border,#e5e5e5);",
      "--re-primary:var(--primary,#0aa7a0);--re-tealink:#0b6b64;--re-card:var(--card,#fff);",
      "--re-headbg:var(--muted,#f3f5f7);--re-line:#f0f2f4;--re-vline:#eef1f4;--re-zebra:#fafbfc;",
      "--re-headline:#dfe4e8;--re-racline:#e6eaee;--re-dayline:#cfd6dc;--re-soft:#f4f6f8;",
      "font-variant-numeric:tabular-nums;color:var(--re-fg);",
      "font-feature-settings:'palt' 1;letter-spacing:.002em}",
      ".rc-emb *{box-sizing:border-box}",
      /* 宿主常把内容放在 flex 布局里（yunji = 侧栏 + 主区），flex item 默认 min-width:auto
         → 组件里任何 nowrap 长文本都会把整页撑宽（430px 手机实测溢出）。这里全部收到 0。 */
      ".rc-emb{min-width:0}",
      ".rc-emb a{color:var(--re-primary)}",
      /* 头行 */
      ".rc-emb-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;margin-bottom:10px;min-width:0}",
      ".rc-emb-title{font-size:calc(13.5px + (var(--re-k,1) - 1) * 6px);font-weight:700;",
      "letter-spacing:.01em}",
      ".rc-emb-sum{font-size:calc(12px + (var(--re-k,1) - 1) * 4px);color:var(--re-muted)}",
      ".rc-emb-sum b{color:var(--re-primary);font-weight:600;margin:0 1px}",
      ".rc-emb-sum i{font-style:normal;opacity:.75;margin:0 3px}",
      ".rc-emb-home{margin-left:auto;font-size:11.5px;color:var(--re-muted);white-space:nowrap}",
      ".rc-emb-home a{color:var(--re-muted);text-decoration:none;border-bottom:1px dashed var(--re-border)}",
      ".rc-emb-home a:hover{color:var(--re-primary);border-bottom-color:var(--re-primary)}",
      /* 赛事分类 chips（全部 / JRA·中央 / NAR·地方 / 海外）：跟在计数后面，宽屏一行、窄屏自动换行 */
      ".rc-emb-scopes{display:inline-flex;flex-wrap:wrap;gap:5px;align-items:center;align-self:center;",
      "margin-left:2px}",
      ".rc-emb-scope{font-family:inherit;font-size:calc(11.5px * var(--re-k,1));line-height:1.75;",
      "padding:0 9px;border-radius:999px;border:1px solid var(--re-border);background:transparent;",
      "color:var(--re-body);cursor:pointer;white-space:nowrap;",
      "transition:background .12s,border-color .12s,color .12s}",
      ".rc-emb-scope b{font-weight:600;color:var(--re-muted);margin-left:4px;font-size:.92em}",
      ".rc-emb-scope:hover{border-color:var(--re-primary);color:var(--re-tealink)}",
      ".rc-emb-scope.is-zero{color:var(--re-muted)}",
      ".rc-emb-scope.is-zero b{color:var(--re-muted);opacity:.7}",
      ".rc-emb-scope.on{background:rgba(10,167,160,.10);border-color:rgba(10,167,160,.45);",
      "color:var(--re-tealink)}",
      ".rc-emb-scope.on b{color:var(--re-tealink)}",
      /* ---------- 形态 A：九列密表（宽容器） ----------
       * 所有字号/内距都乘 --re-k（1 → 1.3，由 paint() 按容器宽度写入）：
       * 27 寸屏容器 1900px 时字体 12.5→16.25px、行高 29→38px，密度不变但视觉有分量。 */
      ".rc-emb-scroll{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}",
      ".rc-emb-tbl{width:100%;min-width:calc(680px * var(--re-k,1));table-layout:fixed;",
      "border-collapse:separate;border-spacing:0;font-size:calc(12.5px * var(--re-k,1));line-height:1.35}",
      ".rc-emb-tbl th{background:var(--re-headbg);color:var(--re-muted);",
      "font-size:calc(11px * var(--re-k,1));font-weight:600;",
      "padding:calc(6px * var(--re-k,1)) calc(8px * var(--re-k,1));text-align:left;white-space:nowrap;",
      "border-bottom:1px solid var(--re-headline);letter-spacing:.02em}",
      ".rc-emb-tbl th.c{text-align:center}",
      /* 结构竖线：合并列区（时间/场次/比赛名/赛道）右缘 + 彩衣列右缘（马号色带本身即边界，
         不再额外画线，否则色带右边会出现一条割裂的浅线），其余留白 */
      ".rc-emb-tbl th.v{border-right:1px solid var(--re-vline)}",
      ".rc-emb-tbl td{padding:calc(5px * var(--re-k,1)) calc(8px * var(--re-k,1));",
      "vertical-align:middle;border-top:1px solid var(--re-line)}",
      ".rc-emb-tbl td.c{text-align:center}",
      /* 合并列顶端对齐：多匹产驹时时间/场次/比赛名贴首行，读者先看到「哪场」再往下看马 */
      /* 合并列**垂直居中**（2026-11-07 用户反馈：宽表下顶端对齐时，两匹的场次左侧会空出
         半块空白，很丑）。与分享卡 drawDense 的 midOf() 同口径 —— 比赛级信息落在整场的
         视觉中心，一匹/两匹/四匹都不会出现"上方贴字、下方空白"的失衡。 */
      ".rc-emb-tbl td.rs{border-top:0;border-right:1px solid var(--re-vline);vertical-align:middle}",
      /* ---------- 马号列 = 满格色带（v2.5.0） ----------
       * td 自己刷底色（表格单元格背景一定填满整个单元格盒，不受内容高度影响），
       * 上下**不画横向分隔线** → 相邻两格颜色直接相接，同枠的产驹连成一条竖带。
       * 零左右内距 + 居中：两位数也不会把色带挤成两半。 */
      ".rc-emb-tbl td.nm{padding:calc(5px * var(--re-k,1)) 0;text-align:center;border-top:0;",
      "font-size:calc(12.5px * var(--re-k,1));font-weight:700;line-height:1.35;letter-spacing:0}",
      /* 无枠番（海外/未確定）：不刷色，退回普通文本，但保留行分隔线，免得整列看着像断开的占位 */
      ".rc-emb-tbl td.nm.nb{border-top:1px solid var(--re-line);color:var(--re-muted);font-weight:600}",
      /* ---------- 彩衣列：马主勝負服小图（等比缩放，不裁切） ---------- */
      ".rc-emb-tbl td.sk{padding:calc(2px * var(--re-k,1)) calc(4px * var(--re-k,1));",
      "border-right:1px solid var(--re-vline)}",
      ".rc-emb-silk{display:block;height:calc(19px * var(--re-k,1));width:auto;max-width:none;",
      "margin:0 auto;border-radius:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.08)}",

      /* 斑马：只刷逐马列（合并块内不穿色，与 drawDense 的 xPerRow 起刷同做法） */
      ".rc-emb-tbl td.z{background:var(--re-zebra)}",
      /* 比赛分隔线：每场首行整行加深（含合并单元格）；马号色带例外——在色带上压一条线
         会把「同枠连成一条」的竖带切成一格一格，而场次的切换本身已由色带断点表达 */
      ".rc-emb-tbl tr.rf td{border-top:1px solid var(--re-racline)}",
      ".rc-emb-tbl tr.rf td.nm.bd{border-top:0}",
      ".rc-emb-tbl tbody tr:hover td:not(.rs){background:rgba(10,167,160,.05)}",
      /* 日期分组行（跨列）：teal 短竖条 + 「11月4日（水）」+ 右对齐头数 */
      ".rc-emb-tbl th.rc-emb-daycell{padding:calc(15px * var(--re-k,1)) 2px calc(6px * var(--re-k,1));",
      "background:transparent;border-bottom:0;border-top:1px solid var(--re-dayline);text-align:left}",
      ".rc-emb-tbl tr.rc-emb-dayrow:first-child th.rc-emb-daycell{border-top:0;padding-top:2px}",
      ".rc-emb-dayh{display:flex;align-items:baseline;gap:6px;border-bottom:1px solid var(--re-headline);",
      "padding-bottom:calc(6px * var(--re-k,1))}",
      ".rc-emb-dayd{display:flex;align-items:center;gap:7px;font-size:calc(13.5px * var(--re-k,1));",
      "font-weight:700;color:var(--re-fg);white-space:nowrap;letter-spacing:.01em}",
      ".rc-emb-dayd::before{content:'';width:3px;height:calc(12px * var(--re-k,1));border-radius:2px;",
      "background:var(--re-primary)}",
      ".rc-emb-dayw{font-size:calc(12px * var(--re-k,1));font-weight:600;color:var(--re-muted);",
      "margin-left:-3px;white-space:nowrap}",
      ".rc-emb-dayn{margin-left:auto;font-size:calc(11px * var(--re-k,1));font-weight:500;",
      "color:var(--re-muted);white-space:nowrap;padding-right:4px}",
      /* 北京时间 */
      ".rc-emb-time{font-size:calc(12.5px * var(--re-k,1));font-weight:600;color:var(--re-tealink);",
      "letter-spacing:.01em}",
      /* 场次：场地名实心 + R 号弱化 */
      /* 场次 = 「场地 + R 号」两段各自对齐（2026-11-07 用户要求「文字和文字、数字和数字对齐」）：
         场地右对齐到同一列、R 号右对齐到同一列（最小 2.6ch 容下两位数），
         于是 京都1R / 京都12R 的「R」落在同一条竖线上，不再因为多一位数字整体左移。 */
      ".rc-emb-no{display:inline-grid;grid-template-columns:auto auto;column-gap:2px;",
      "align-items:baseline;font-size:calc(12.5px * var(--re-k,1));font-weight:600;white-space:nowrap}",
      ".rc-emb-no .v{text-align:right}",
      ".rc-emb-no .n{text-align:right;min-width:3.2ch;font-size:calc(11px * var(--re-k,1));",
      "color:var(--re-muted);letter-spacing:0}",
      /* 比赛名 + 级别徽章（名字可省略，徽章永不挤出/压掉） */
      ".rc-emb-rname{display:flex;align-items:center;gap:5px;min-width:0;",
      "font-size:calc(13px * var(--re-k,1));font-weight:600;white-space:nowrap}",
      ".rc-emb-rn{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".rc-emb-g{display:inline-block;flex:none;padding:1px 4px;border-radius:3px;",
      "font-size:calc(9.5px * var(--re-k,1));font-weight:700;line-height:1.5;color:#fff}",
      /* 赛道（芝/ダ/障 + 距离） */
      ".rc-emb-dist{font-size:calc(12.5px * var(--re-k,1));font-weight:600;white-space:nowrap}",
      /* 马号（卡片态）：色块 = 枠番、字 = 馬番；方角只留 3px 圆角，与宽表色带同一手感 */
      ".rc-emb-waku{display:inline-flex;width:calc(24px * var(--re-k,1));height:calc(19px * var(--re-k,1));",
      "align-items:center;justify-content:center;border-radius:3px;flex:none;",
      "font-size:calc(11px * var(--re-k,1));font-weight:700;line-height:1}",
      ".rc-emb-waku.na{background:transparent;color:var(--re-muted)}",
      ".rc-emb-hname{font-size:calc(13px * var(--re-k,1));font-weight:600;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap}",
      /* ---------- 宿主联动（v2.6.0）：译名 / 马匹页 / 比赛页 ---------- */
      /* 译名（宿主的港译→自译）：斜杠后灰字，自译前置 * ；与日文名同一行，长名一起省略 */
      ".rc-emb-nz{color:var(--re-muted);font-weight:400;margin-left:0}",
      /* 用 a.xxx 提权压过 `.rc-emb a{color:primary}`（通用链接青绿），马名/比赛名要跟正文同色 */
      ".rc-emb a.rc-emb-hj{color:var(--re-body);text-decoration:none;cursor:pointer}",
      ".rc-emb-hj:hover .rc-emb-hname,.rc-emb-hj:hover .rc-emb-nz{text-decoration:underline;",
      "text-underline-offset:2px;text-decoration-color:var(--re-muted)}",
      /* 比赛可点：hover 才出 ↗（常显会让 12 列满屏都是箭头），下划线也只给名字 */
      ".rc-emb a.rc-emb-rj{color:inherit;text-decoration:none;cursor:pointer}",
      ".rc-emb-rj:hover .rc-emb-rn,.rc-emb-rj:hover .v{text-decoration:underline;",
      "text-underline-offset:2px;text-decoration-color:var(--re-muted)}",
      /* ↗ 常驻但极淡（opacity:.3）：占位恒定 → 悬停不跳版；行悬停时提亮到 .85 作为「这里能点」的提示 */
      ".rc-emb-rj::after{content:'↗';font-size:.8em;color:var(--re-muted);margin-left:3px;opacity:.3}",
      ".rc-emb-tbl tr:hover .rc-emb-rj::after,.rc-emb-rj:hover::after{opacity:.85}",
      /* 前走列：比赛名（可省略）+ 人气 + 着顺，单行三段；数字不参与省略；↗ 落在整段末尾 */
      ".rc-emb-last{display:flex;align-items:baseline;gap:calc(6px * var(--re-k,1));min-width:0;",
      "font-size:calc(11.5px * var(--re-k,1));color:var(--re-muted)}",
      ".rc-emb-last>a{display:flex;align-items:baseline;gap:calc(6px * var(--re-k,1));min-width:0;",
      "color:inherit;text-decoration:none;cursor:pointer}",
      ".rc-emb-last .rn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;",
      "color:var(--re-body)}",
      ".rc-emb-last .pp,.rc-emb-last .rk{flex:none;white-space:nowrap}",
      ".rc-emb-last .rk{font-weight:600;color:var(--re-body)}",
      ".rc-emb-last.na{color:var(--re-muted);opacity:.7}",
      /* * 号脚注：只在确有自译名时出现（没有译名就整行不摆） */
      ".rc-emb-note{padding:calc(7px * var(--re-k,1)) 2px 0;font-size:calc(10.5px * var(--re-k,1));",
      "color:var(--re-muted);line-height:1.5}",
      ".rc-emb-sex{font-size:calc(12.5px * var(--re-k,1));font-weight:600}",
      ".rc-emb-age{font-size:calc(12px * var(--re-k,1));color:var(--re-muted);margin-left:1px}",
      ".rc-emb-wt{font-size:calc(12.5px * var(--re-k,1));color:var(--re-body)}",
      ".rc-emb-jk{font-size:calc(12.5px * var(--re-k,1));color:var(--re-body);",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}",
      /* 超宽屏补充列（母父 / 調教師）：字号小半档 + 弱化色，主信息仍是馬名与比赛名 */
      ".rc-emb-bms,.rc-emb-tr{font-size:calc(11.5px * var(--re-k,1));color:var(--re-muted);",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}",
      /* ---------- 形态 B：逐场卡片（窄容器 / 手机） ---------- */
      ".rc-emb-cards{display:flex;flex-direction:column;gap:9px;min-width:0}",
      ".rc-emb-cday,.rc-emb-rc{min-width:0}",
      /* 日期分隔（与表版同款：teal 短竖条 + 头数） */
      ".rc-emb-cday{display:flex;align-items:baseline;gap:6px;margin:6px 0 1px;padding-bottom:5px;",
      "border-bottom:1px solid var(--re-headline)}",
      ".rc-emb-cday .d{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;",
      "white-space:nowrap;letter-spacing:.01em}",
      ".rc-emb-cday .d::before{content:'';width:3px;height:11px;border-radius:2px;background:var(--re-primary)}",
      ".rc-emb-cday .w{font-size:11.5px;font-weight:600;color:var(--re-muted);margin-left:-2px}",
      ".rc-emb-cday .n{margin-left:auto;font-size:11px;color:var(--re-muted);white-space:nowrap}",
      /* 单场卡片 */
      ".rc-emb-rc{border:1px solid var(--re-border);border-radius:10px;overflow:hidden;",
      "background:var(--re-card)}",
      /* 条头：场次 + 北京时间（2026-11-11：补「北京时间」小标，卡片态没列头、
         裸一个 13:55 会被读成当地时间） */
      ".rc-emb-rcband{display:flex;align-items:baseline;gap:8px;padding:6px 10px;",
      "background:var(--re-soft);border-bottom:1px solid var(--re-line)}",
      ".rc-emb-rcband .v{font-size:12px;font-weight:600;color:var(--re-body);min-width:0;",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".rc-emb-rcband .v i{font-style:normal;font-size:10.5px;color:var(--re-muted);margin-left:1px}",
      ".rc-emb-rcband .tm{margin-left:auto;font-size:12px;font-weight:700;color:var(--re-tealink)}",
      ".rc-emb-rcband .tm i{font-style:normal;font-size:10px;font-weight:500;",
      "color:var(--re-muted);margin-right:3px;letter-spacing:.02em}",
      /* 比赛名 + 赛道 */
      ".rc-emb-rcname{display:flex;align-items:center;gap:5px;padding:7px 10px 3px;min-width:0}",
      ".rc-emb-rcname .rn{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;",
      "white-space:nowrap;min-width:0}",
      /* 赛道紧跟比赛名（2026-11-11：去掉 margin-left:auto——短比赛名「C2一」时
         auto 会把它推到最右，中间一大段空白；名字长了 rn 自己省略，dist 恒可见） */
      ".rc-emb-rcname .ds{flex:none;font-size:11px;font-weight:600;white-space:nowrap}",
      /* 产驹行：第一行 马号 + 彩衣 + 馬名 + 性齢；第二行 騎手 + 斤量 + 母父
         （斤量 2026-11-11 挪到騎手后：原来缀在性齢后孤零零一个数，读不出是啥） */
      ".rc-emb-runs{padding:0 10px 7px}",
      ".rc-emb-run{padding:5px 0;border-top:1px solid var(--re-line)}",
      ".rc-emb-runs .rc-emb-run:first-child{border-top:0}",
      ".rc-emb-run .l1{display:flex;align-items:center;gap:7px;min-width:0}",
      ".rc-emb-run .l1 .rc-emb-silk{height:17px;flex:none;margin:0}",
      ".rc-emb-run .l1 .hn{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 可点态：链接自己承担整行的省略（内部 span 变纯文本，否则截断不生效） */
      ".rc-emb-run .l1 .rc-emb-hjcard{flex:1 1 auto;min-width:0;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}",
      ".rc-emb-run .l1 .rt{display:flex;align-items:baseline;gap:4px;flex:none}",
      ".rc-emb-run .l1 .sa{font-size:11.5px;font-weight:600}",
      ".rc-emb-run .l1 .ag{font-size:11.5px;color:var(--re-muted)}",
      ".rc-emb-run .l2{display:flex;align-items:baseline;gap:8px;margin-top:1px;padding-left:61px;",
      "font-size:11px;color:var(--re-muted);min-width:0}",
      ".rc-emb-run .l2 .jk{flex:0 1 auto;min-width:0;color:var(--re-body);overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap}",
      ".rc-emb-run .l2 .wt{flex:none;font-size:11px;font-weight:600;color:var(--re-muted);margin-left:-3px}",
      ".rc-emb-run .l2 .bms{margin-left:auto;flex:0 1 auto;min-width:0;max-width:50%;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap}",
      /* 折叠（最近一周） */
      ".rc-emb-past{margin-top:14px}",
      ".rc-emb-past>summary{cursor:pointer;list-style:none;font-size:11.5px;color:var(--re-muted);",
      "padding:7px 2px;border-top:1px dashed var(--re-border)}",
      ".rc-emb-past>summary::-webkit-details-marker{display:none}",
      ".rc-emb-past>summary:hover{color:var(--re-primary)}",
      ".rc-emb-past>summary::before{content:'▸ ';font-size:10px}",
      ".rc-emb-past[open]>summary::before{content:'▾ '}",
      ".rc-emb-past[open]>summary{border-bottom:1px dashed var(--re-border);margin-bottom:12px}",
      /* 状态 */
      ".rc-emb-state{display:flex;align-items:center;justify-content:center;gap:8px;",
      "padding:34px 16px;font-size:12.5px;color:var(--re-muted);text-align:center}",
      ".rc-emb-state small{display:block;margin-top:4px;font-size:11.5px;opacity:.85}",
      ".rc-emb-spin{width:16px;height:16px;border-radius:50%;border:2.5px solid var(--re-primary);",
      "border-top-color:transparent;animation:rc-emb-rot .8s linear infinite;flex:none}",
      "@keyframes rc-emb-rot{to{transform:rotate(360deg)}}",
      ".rc-emb-retry{border:1px solid var(--re-border);border-radius:8px;background:transparent;",
      "padding:4px 14px;font-size:12px;color:var(--re-fg);cursor:pointer;font-family:inherit}",
      ".rc-emb-retry:hover{border-color:var(--re-primary);color:var(--re-primary)}",
    ].join("");
    document.head.appendChild(styleEl);
  }

  /* ================= 宿主联动（opts.host · v2.6.0 对接规范 = docs/DESIGN.md §10.1） =================
   * 宿主可选注入三个**同步**回调，缺省/抛错一律降级（不显示译名、不可点），组件永不因此报错：
   *   name(jbisId) → { zh, kind: "hk"|"self" } | null   译名（优先级由宿主决定：港译 → 自译）
   *   horse(jbisId) → url | null                        马匹页（相对宿主页面的 URL 即可，组件就长在宿主 DOM 里）
   *   race(row)     → url | null                        比赛页（缺省用行内 raceUrl = JBIS）
   * 组件不判断译名来源优先级、不做缓存、不发额外请求——数据怎么来是宿主的事。 */
  var HOST = {};
  function hostCall(k, arg) {
    var f = HOST[k];
    if (typeof f !== "function") return null;
    try {
      var v = f(arg);
      return v == null || v === "" ? null : v;
    } catch (e) {
      return null;                       /* 宿主回调炸了也要能出表 */
    }
  }

  var selfNameSeen = false;               /* 本轮渲染是否出现过自译名（决定画不画 * 脚注） */
  /* 马名 = 日文名 + 「/译名」；有马匹页就连成链接（新标签，与宿主 .hjump 同习惯） */
  function horseNameHTML(r, opt) {
    opt = opt || {};
    var jp = String(r.horseName || "");
    var zh = hostCall("name", r.horseId);
    var zhTxt = zh && zh.zh ? String(zh.zh) : "";
    var self = Boolean(zhTxt) && zh.kind === "self";
    if (self) selfNameSeen = true;
    var body = '<span class="' + (opt.nameCls || "rc-emb-hname") + '">' + esc(jp) + "</span>" +
      (zhTxt ? '<span class="rc-emb-nz">/' + (self ? "*" : "") + esc(zhTxt) + "</span>" : "");
    var href = hostCall("horse", r.horseId);
    if (!href) return body;
    var tip = jp + (zhTxt ? "（" + (self ? "自译" : "港译") + "：" + zhTxt + "）" : "");
    return '<a class="rc-emb-hj' + (opt.linkCls ? " " + opt.linkCls : "") + '" href="' + esc(href) +
      '" target="_blank" rel="noopener" title="' + esc(tip) + '" data-rc="horse">' + body + "</a>";
  }

  /* 比赛页 URL：宿主可覆盖，缺省用行内 raceUrl（JBIS 出馬表/結果页） */
  function raceHref(r) {
    return hostCall("race", r) || r.raceUrl || null;
  }

  /* 前走 = 比赛名 · 人气 · 着顺（人气来自 collect-recent-pop，缺则只显示其余两段）
   * 2026-11-08 定稿：`２歳 未勝利 11人气 8着 ↗` —— 三段用空格分开、日文「人気」译成「人气」，
   * ↗ 从「比赛名后」挪到**整段末尾**（原来夹在名字与人气之间，把三段数字切断了）。
   * 做法：a 包住整段、自己做 flex，`.rc-emb-rj::after` 的箭头自然落在最后。 */
  function lastRunHTML(r) {
    if (!r.lastRace && r.lastRank == null) {
      return '<span class="rc-emb-last na">新馬</span>';
    }
    var name = cleanRaceName(r.lastRace) || "–";
    var href = r.lastRaceKey ? "https://www.jbis.or.jp/race/result/" + String(r.lastRaceKey) + "/" : null;
    var inner =
      '<span class="rn" title="' + esc(r.lastRace || "") + '">' + esc(name) + "</span>" +
      (r.lastPop != null ? '<span class="pp">' + esc(r.lastPop) + "人气</span>" : "") +
      (r.lastRank != null ? '<span class="rk">' + esc(r.lastRank) + "着</span>" : "");
    return '<span class="rc-emb-last">' +
      (href
        ? '<a class="rc-emb-rj" href="' + esc(href) + '" target="_blank" rel="noopener" title="' +
          esc(r.lastRace || "") + '">' + inner + "</a>"
        : inner) +
      "</span>";
  }

  /* 马号：色 = 枠番（JRA 官方 8 色）、字 = 馬番（对齐分享卡 dense 定稿 A：一块只留一个数字）。
   * 宽表用它刷满整格（td 背景），卡片用它做小方块。无枠番 → 透明（不刷灰，灰块会被读成坏数据）。 */
  function frameBg(frame) {
    var c = WAKU[Number(frame)];
    if (!c) return "";
    return "background:" + c[0] + ";color:" + c[1] + (c[2] ? ";box-shadow:inset 0 0 0 1px " + c[2] : "");
  }
  function wakuChip(frame, num) {
    var c = WAKU[Number(frame)];
    var t = num == null || num === "" ? "–" : num;
    if (!c) return '<span class="rc-emb-waku na">' + esc(t) + "</span>";
    return '<span class="rc-emb-waku" style="' + frameBg(frame) + '">' + esc(t) + "</span>";
  }
  /* 彩衣图：行里存的是站点根相对路径（data/silks/{ownerId}.gif），这里补 base；
   * 已是绝对 URL 的原样用。缺图（海外源 / 未覆盖的马主）返回空串 —— 空着比一排破图好。 */
  function silkURL(base, silk) {
    var s = String(silk == null ? "" : silk).trim();
    if (!s) return "";
    if (/^(?:https?:)?\/\//.test(s)) return s;
    return String(base || "").replace(/\/+$/, "") + "/" + s.replace(/^\/+/, "");
  }
  function silkImg(base, silk) {
    var src = silkURL(base, silk);
    if (!src) return "";
    return '<img class="rc-emb-silk" src="' + esc(src) +
      '" alt="彩衣" title="彩衣" loading="lazy" decoding="async" onerror="this.remove()">';
  }
  function levelBadge(level) {
    var bg = LEVEL_BG[level];
    if (!bg) return "";
    var fg = LEVEL_FG[level] || "#ffffff";
    return '<span class="rc-emb-g" style="background:' + bg + ";color:" + fg + '">' +
           esc(LEVEL_TXT[level] || level) + "</span>";
  }

  /* ---------- 渲染 ---------- */
  function raceKey(r) { return r.raceKey || (r.date + "|" + r.venue + "|" + (r.raceNo ?? "")); }

  /* 赛事分类：JRA=中央 / NAR=地方 / 其余（含国家组码 GB·IRE·FR·USA 与「海外」）= 海外。
     与主站筛选卡的「场地」三段同口径（src/race-config.js::scopeOfVenue / countryGroupOf）。 */
  function scopeOf(r) {
    var s = String(r.scope || "");
    return s === "JRA" ? "jra" : s === "NAR" ? "nar" : "ov";
  }
  var SCOPES = [
    { k: "all", label: "全部" },
    { k: "jra", label: "JRA·中央" },
    { k: "nar", label: "NAR·地方" },
    { k: "ov", label: "海外" },
  ];

  /* 按日期分组（两份形态共用）：[{date, weekday, rows, races:[{rows:[…]}]}] */
  function groupByDate(rows) {
    var order = [], byDate = {};
    rows.forEach(function (r) {
      var d = r.date || "";
      if (!byDate[d]) { byDate[d] = { date: d, weekday: r.weekday || "", rows: [], races: [], _m: {} }; order.push(d); }
      var day = byDate[d];
      day.rows.push(r);
      var k = raceKey(r);
      if (!day._m[k]) { day._m[k] = { rows: [] }; day.races.push(day._m[k]); }
      day._m[k].rows.push(r);
    });
    return order.map(function (d) { return byDate[d]; });
  }

  /* ================= 形态 A：九列密表（宽容器） =================
   * 2026-11-07：27 寸屏反馈「太空洞」→ 加两层自适应：
   *   ① 字号/行距随容器宽度 fluid 放大（--re-k：1000px 起 1 → 1400px 封顶 1.3，见 paint()）；
   *   ② 超宽屏把多出来的宽度**换成信息**而不是留白：≥1180px 加「前走」列，≥1500px 再加「母父」+「調教師」列（前走恒在最后）。
   *      （父是常量——宿主就是按 sire 筛的，永不出现。）
   * 列宽按档位给出百分比（每档合计 100%），table-layout:fixed 下不会被撑爆。 */
  var COLS_TIERS = [
    [ /* tier 0（720–1179）：基础十列（无前走——2026-11-13 用户定稿） */
      { k: "time", label: "北京时间", cls: "c v", w: 8 },
      { k: "no",   label: "场次",     cls: "c v", w: 8 },
      { k: "rn",   label: "比赛",     cls: "v",   w: 26 },
      { k: "ds",   label: "赛道",     cls: "c v", w: 7 },
      { k: "wk",   label: "马号",     cls: "c",   w: 4.5 },
      { k: "sk",   label: "彩衣",     cls: "c v",   w: 5 },
      { k: "hn",   label: "马名",     cls: "",    w: 19.5 },
      { k: "sa",   label: "性龄",     cls: "c",   w: 6 },
      { k: "wt",   label: "负重",     cls: "c",   w: 6 },
      { k: "jk",   label: "骑手",     cls: "",    w: 10 },
    ],
    [ /* tier 1（≥1180）：补「前走」（2026-11-13 定稿：前走是 tier 1 才加的列） */
      { k: "time", label: "北京时间", cls: "c v", w: 7 },
      { k: "no",   label: "场次",     cls: "c v", w: 7 },
      { k: "rn",   label: "比赛",     cls: "v",   w: 22 },
      { k: "ds",   label: "赛道",     cls: "c v", w: 6 },
      { k: "wk",   label: "马号",     cls: "c",   w: 4.5 },
      { k: "sk",   label: "彩衣",     cls: "c v",   w: 4.5 },
      { k: "hn",   label: "马名",     cls: "",    w: 16.5 },
      { k: "sa",   label: "性龄",     cls: "c",   w: 5.5 },
      { k: "wt",   label: "负重",     cls: "c",   w: 5.5 },
      { k: "jk",   label: "骑手",     cls: "",    w: 8.5 },
      { k: "last", label: "前走",     cls: "",    w: 13 },
    ],
        [ /* tier 2（≥1500）：再补「母父」+「調教師」，列序 …騎手→母父→調教師→前走 */
      { k: "time", label: "北京时间", cls: "c v", w: 6.5 },
      { k: "no",   label: "场次",     cls: "c v", w: 6.5 },
      { k: "rn",   label: "比赛",     cls: "v",   w: 16 },
      { k: "ds",   label: "赛道",     cls: "c v", w: 5.5 },
      { k: "wk",   label: "马号",     cls: "c",   w: 3 },
      { k: "sk",   label: "彩衣",     cls: "c v", w: 3.5 },
      { k: "hn",   label: "马名",     cls: "",    w: 12.5 },
      { k: "sa",   label: "性龄",     cls: "c",   w: 4.5 },
      { k: "wt",   label: "负重",     cls: "c",   w: 4.5 },
      { k: "jk",   label: "骑手",     cls: "",    w: 6.5 },
      { k: "bms",  label: "母父",     cls: "",    w: 9.5 },
      { k: "tr",   label: "练马师",   cls: "",    w: 8.5 },
      { k: "last", label: "前走",     cls: "",    w: 13 },
    ],
  ];
  /* 容器宽 → 档位（与字号档同步，见 widthMeta()） */
  function tierOf(w) { return w >= 1500 ? 2 : w >= 1180 ? 1 : 0; }

  function tableHead(cols) {
    return "<colgroup>" + cols.map(function (c) {
      return '<col style="width:' + c.w + '%">';
    }).join("") + "</colgroup>" +
    "<thead><tr>" + cols.map(function (c) {
      return "<th" + (c.cls ? ' class="' + c.cls + '"' : "") + ">" + esc(c.label) + "</th>";
    }).join("") + "</tr></thead>";
  }

  /* 行集 → 连续 tbody 行（斑马按逐马行全局奇偶；parity 跨日累加，换日处不断色） */
  function tableBody(rowsId, cols, base) {
    var hasBms = false, hasTr = false, hasSk = false, hasLast = false;
    cols.forEach(function (c) {
      if (c.k === "bms") hasBms = true;
      if (c.k === "tr") hasTr = true;
      if (c.k === "sk") hasSk = true;
      if (c.k === "last") hasLast = true;
    });
    var html = "", parity = 0;
    groupByDate(rowsId).forEach(function (day) {
      html += '<tr class="rc-emb-dayrow"><th class="rc-emb-daycell" colspan="' + cols.length + '">' +
        '<div class="rc-emb-dayh">' +
          '<span class="rc-emb-dayd">' + esc(mdJP(day.date)) + "</span>" +
          (day.weekday ? '<span class="rc-emb-dayw">（' + esc(day.weekday) + "）</span>" : "") +
          '<span class="rc-emb-dayn">' + day.rows.length + " 頭 / " + day.races.length + " R</span>" +
        "</div></th></tr>";

      day.races.forEach(function (race, ri) {
        var n = race.rows.length;
        race.rows.forEach(function (r, i) {
          var z = parity++ % 2 ? " z" : "";
          var first = i === 0;
          /* rf = 本场首行（整行加深分隔线）；本日第一场不加（上面紧跟日期行） */
          html += "<tr" + (first && ri > 0 ? ' class="rf"' : "") + ">";
          if (first) {
            var span = ' rowspan="' + n + '"';
            var surf = String(r.surface || "");
            var dist = (surf || "") + (r.distance != null ? r.distance : "");
            /* 比赛页链接只挂比赛名：场次列不跳转（2026-11-08 用户要求，场上 ↗ 一排箭头很噪） */
            var rh = raceHref(r);
            var open = rh ? '<a class="rc-emb-rj" href="' + esc(rh) + '" target="_blank" rel="noopener" data-rc="race">' : "";
            var close = rh ? "</a>" : "";
            html +=
              '<td class="c rs"' + span + '><span class="rc-emb-time">' + esc(bjTime(r.startTimeInstant) || "–") + "</span></td>" +
              '<td class="c rs"' + span + '><span class="rc-emb-no">' +
                '<span class="v">' + esc(r.venue || "–") + "</span>" +
                (r.raceNo != null ? '<span class="n">' + esc(r.raceNo) + "R</span>" : "") + "</span></td>" +
              '<td class="rs"' + span + '><div class="rc-emb-rname" title="' + esc(r.raceName || "") + '">' +
                open + '<span class="rc-emb-rn">' + esc(cleanRaceName(r.raceName) || "–") + "</span>" + close +
                levelBadge(r.level) + "</div></td>" +
              '<td class="c rs"' + span + '><span class="rc-emb-dist" style="color:' +
                esc(SURF_FG[surf] || "inherit") + '">' + esc(dist || "–") + "</span></td>";
          }
          var sex = sexCN(r.sex);
          var bms = String(r.bms || ""), tr = String(r.trainer || "");
          /* 马号 = 满格色带：底色刷在 td 上（列宽窄、零内距），有枠番才刷；无枠番退普通文本 */
          var fbg = frameBg(r.frame);
          var numTxt = r.num == null || r.num === "" ? "–" : esc(r.num);
          /* 斑马只刷逐马列：合并列（rs，纵向跨整场）不参与，否则同一场会被切成两种底色 */
          html +=
            '<td class="c nm' + (fbg ? " bd" : " nb") + z + '"' +
              (fbg ? ' style="' + fbg + '"' : "") + ">" + numTxt + "</td>" +
            (hasSk ? '<td class="c sk' + z + '">' + silkImg(base, r.silk) + "</td>" : "") +
            '<td class="' + (z ? "z" : "") + '">' + horseNameHTML(r) + "</td>" +
            '<td class="c' + z + '"><span class="rc-emb-sex" style="color:' + esc(SEX_FG[sex] || "inherit") + '">' +
              esc(sex) + '</span><span class="rc-emb-age">' + esc(r.age != null ? r.age : "") + "</span></td>" +
            '<td class="c' + z + '"><span class="rc-emb-wt">' +
              (r.weight != null ? esc(r.weight) : "–") + "</span></td>" +
            '<td class="' + (z ? "z" : "") + '"><span class="rc-emb-jk" title="' + esc(r.jockey || "") + '">' +
              esc(r.jockey || "") + "</span></td>" +
            (hasBms ? '<td class="' + (z ? "z" : "") + '"><span class="rc-emb-bms" title="' + esc(bms) + '">' +
              esc(bms || "—") + "</span></td>" : "") +
            (hasTr ? '<td class="' + (z ? "z" : "") + '"><span class="rc-emb-tr" title="' + esc(tr) + '">' +
              esc(tr || "—") + "</span></td>" : "") +
            (hasLast ? '<td class="' + (z ? "z" : "") + '">' + lastRunHTML(r) + "</td>" : "") +
            "</tr>";
        });
      });
    });
    return html;
  }

  function tableHTML(rows, tier, base, withSilk) {
    var cols = (COLS_TIERS[tier] || COLS_TIERS[0]).filter(function (c) {
      return withSilk !== false || c.k !== "sk";   /* 整批都没有彩衣 → 不摆空列 */
    });
    return '<div class="rc-emb-scroll"><table class="rc-emb-tbl">' + tableHead(cols) +
      "<tbody>" + tableBody(rows, cols, base) + "</tbody></table></div>";
  }

  /* ================= 形态 B：逐场卡片（窄容器） ================= */
  function cardsHTML(rows, base) {
    var html = '<div class="rc-emb-cards">';
    groupByDate(rows).forEach(function (day) {
      html += '<div class="rc-emb-cday"><span class="d">' + esc(mdJP(day.date)) + "</span>" +
        (day.weekday ? '<span class="w">（' + esc(day.weekday) + "）</span>" : "") +
        '<span class="n">' + day.rows.length + " 頭 / " + day.races.length + " R</span></div>";

      day.races.forEach(function (race) {
        var r0 = race.rows[0];
        var surf = String(r0.surface || "");
        var dist = (surf || "") + (r0.distance != null ? r0.distance : "");
        var r0h = raceHref(r0);
        var r0open = r0h ? '<a class="rc-emb-rj" href="' + esc(r0h) + '" target="_blank" rel="noopener" data-rc="race">' : "";
        var r0close = r0h ? "</a>" : "";
        html += '<div class="rc-emb-rc">' +
          '<div class="rc-emb-rcband">' +
            '<span class="v">' + esc(r0.venue || "–") +
              (r0.raceNo != null ? "<i>" + esc(r0.raceNo) + "R</i>" : "") + "</span>" +
            '<span class="tm"><i>北京时间</i>' + esc(bjTime(r0.startTimeInstant) || "–") + "</span>" +
          "</div>" +
          '<div class="rc-emb-rcname">' +
            r0open + '<span class="rn" title="' + esc(r0.raceName || "") + '">' + esc(cleanRaceName(r0.raceName) || "–") + "</span>" + r0close +
            levelBadge(r0.level) +
            '<span class="ds" style="color:' + esc(SURF_FG[surf] || "inherit") + '">' + esc(dist || "–") + "</span>" +
          "</div>" +
          '<div class="rc-emb-runs">' +
            race.rows.map(function (r) {
          var sex = sexCN(r.sex);
          var bms = String(r.bms || "");
              return '<div class="rc-emb-run">' +
                '<div class="l1">' + wakuChip(r.frame, r.num) + silkImg(base, r.silk) +
                  horseNameHTML(r, { nameCls: "hn", linkCls: "rc-emb-hjcard" }) +
                  '<span class="rt">' +
                    '<span class="sa" style="color:' + esc(SEX_FG[sex] || "inherit") + '">' + esc(sex) + "</span>" +
                    '<span class="ag">' + esc(r.age != null ? r.age : "") + "</span>" +
                  "</span>" +
                "</div>" +
                '<div class="l2"><span class="jk">' + esc(r.jockey || "") + "</span>" +
                  '<span class="wt">' + (r.weight != null ? esc(r.weight) : "–") + "</span>" +
                  (bms ? '<span class="bms" title="母父 ' + esc(bms) + '">母父 ' + esc(bms) + "</span>" : "") +
                "</div>" +
              "</div>";
            }).join("") +
          "</div>" +
        "</div>";
      });
    });
    return html + "</div>";
  }

  /* 所有输出统一套 .rc-emb 容器——CSS 变量（--re-*）定义在它身上，
     少了这层包裹 var(--re-primary) 等全部失效（短线/灰表头/框线会凭空消失） */
  function wrap(inner) { return '<div class="rc-emb">' + inner + "</div>"; }

  /* 容器宽度 → 形态/档位/字号系数。宿主有侧栏/90% 宽/卡片内距，
     必须量自身宽度，不能看视口（无 @media）。
     · mode：<720 走卡片，否则走密表
     · tier：0 = 九列 / 1（≥1180）= 加母父 / 2（≥1500）= 再加調教師
     · k：字号与行距系数，1000px 起 1，1400px 封顶 1.3（27 寸屏上 12.5px 太小的反馈） */
  function widthMeta(el) {
    var w = el.clientWidth || 0;
    if (!w && el.parentNode) w = el.parentNode.clientWidth || 0;
    if (!w) return { w: 0, mode: "table", tier: 0, k: 1 };   /* 量不到时按 PC 处理，ResizeObserver 会纠正 */
    return {
      w: w,
      mode: w < WIDE_MIN ? "cards" : "table",
      tier: w < WIDE_MIN ? 0 : tierOf(w),
      k: Math.min(1.3, Math.max(1, w / 1000)),
    };
  }

  function paint(el) {
    var st = el.__rc;
    if (!st) return;
    var data = st.data, opts = st.opts;
    var rows = data.rows || [];
    var sire = data.sire || "";
    var base = data.base || "";
    /* 宿主联动：每次重绘都重新挂（宿主可能换人/换数据源）；本轮是否出现自译名也重置 */
    HOST = (opts && opts.host) || {};
    selfNameSeen = false;
    var M = widthMeta(el);
    el.__rcMode = M.mode + "|" + M.tier;

    /* ---- 赛事分类过滤（中央 / 地方 / 海外）：纯前端过滤，不重新取数、不写存储 ----
       计数口径（2026-11-11 定稿）：chips 与「共 X 頭」只统计**未来（含今天）**的出走——
       出走表是前瞻视图，最近一周折叠区只是兜底可查，不该把头部数字撑大。 */
    var scope = el.__rcScope || "all";
    var today = todayBJ();
    var futureAll = [], pastAll = [];
    rows.forEach(function (r) { (r.date >= today ? futureAll : pastAll).push(r); });
    var counts = { all: futureAll.length, jra: 0, nar: 0, ov: 0 };
    futureAll.forEach(function (r) { counts[scopeOf(r)]++; });
    el.__rcScope = scope;   /* 允许选中 0 条的分类（如海外），此时给出对应的空态而不是偷偷切回全部 */
    var byScope = function (rs) {
      return scope === "all" ? rs : rs.filter(function (r) { return scopeOf(r) === scope; });
    };
    var futureRows = byScope(futureAll);   /* 主视图 = 未来（含今天） */
    var pastRows = byScope(pastAll);       /* 底部折叠区 = 最近一周兜底（同受分类过滤） */

    var nR = 0, seen = {};
    futureRows.forEach(function (r) { var k = raceKey(r); if (!seen[k]) { seen[k] = 1; nR++; } });

    var title = opts.title || (sire ? sire + " 产驹 · 近期出走" : "出走表 · 近期出走");
    /* 四个分类恒定展示（2026-11-07 用户要求：海外没有比赛也要有按钮）。
       计数为 0 的照样可点 —— 点进去是「暂无…」空态，比按钮直接消失更好理解。 */
    var scopeHTML = futureAll.length
      ? '<span class="rc-emb-scopes">' + SCOPES.map(function (x) {
          return '<button type="button" class="rc-emb-scope' + (x.k === scope ? " on" : "") +
            (counts[x.k] === 0 ? " is-zero" : "") +
            '" data-scope="' + x.k + '">' + esc(x.label) +
            "<b>" + counts[x.k] + "</b></button>";
        }).join("") + "</span>"
      : "";
    var h = '<div class="rc-emb-head">' +
      '<span class="rc-emb-title">' + esc(title) + "</span>" +
      '<span class="rc-emb-sum">共 <b>' + futureRows.length + "</b> 頭<i>·</i>" + nR + " R</span>" +
      scopeHTML +
      /* 「Racing Calendar ↗」外链默认关闭（2026-11-11：MB/PC 两端都去掉——
         兄弟站不想到处导流回本站；需要时宿主显式传 opts.link = true） */
      (opts.link === true && base
        ? '<span class="rc-emb-home"><a href="' + esc(base + "/") + '" target="_blank" rel="noopener">Racing Calendar ↗</a></span>'
        : "") +
      "</div>";

    if (!futureRows.length) {
      var scopeName = (SCOPES.filter(function (x) { return x.k === scope; })[0] || {}).label || "";
      h += '<div class="rc-emb-state"><div>窗口期内暂无' + (sire ? esc(sire) + " 产驹" : "") +
        (scope !== "all" ? "在" + esc(scopeName) + "的" : "的") + "出走记录</div></div>";
      el.innerHTML = wrap(h);
      return;
    }

    /* 彩衣：整批一条都没有（纯海外源 / 未覆盖马主，含折叠区）→ 整列不摆 —— 空列比缺列更费解 */
    var withSilk = futureRows.concat(pastRows).some(function (r) { return !!r.silk; });
    var build = M.mode === "cards"
      ? function (rs) { return cardsHTML(rs, base); }
      : function (rs) { return tableHTML(rs, M.tier, base, withSilk); };

    if (futureRows.length) h += build(futureRows);
    if (pastRows.length) {
      var first = pastRows[0].date, last = pastRows[pastRows.length - 1].date;
      h += '<details class="rc-emb-past"><summary>最近一周 ' + pastRows.length + " 頭（" +
        esc(mdJP(first)) + " ~ " + esc(mdJP(last)) + "）</summary>" +
        build(pastRows) + "</details>";
    }
    /* * 号说明：只在确有自译名时出现（2026-11-08 定稿文案「* 为自译名」） */
    if (selfNameSeen) {
      h += '<div class="rc-emb-note">* 为自译名</div>';
    }
    el.innerHTML = wrap(h);
    /* 字号/行距系数写在容器上，CSS 用 calc(--re-k * Npx) 放大（卡片形态 k 恒为 1） */
    var root = el.firstElementChild;
    if (root && M.k > 1) root.style.setProperty("--re-k", M.k.toFixed(3));
  }

  /* 分类 chips 的点击：事件委托挂在挂载点本身，paint() 重建 innerHTML 后依然有效 */
  function wire(el) {
    if (el.__rcWired) return;
    el.__rcWired = true;
    el.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== el && !(t.getAttribute && t.getAttribute("data-scope"))) t = t.parentNode;
      if (!t || t === el) return;
      var k = t.getAttribute("data-scope");
      if (!k || k === el.__rcScope) return;
      el.__rcScope = k;
      paint(el);
    });
  }

  function render(el, data, opts) {
    injectStyle();
    wire(el);
    el.__rc = { data: data, opts: opts || {} };
    paint(el);
  }

  /* 只监听「自身宽度跨过断点」：同形态内的尺寸变化不需要重绘 */
  var ro = null;
  function observe(el) {
    if (typeof ResizeObserver === "undefined") return;
    if (!ro) {
      ro = new ResizeObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var t = entries[i].target;
          if (!t.__rc) continue;
          var M = widthMeta(t);
          if (t.__rcMode !== M.mode + "|" + M.tier) { paint(t); continue; }
          /* 档位没变、只是宽度变了：只更新字号系数，不必重排 DOM */
          var root = t.firstElementChild;
          if (root) root.style.setProperty("--re-k", M.k.toFixed(3));
        }
      });
    }
    ro.observe(el);
  }

  /* ---------- mount（load + render + 状态管理；宿主一行挂载） ---------- */
  function mount(el, opts) {
    opts = opts || {};
    injectStyle();
    var base = String(opts.base || "").replace(/\/+$/, "");
    observe(el);
    wire(el);
    el.innerHTML = wrap('<div class="rc-emb-state"><span class="rc-emb-spin"></span>出走表加载中…</div>');
    return load(base, opts).then(function (data) {
      render(el, data, opts);
      return data;
    }).catch(function (e) {
      el.innerHTML = wrap('<div class="rc-emb-state"><div>出走表暂时加载失败（' + esc(e.message || e) + "）" +
        '<small>Racing Calendar 可能正在部署或网络不可达</small>' +
        '<button type="button" class="rc-emb-retry">重试</button></div></div>');
      var btn = el.querySelector(".rc-emb-retry");
      if (btn) btn.addEventListener("click", function () { mount(el, opts); });
      throw e;
    });
  }

  window.RC_ENTRIES_EMBED = { VERSION: VERSION, load: load, render: render, mount: mount };
})();
