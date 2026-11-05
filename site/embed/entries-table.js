/* ============================================================
 * entries-table.js —— Racing Calendar 出走表 嵌入式组件（零依赖 · 单文件）
 * ------------------------------------------------------------
 * 定位（2026-11-02 与云迹定稿）：本仓库对外发布的「出走表结果组件」，供
 *   种马档案站（yunji-web / kzn-web …）一行挂载——对齐兄弟站统一引用模式
 *   （jbis-sire-rank-history embed/sire-rank-chart.js 同款）：宿主给
 *   一个挂载点 + 种马名，得到一个简洁的「该種牡馬产驹近期出走」结果视图。
 *   不照搬主站全功能页（无多维筛选卡/分享卡/CSV/Excel），只出结果。
 *
 * 视图（v1.2.0）= JBIS 出馬表式「按日期分组的表格」：
 *   「11月4日（水）」+ 绿色短线 → 表头 開催/レース名/芝ダ/距離/出走頭数/発走/
 *   枠番/馬番/出走馬/性齢/斤量/騎手 → 灰底表头、按场次交替底色、圆角边框。
 *   同一场比赛的多匹产驹共用一组 rowspan 场次单元格（= 出馬表原生读法）。
 *   v1.2.0 起：発走/性齢/斤量/騎手 由副行拆成独立列（PC 宽屏铺开），
 *   赛事名做显示层清洗（去「サラ系」前缀 / 去场次号前缀 / 超长欧美冠名只留类型短语）。
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
 *   RC_ENTRIES_EMBED.render(el, data, opts)                      纯渲染
 *   RC_ENTRIES_EMBED.mount(el, opts)   → Promise                load + render + 状态管理
 *
 * opts：
 *   base    （必填）本站根 URL，如 "https://hinotoyk.github.io/racing-calendar/"
 *   sire    （必填）種牡馬日文名（JBIS 原形；宿主从自家 config 的种马名取，
 *           与数据行 sire 字段同源同写法）。未传/空 → 不按种马筛（出全表，调试用）
 *   days    未来侧展示的有数据日期数（默认 4）；今天之前的日期收进底部
 *           <details>「最近一周」折叠区（出走表是前瞻视图，历史只做兜底可查）
 *   title   头部标题（默认 "<sire> 产驹 · 近期出走"）
 *   link    头部是否带「Racing Calendar ↗」外链（默认 true）
 *
 * 数据契约 = docs/DESIGN.md §2：derived/index.json（dates 概览）+
 *   derived/{date}.json（race.rows.bundle/v1 字典包，本文件内联 unpackRows 解码——
 *   单一出处 src/lib/rows-codec.mjs，内联副本改动必须同步该文件）。
 *
 * 视觉：亮色单主题；颜色走宿主 CSS 变量（--foreground/--muted-foreground/--border/
 *   --primary/--accent…，缺省回退 #0aa7a0 × shadcn Neutral 与本站同 token），
 *   与 friend-links.js 归一化变量同一做法——宿主换肤组件跟随。枠色/级别徽章 =
 *   JRA 官方枠色与 JBIS 徽章配色（数据语义，与主站 .waku/.yj-g* 同源写死）。
 * ============================================================ */
(function () {
  "use strict";

  var VERSION = "1.2.0";

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

  /* ---------- 视觉素材（数据语义，与主站 .waku / .yj-g* 同源写死） ---------- */
  var WAKU = {
    1: ["#ffffff", "#0a0a0a", "#b6bcc2"], 2: ["#26262a", "#ffffff"],
    3: ["#d0342c", "#ffffff"], 4: ["#2b62b0", "#ffffff"], 5: ["#f2c500", "#4a3b00"],
    6: ["#1e7d46", "#ffffff"], 7: ["#e8791e", "#ffffff"], 8: ["#ef8bab", "#8c2748"],
  };
  var LEVEL_BG = {
    G1: "#d5302a", Jpn1: "#d5302a", JG1: "#d5302a", GI: "#d5302a",
    G2: "#0a3b7e", Jpn2: "#0a3b7e", JG2: "#0a3b7e", GII: "#0a3b7e",
    G3: "#087220", Jpn3: "#087220", JG3: "#087220", GIII: "#087220",
    L: "#dca026", OP: "rgba(10,167,160,.15)", 地方重赏: "#c2318e",
  };
  var LEVEL_FG = { OP: "#0a7a75" };
  /* 芝ダ列：芝=绿、ダ=褐、障=灰（与 JBIS 表内文字色同语义，弱化不抢眼） */
  var SURF_FG = { 芝: "#0a7a3f", ダ: "#8a5a2b", 障: "#5c5c5c", AW: "#0a7a3f" };

  /* ---------- 样式（一次性注入；颜色走宿主 CSS 变量，缺省回退同站 token） ---------- */
  var styleEl = null;
  function injectStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.id = "rc-emb-style";
    styleEl.textContent = [
      ".rc-emb{--re-fg:var(--foreground,#171717);--re-muted:var(--muted-foreground,#737373);",
      "--re-border:var(--border,#e5e5e5);--re-faint:var(--border-faint,#f0f0f0);",
      "--re-primary:var(--primary,#0aa7a0);--re-accent:var(--accent,#e6f6f5);",
      "--re-accent-fg:var(--accent-foreground,#0b6b64);--re-muted-bg:var(--muted,#f5f5f5);",
      "--re-card:var(--card,#fff);",
      "font-variant-numeric:tabular-nums;color:var(--re-fg)}",
      ".rc-emb a{color:var(--re-primary)}",
      /* 头行 */
      ".rc-emb-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-bottom:14px}",
      ".rc-emb-title{font-size:14.5px;font-weight:700}",
      ".rc-emb-sum{font-size:12.5px;color:var(--re-muted)}",
      ".rc-emb-sum b{color:var(--re-primary);font-weight:600}",
      ".rc-emb-tz{margin-left:3px;opacity:.8}",
      ".rc-emb-home{margin-left:auto;font-size:11.5px;color:var(--re-muted)}",
      ".rc-emb-home a{color:var(--re-muted);text-decoration:none;border-bottom:1px dashed var(--re-border)}",
      ".rc-emb-home a:hover{color:var(--re-primary);border-bottom-color:var(--re-primary)}",
      /* 日期分组头（「11月4日（水）」+ 绿色短线） */
      ".rc-emb-day{margin-bottom:16px}",
      ".rc-emb-day:last-child{margin-bottom:0}",
      ".rc-emb-dayhead{display:flex;align-items:baseline;gap:0 5px;min-width:0}",
      ".rc-emb-dayd{font-size:15px;font-weight:700;letter-spacing:.01em;white-space:nowrap}",
      ".rc-emb-dayw{font-size:12.5px;font-weight:600;color:var(--re-muted);white-space:nowrap;margin-left:-3px}",
      ".rc-emb-dayn{margin-left:auto;font-size:11.5px;color:var(--re-muted);white-space:nowrap}",
      ".rc-emb-dayline{width:32px;height:2px;border-radius:1px;background:var(--re-primary);margin:6px 0 10px}",
      /* 表格外框（容器过窄时横向滚动，保住出馬表列结构） */
      ".rc-emb-scroll{overflow-x:auto;border:1px solid var(--re-border);border-radius:9px;",
      "background:var(--re-card);-webkit-overflow-scrolling:touch}",
      ".rc-emb-tbl{width:100%;min-width:700px;table-layout:fixed;border-collapse:separate;",
      "border-spacing:0;font-size:13px}",
      ".rc-emb-tbl th{background:var(--re-muted-bg);color:var(--re-muted);font-size:11.5px;font-weight:600;",
      "padding:8px 7px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--re-border);",
      "font-feature-settings:'palt' 1;letter-spacing:.01em}",
      ".rc-emb-tbl th.c,.rc-emb-tbl td.c{text-align:center}",
      ".rc-emb-tbl td{padding:8px 7px;border-top:1px solid var(--re-faint);vertical-align:middle}",
      ".rc-emb-tbl tbody tr:first-child td{border-top:0}",
      /* 按场次交替底色（rowspan 合并块整体同色，读起来是一场一段） */
      ".rc-emb-tbl tr.alt td{background:rgba(10,167,160,.03)}",
      ".rc-emb-tbl tbody tr:hover td{background:rgba(10,167,160,.065)}",
      /* 開催 */
      ".rc-emb-ven{display:block;font-size:13px;font-weight:600;white-space:nowrap;line-height:1.4}",
      /* レース名 */
      ".rc-emb-rname{font-size:13px;font-weight:600;line-height:1.45;word-break:break-word}",
      ".rc-emb-rno{display:inline-block;min-width:25px;margin-right:6px;padding:0 4px;border-radius:4px;",
      "background:var(--re-accent);color:var(--re-accent-fg);font-size:11px;font-weight:700;",
      "text-align:center;vertical-align:1px}",
      ".rc-emb-g{display:inline-block;margin-left:5px;padding:1px 5px;border-radius:4px;font-size:10px;",
      "font-weight:700;line-height:1.5;color:#fff;vertical-align:1px}",
      /* 芝ダ / 距離 / 出走頭数 / 発走 */
      ".rc-emb-surf{font-size:12.5px;font-weight:700}",
      ".rc-emb-num2{font-size:12.5px;color:var(--re-fg)}",
      ".rc-emb-time{font-size:13px;font-weight:600;color:var(--re-fg)}",
      /* 枠番（JRA 枠色芯片） */
      ".rc-emb-waku{display:inline-flex;width:19px;height:19px;align-items:center;justify-content:center;",
      "border-radius:4px;font-size:10.5px;font-weight:700;line-height:1}",
      /* 馬番 */
      ".rc-emb-uma{font-size:13.5px;font-weight:600}",
      /* 出走馬 */
      ".rc-emb-hname{font-size:14px;font-weight:600;line-height:1.4;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap}",
      /* 性齢 / 斤量 / 騎手 */
      ".rc-emb-age{font-size:12.5px;color:var(--re-muted);white-space:nowrap}",
      ".rc-emb-wt{font-size:13px;color:var(--re-fg);white-space:nowrap}",
      ".rc-emb-jk{font-size:12.5px;color:var(--re-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      /* 折叠（最近一周） */
      ".rc-emb-past{margin-top:14px}",
      ".rc-emb-past>summary{cursor:pointer;list-style:none;font-size:11.5px;color:var(--re-muted);",
      "padding:7px 2px;border-top:1px dashed var(--re-border)}",
      ".rc-emb-past>summary::-webkit-details-marker{display:none}",
      ".rc-emb-past>summary:hover{color:var(--re-accent-fg)}",
      ".rc-emb-past>summary::before{content:'▸ ';font-size:10px}",
      ".rc-emb-past[open]>summary::before{content:'▾ '}",
      ".rc-emb-past[open]>summary{border-bottom:1px dashed var(--re-border);margin-bottom:14px}",
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
      /* 窄容器：fit=1 收 芝ダ/距離/性齢/斤量，fit=2 再收 発走/騎手 →
         只留 開催/レース名/枠番/馬番/出走馬（马名永不被挤出视口）。
         注意：**不能用 @media**——组件挂在宿主 iframe 里，视口宽 ≠ 卡片内容宽
         （宿主还要减去侧栏、90% 宽度、卡片内距），实测 1024px 窗口时按视口算会误判成「放得下」，
         11 列被裁掉右半边。改用 ResizeObserver 量组件自身宽度后打 data-fit（见 fit()）。 */
      '.rc-emb[data-fit="1"] .rc-emb-tbl,.rc-emb[data-fit="2"] .rc-emb-tbl{min-width:0;table-layout:auto}',
      '.rc-emb[data-fit="1"] .rc-emb-tbl col,.rc-emb[data-fit="2"] .rc-emb-tbl col{width:auto!important}',
      '.rc-emb[data-fit="1"] .nw1,.rc-emb[data-fit="2"] .nw1,.rc-emb[data-fit="2"] .nw2{display:none}',
      '.rc-emb[data-fit="1"] .rc-emb-hname,.rc-emb[data-fit="2"] .rc-emb-hname{',
      'white-space:normal;overflow:visible;text-overflow:clip}',
    ].join("");
    document.head.appendChild(styleEl);
  }

  function wakuChip(f) {
    var c = WAKU[f];
    if (!c) return '<span class="rc-emb-num2">' + esc(f == null ? "" : f) + "</span>";
    var bg = c[0], fg = c[1], line = c[2] ? "box-shadow:inset 0 0 0 1px " + c[2] + ";" : "";
    return '<span class="rc-emb-waku" style="background:' + bg + ";color:" + fg + ";" + line + '">' +
           esc(f) + "</span>";
  }
  function levelBadge(level) {
    var bg = LEVEL_BG[level];
    if (!bg) return "";
    var fg = LEVEL_FG[level] || "#ffffff";
    return '<span class="rc-emb-g" style="background:' + bg + ";color:" + fg + '">' + esc(level) + "</span>";
  }

  /* ---------- 渲染 ---------- */
  function raceKey(r) { return r.raceKey || (r.date + "|" + r.venue + "|" + (r.raceNo ?? "")); }

  /* nw1 = ≤1080px 收起；nw2 = ≤620px 再收起。场次列（rowspan 组）在前，马列在后。
     v1.2.1：発走 提到レース名 之后（时刻紧挨场次，符合读表顺序）；「出走頭数」删去
     （对「看这匹马跑哪场」无信息量，且挤占字号空间）。 */
  var COLS = [
    { k: "開催", cls: "" },
    { k: "レース名", cls: "" },
    { k: "発走", cls: "c", nw: 2 },
    { k: "芝ダ", cls: "c", nw: 1 },
    { k: "距離", cls: "c", nw: 1 },
    { k: "枠番", cls: "c" },
    { k: "馬番", cls: "c" },
    { k: "出走馬", cls: "" },
    { k: "性齢", cls: "c", nw: 1 },
    { k: "斤量", cls: "c", nw: 1 },
    { k: "騎手", cls: "", nw: 2 },
  ];
  /* 列宽（table-layout:fixed 下按百分比分配，合计 100%；min-width 720px 兜底） */
  var COLW = ["7%", "19%", "7.5%", "5.5%", "6.5%", "5.5%", "5.5%", "20%", "5.5%", "7%", "11%"];

  function colClass(c) {
    return [c.cls, c.nw === 1 ? "nw1" : c.nw === 2 ? "nw2" : ""].filter(Boolean).join(" ");
  }

  /* 一个日期 → 一张表（场次按时间升序；同场多匹产驹共用一个 rowspan 块） */
  function dayTable(date, weekday, rows) {
    var races = [], map = {};
    rows.forEach(function (r) {
      var k = raceKey(r);
      if (!map[k]) { map[k] = { rows: [] }; races.push(map[k]); }
      map[k].rows.push(r);
    });

    var body = "";
    races.forEach(function (race, ri) {
      var alt = ri % 2 === 1 ? " alt" : "";
      race.rows.forEach(function (r, i) {
        body += "<tr" + alt + ">";
        if (i === 0) {
          var span = ' rowspan="' + race.rows.length + '"';
          var surf = String(r.surface || "");
          body +=
            "<td" + span + '><span class="rc-emb-ven">' + esc(r.venue || "—") + "</span></td>" +
            "<td" + span + '><div class="rc-emb-rname">' +
              '<span class="rc-emb-rno">' + esc(r.raceNo ?? "") + "R</span>" +
              esc(cleanRaceName(r.raceName)) + levelBadge(r.level) +
            "</div></td>" +
            '<td class="c nw2"' + span + '><span class="rc-emb-time">' + esc(bjTime(r.startTimeInstant)) + "</span></td>" +
            '<td class="c nw1"' + span + '><span class="rc-emb-surf" style="color:' +
              esc(SURF_FG[surf] || "inherit") + '">' + esc(surf || "—") + "</span></td>" +
            '<td class="c nw1"' + span + '><span class="rc-emb-num2">' + esc(r.distance ?? "—") + "</span></td>";
        }
        body +=
          '<td class="c">' + wakuChip(r.frame) + "</td>" +
          '<td class="c"><span class="rc-emb-uma">' + esc(r.num ?? "") + "</span></td>" +
          '<td><div class="rc-emb-hname" title="' + esc(r.horseName || "") + '">' + esc(r.horseName || "") + "</div></td>" +
          '<td class="c nw1"><span class="rc-emb-age">' +
            esc((r.sex || "") + (r.age != null ? r.age : "")) + "</span></td>" +
          '<td class="c nw1"><span class="rc-emb-wt">' +
            (r.weight != null ? esc(r.weight) + "kg" : "") + "</span></td>" +
          '<td class="nw2"><span class="rc-emb-jk">' + esc(r.jockey || "") + "</span></td>" +
          "</tr>";
      });
    });

    return '<div class="rc-emb-day">' +
      '<div class="rc-emb-dayhead">' +
        '<span class="rc-emb-dayd">' + esc(mdJP(date)) + "</span>" +
        (weekday ? '<span class="rc-emb-dayw">（' + esc(weekday) + "）</span>" : "") +
        '<span class="rc-emb-dayn">' + rows.length + " 頭 / " + races.length + " R</span>" +
      "</div>" +
      '<div class="rc-emb-dayline"></div>' +
      '<div class="rc-emb-scroll"><table class="rc-emb-tbl">' +
        "<colgroup>" + COLW.map(function (w) {
          return '<col style="width:' + w + '">';
        }).join("") + "</colgroup>" +
        "<thead><tr>" + COLS.map(function (c) {
          var cls = colClass(c);
          return "<th" + (cls ? ' class="' + cls + '"' : "") + ">" + esc(c.k) + "</th>";
        }).join("") + "</tr></thead>" +
        "<tbody>" + body + "</tbody>" +
      "</table></div>" +
    "</div>";
  }

  /* 行集 → 按日期分组的多张表（保持时间升序） */
  function dayTables(rows) {
    var order = [], byDate = {};
    rows.forEach(function (r) {
      var d = r.date || "";
      if (!byDate[d]) { byDate[d] = { weekday: r.weekday || "", rows: [] }; order.push(d); }
      byDate[d].rows.push(r);
    });
    return order.map(function (d) {
      return dayTable(d, byDate[d].weekday, byDate[d].rows);
    }).join("");
  }

  /* 所有输出统一套 .rc-emb 容器——CSS 变量（--re-*）定义在它身上，
     少了这层包裹 var(--re-primary) 等全部失效（绿线/灰表头/边框会凭空消失） */
  function setHTML(el, inner) {
    el.innerHTML = '<div class="rc-emb">' + inner + "</div>";
    fit(el);
  }

  /* 按组件自身宽度打收起档位（不依赖宿主视口）：
     ≥700 全列（11 列 fixed 布局） / 560–700 收 4 列 / <560 再收 2 列 */
  function fit(el) {
    var root = el.firstElementChild;
    if (!root) return;
    var w = el.clientWidth || 0;
    root.setAttribute("data-fit", w < 560 ? "2" : w < 700 ? "1" : "0");
  }
  var ro = null;
  function observe(el) {
    if (typeof ResizeObserver === "undefined") return;
    if (!ro) {
      ro = new ResizeObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) fit(entries[i].target);
      });
    }
    ro.observe(el);
  }

  function render(el, data, opts) {
    opts = opts || {};
    injectStyle();
    var rows = data.rows || [];
    var sire = data.sire || "";
    var base = data.base || "";
    var nR = 0, seen = {};
    rows.forEach(function (r) { var k = raceKey(r); if (!seen[k]) { seen[k] = 1; nR++; } });

    var title = opts.title || (sire ? sire + " 产驹 · 近期出走" : "出走表 · 近期出走");
    var h = '<div class="rc-emb-head">' +
      '<span class="rc-emb-title">' + esc(title) + "</span>" +
      '<span class="rc-emb-sum">共 <b>' + rows.length + "</b> 頭 · " + nR + " R" +
        '<span class="rc-emb-tz">· 北京時刻</span></span>' +
      (opts.link !== false && base
        ? '<span class="rc-emb-home"><a href="' + esc(base + "/") + '" target="_blank" rel="noopener">Racing Calendar ↗</a></span>'
        : "") +
      "</div>";

    if (!rows.length) {
      h += '<div class="rc-emb-state"><div>窗口期内暂无' + (sire ? esc(sire) + " 产驹" : "") + "的出走记录" +
        "<small>出馬表通常在开赛前 1–2 日公开；也可到 Racing Calendar 查看完整窗口</small></div></div>";
      setHTML(el, h);
      return;
    }

    var today = todayBJ();
    var futureRows = rows.filter(function (r) { return r.date >= today; });
    var pastRows = rows.filter(function (r) { return r.date < today; });

    h += futureRows.length ? dayTables(futureRows) : "";
    if (pastRows.length) {
      var first = pastRows[0].date, last = pastRows[pastRows.length - 1].date;
      h += '<details class="rc-emb-past"><summary>最近一周 ' + pastRows.length + " 頭（" +
        esc(mdJP(first)) + " ~ " + esc(mdJP(last)) + "）</summary>" +
        dayTables(pastRows) + "</details>";
    }
    setHTML(el, h);
  }

  /* ---------- mount（load + render + 状态管理；宿主一行挂载） ---------- */
  function mount(el, opts) {
    opts = opts || {};
    injectStyle();
    var base = String(opts.base || "").replace(/\/+$/, "");
    observe(el);
    setHTML(el, '<div class="rc-emb-state"><span class="rc-emb-spin"></span>出走表加载中…</div>');
    return load(base, opts).then(function (data) {
      render(el, data, opts);
      return data;
    }).catch(function (e) {
      setHTML(el, '<div class="rc-emb-state"><div>出走表暂时加载失败（' + esc(e.message || e) + "）" +
        '<small>Racing Calendar 可能正在部署或网络不可达</small>' +
        '<button type="button" class="rc-emb-retry">重试</button></div></div>');
      el.querySelector(".rc-emb-retry").addEventListener("click", function () { mount(el, opts); });
      throw e;
    });
  }

  window.RC_ENTRIES_EMBED = { VERSION: VERSION, load: load, render: render, mount: mount };
})();
