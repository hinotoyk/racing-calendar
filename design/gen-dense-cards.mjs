// 临时演示：保持现有「紧凑表」信息密度（12 列 / 24px 行高 / 比赛合并列）的简约化方案 + 枠番馬番对齐对比
// 数据源：_site/derived/2026-11-08.json 真实采集数据；彩衣 base64 内嵌，单文件自包含
// 产出：design/dense-cards-demo.html
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const j = JSON.parse(fs.readFileSync(path.join(ROOT, "_site/derived/2026-11-08.json"), "utf8"));
const { k: keys, s, dict, rows } = j;
const strSet = new Set(s);
const all = rows.map((row) => {
  const o = {};
  keys.forEach((k, i) => { const v = row[i]; if (v == null) return; o[k] = strSet.has(i) ? dict[v] : v; });
  return o;
});

// 选两场：一场两位数馬号（>=12頭）、一场一位数（<=9頭）——用来验证跨比赛组对齐
const groups = new Map();
for (const r of all) {
  const k = `${r.track}|${r.raceNo}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const jra = [...groups.values()].filter((g) => g[0].scope === "JRA");
const big = jra.filter((g) => g.length >= 12).sort((a, b) => b.length - a.length)[0];
const small = jra.filter((g) => g.length <= 9 && g.length >= 4).sort((a, b) => b.length - a.length)[0];
const picked = [big, small].filter(Boolean);
const heads = picked.reduce((n, g) => n + g.length, 0);

// 彩衣内嵌
const silkMap = new Map();
for (const r of all) {
  if (!r.silk || silkMap.has(r.silk)) continue;
  const p = path.join(ROOT, r.silk);
  if (fs.existsSync(p)) silkMap.set(r.silk, "data:image/gif;base64," + fs.readFileSync(p).toString("base64"));
}

// ③-补 级别徽章：完全复用原项目 site/app.js 的 levelBadge() 渲染口径
//（LEVEL_CLS 映射 + .yj-grade / .yj-* JBIS 配色 + 半角文案），不再自造青绿色 G2 方块
const LEVEL_CLS = {
  G1: "g1", Jpn1: "g1", JG1: "g1",
  G2: "g2", Jpn2: "g2", JG2: "g2",
  G3: "g3", Jpn3: "g3", JG3: "g3",
  L: "listed", OP: "open", 地方重赏: "nar",
};
const levelBadge = (level) => {
  const c = LEVEL_CLS[level];
  return c ? `<span class="yj-grade yj-${c}">${esc(level)}</span>` : "";
};
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
// ① セン → セ：性齢列由 2 字降到 1 字，不再出现「セ…」截断；与 SEX_C 配色键一致
const sexNorm = (v) => (v === "セン" ? "セ" : (v ?? ""));
// ② 列宽按真实内容动态测算：全角 1em / 半角 .55em（片假名全角、(USA) 半角）
const textW = (str, px) => {
  let w = 0;
  for (const ch of String(str ?? "")) w += /[\x00-\xff]/.test(ch) ? px * 0.55 : px;
  return w;
};
const dynMax = (get, px) => {
  let m = 0;
  for (const g of picked) for (const h of g) m = Math.max(m, textW(get(h), px));
  return m;
};
const raceNameMax = () => {
  let m = 0;
  for (const g of picked) m = Math.max(m, textW(g[0].raceName, 13.5) + (g[0].level && g[0].level !== "无级别" ? 30 : 0));
  return m;
};
const WAKU = ["", "#ffffff", "#171717", "#e60012", "#0072bc", "#f5c400", "#00a651", "#f08300", "#f4a7b9"];
const DARK = new Set([1, 5, 6, 7, 8]);   // 浅底用深字
const wkStyle = (fr) => fr >= 1 && fr <= 8
  ? `background:${WAKU[fr]};color:${DARK.has(fr) ? "#171717" : "#fff"};${fr === 1 ? "box-shadow:inset 0 0 0 1px #d5d5d5;" : ""}`
  : "background:#e9ecef;color:#8a94a0;";
const bjOf = (r) => {
  const d = new Date(r.startTimeInstant);
  d.setTime(d.getTime() - 3600e3);
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
};
const silkImg = (r) => r.silk && silkMap.get(r.silk)
  ? `<img class="silk" src="${silkMap.get(r.silk)}" alt="">` : `<span class="silk"></span>`;

// 单个方案的表：colgroup 固定列宽 → 所有行/所有比赛共享同一栅栏（对齐的根本保证）
// 文本列宽按本页最长内容动态撑开（含 (USA) 这类半角后缀），马名列给足余量 → 不触发省略号
const HORSE_W = Math.max(136, Math.ceil(dynMax((h) => h.horseName, 12.5) + 26));
const SIRE_W  = Math.max(124, Math.ceil(dynMax((h) => h.sire, 11.5) + 20));
const BMS_W   = Math.max(124, Math.ceil(dynMax((h) => h.bms, 11.5) + 20));
const JOCKEY_W = Math.max(84, Math.ceil(dynMax((h) => h.jockey, 11.5) + 20));
const RNAME_W = Math.max(152, Math.ceil(raceNameMax() + 22));
const COLS = [
  ["bj", 100], ["no", 76], ["rname", RNAME_W], ["dist", 66],
  ["wk", 52], ["silk", 30], ["horse", HORSE_W], ["sexage", 44],
  ["weight", 48], ["jockey", JOCKEY_W], ["sire", SIRE_W], ["bms", BMS_W],
];
const TABLE_W = COLS.reduce((n, c) => n + c[1], 0);
const colgroup = `<colgroup>${COLS.map(([k, w]) => `<col class="col-${k}" style="width:${w}px">`).join("")}</colgroup>`;
const headRow = `<thead><tr>
  <th>北京时间</th><th>场次</th><th class="l">比赛名</th><th>距离</th>
  <th>枠番</th><th></th><th class="l">馬名</th><th>性齢</th><th>斤量</th><th class="l">騎手</th><th class="l">父</th><th class="l">母父</th>
</tr></thead>`;

function table(variant) {
  const body = picked.map((g) => {
    const r0 = g[0];
    const n = g.length;
    const badge = levelBadge(r0.level);   // 原项目 levelBadge()：G2 深蓝徽章
    // ② 删掉 JRA（scope）与 GⅡ（klass）两个小标题；四个合并列内容上下 + 左右居中
    const merged = `<td class="merge m-time" rowspan="${n}"><b>${esc(r0.dateLabel)} ${esc(bjOf(r0))}</b><small>当地 ${esc(r0.startTime)}</small></td>
      <td class="merge m-no" rowspan="${n}"><b>${esc(r0.venue)}${r0.raceNo}R</b></td>
      <td class="merge m-name" rowspan="${n}"><span class="rn">${esc(r0.raceName)}${badge}</span></td>
      <td class="merge m-dist" rowspan="${n}"><b>${esc(r0.surface ?? "")}${r0.distance ?? ""}</b></td>`;
    return g.map((h, i) => {
      // 定稿：枠番列统一用方案 A 的单色块（颜色编码枠番、块内显示馬番），一列只留一个数字
      const wkCell = `<td class="c-wk"><i class="wk" style="${wkStyle(Number(h.frame))}">${h.num ?? "–"}</i></td>`;
      return `<tr class="${i === 0 ? "grp-start" : ""}">${i === 0 ? merged : ""}
        ${wkCell}
        <td class="c-silk">${silkImg(h)}</td>
        <td class="c-horse l"><b>${esc(h.horseName)}</b></td>
        <td class="c-sex n">${esc(sexNorm(h.sex))}${h.age ?? ""}</td>
        <td class="c-w n">${h.weight ?? "–"}</td>
        <td class="c-j l">${esc(h.jockey ?? "–")}</td>
        <td class="c-p l">${esc(h.sire ?? "–")}</td>
        <td class="c-p l">${esc(h.bms ?? "–")}</td>
      </tr>`;
    }).join("");
  }).join("");
  return `<div class="scroller"><table class="grid ${variant}" style="width:${TABLE_W}px">${colgroup}${headRow}<tbody>${body}</tbody></table></div>`;
}

function shell(variant, title, sub, inner) {
  return `<section class="proposal ${variant}">
    <div class="p-head">
      <div class="p-title"><span class="p-idx">${title[0]}</span><h2>${title.slice(2)}</h2></div>
      <p>${sub}</p>
    </div>
    <div class="card ${variant}">
      <header class="c-head">
        <div class="c-brand"><span class="c-kicker">RACE CARD</span><h3>出走表</h3></div>
        <div class="c-meta">2026/11/8（日）・JRA ／ 共 ${picked.length} 場 ${heads} 頭</div>
        <div class="c-count">${heads}<small>頭</small></div>
      </header>
      ${inner}
      <footer class="c-foot">racing-calendar ・ 出走確定時点 ・ 斤量 kg</footer>
    </div>
  </section>`;
}

// 对齐前后对比（放大示意，取 1/2/3/8/10/18 号）
const demoNums = [
  { frame: 1, num: 1 }, { frame: 1, num: 2 }, { frame: 2, num: 3 },
  { frame: 4, num: 8 }, { frame: 5, num: 10 }, { frame: 8, num: 18 },
];
const demoSilk = silkMap.get(big?.[0]?.silk) ?? "";
const cmpRows = (mode) => demoNums.map((d) => `
  <div class="cmp-row">
    ${mode === "old"
      ? `<span class="cmp-old-wk" style="${wkStyle(d.frame)}">${d.frame}</span><span class="cmp-old-no">${d.num}</span>`
      : `<span class="cmp-new-wk" style="${wkStyle(d.frame)}">${d.num}</span>`}
    <img class="cmp-silk" src="${demoSilk}" alt="">
    <span class="cmp-name">馬名 XXXXXXX</span>
  </div>`).join("");

const compare = `<section class="compare">
  <div class="cmp-title"><h2>枠番 / 馬番 对齐修复 · 定稿采用单色块</h2><p>同一列里挤两个数字，一位数与两位数宽度不同 → 彩衣和馬名起点逐行漂移。定稿采用右侧方案：把「枠色 × 馬番」合成单个色块（JRA / netkeiba 惯例，即方案 A 样式），颜色编码枠番、块内只写馬番，一列只留一个数字，天然对齐。</p></div>
  <div class="cmp-grid">
    <div class="cmp-box bad"><div class="cmp-tag">现在 · 双数字左对齐</div>${cmpRows("old")}
      <div class="cmp-note">两位数 10 / 18 把彩衣向右顶出去了</div></div>
    <div class="cmp-box good"><div class="cmp-tag">优化 · 单色块（色=枠番，数字=馬番）</div>${cmpRows("new")}
      <div class="cmp-note">所有行彩衣起点 x 完全一致</div></div>
  </div>
</section>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>出馬表 · 同密度简约化方案</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  :root { --table-w: ${TABLE_W}px; }
  body { background:#eceef0; color:#14181c; font-family:"Inter","Helvetica Neue","Hiragino Kaku Gothic ProN","Noto Sans JP","Microsoft YaHei",sans-serif;
         font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased; padding:28px 16px 70px; }
  /* ① 禁止左右滑动：容器宽度直接按表格实际宽度撑开，卡片内不设任何横向滚动 */
  .wrap { width:calc(var(--table-w) + 44px); max-width:none; margin:0 auto; display:flex; flex-direction:column; gap:34px; }
  .intro { background:#fff; border:1px solid #e2e6ea; border-radius:10px; padding:16px 20px; }
  .intro h1 { font-size:17px; letter-spacing:.02em; }
  .intro p { font-size:12.5px; color:#6b7681; line-height:1.75; margin-top:7px; }
  .intro code { background:#f2f5f7; padding:1px 5px; border-radius:4px; font-size:11.5px; }
  .intro .intro-layout { background:#f2f8f7; border-left:3px solid #0aa7a0; border-radius:4px;
                         padding:8px 12px; color:#3d5450; margin-top:10px; }
  .intro .intro-layout b { color:#0b6b64; }

  /* ---- 对齐对比 ---- */
  .compare { background:#fff; border:1px solid #e2e6ea; border-radius:10px; padding:20px; }
  .cmp-title h2 { font-size:15px; }
  .cmp-title p { font-size:12px; color:#6b7681; line-height:1.8; margin-top:6px; max-width:900px; }
  .cmp-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
  .cmp-box { border:1px solid #e6eaee; border-radius:8px; padding:14px 16px 12px; }
  .cmp-box.bad { background:#fff8f7; border-color:#f2d9d6; }
  .cmp-box.good { background:#f6fbf9; border-color:#cfe8df; }
  .cmp-tag { font-size:11px; font-weight:700; letter-spacing:.04em; margin-bottom:10px; }
  .cmp-box.bad .cmp-tag { color:#b04a3f; }
  .cmp-box.good .cmp-tag { color:#17705c; }
  .cmp-row { display:flex; align-items:center; height:26px; gap:4px; border-bottom:1px dashed #e9edf0; }
  .cmp-old-wk, .cmp-new-wk { display:inline-flex; align-items:center; justify-content:center; font-weight:800; font-size:11px; flex:none; }
  .cmp-old-wk { width:16px; height:16px; border-radius:3px; }
  .cmp-old-no { font-weight:800; font-size:12px; width:auto; min-width:0; margin-left:3px; }
  .cmp-new-wk { width:26px; height:18px; border-radius:4px; }
  .cmp-silk { width:18px; height:14px; object-fit:contain; margin-left:6px; flex:none; }
  .cmp-name { font-size:11.5px; color:#5b6570; margin-left:4px; }
  .cmp-note { font-size:10.5px; color:#8a949e; margin-top:10px; }
  .cmp-box.bad .cmp-note { color:#b04a3f; }
  .cmp-box.good .cmp-note { color:#17705c; }

  /* ---- 方案 ---- */
  .proposal { display:flex; flex-direction:column; gap:12px; }
  .p-head { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
  .p-title { display:flex; align-items:center; gap:9px; }
  .p-idx { background:#14181c; color:#fff; font-size:11px; font-weight:700; width:22px; height:22px; border-radius:5px; display:flex; align-items:center; justify-content:center; }
  .p-head h2 { font-size:15.5px; }
  .p-head p { font-size:11.5px; color:#7c8792; }
  .card { border-radius:8px; overflow:hidden; background:#fff; box-shadow:0 2px 12px rgba(20,28,36,.09); }
  .scroller { overflow:visible; padding:0 22px; }
  .c-head { display:flex; align-items:flex-end; gap:16px; padding:18px 22px 12px; }
  .c-brand .c-kicker { font-size:9px; letter-spacing:.32em; font-weight:700; color:#8a949e; }
  .c-brand h3 { font-size:25px; letter-spacing:.04em; line-height:1.15; margin-top:2px; }
  .c-meta { font-size:11px; color:#8a949e; margin-left:auto; padding-bottom:3px; }
  .c-count { font-size:25px; font-weight:800; line-height:1; padding-bottom:2px; }
  .c-count small { font-size:10px; font-weight:600; margin-left:2px; }
  .c-foot { font-size:9.5px; color:#a0a9b2; letter-spacing:.06em; text-align:right; padding:8px 22px 12px; }

  /* 表格通用：table-layout fixed + colgroup 定宽 = 列栅栏 */
  .grid { table-layout:fixed; border-collapse:collapse; font-size:12px; }
  .grid th { font-size:10.5px; font-weight:700; letter-spacing:.06em; color:#98a2ac; padding:7px 6px 6px; text-align:right; white-space:nowrap; }
  .grid th.l { text-align:left; }
  .grid td { height:24px; padding:0 7px; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:clip; }
  .grid td.l { text-align:left; }
  .grid td.n { text-align:right; }
  .grid .c-horse b { font-size:12.5px; font-weight:700; }
  .grid .c-j, .grid .c-p { color:#5f6a75; font-size:11.5px; }
  .grid .c-p { color:#8a949e; }
  .grid .c-sex { font-weight:600; }
  .grid .c-wk { text-align:center; }
  /* ② 比赛级合并列：上下 + 左右双向居中（rowspan 整场内垂直居中） */
  .grid td.merge { text-align:center; vertical-align:middle; padding:0 6px !important; border-right:1px solid #eef1f4; }
  .grid td.merge b { font-weight:700; font-size:13px; }
  .grid td.merge small { display:block; font-size:10.5px; color:#a0a9b2; margin-top:3px; }
  .grid td.merge.m-time b { color:#17705c; }
  .grid td.merge.m-name .rn { font-size:13.5px; font-weight:700; }
  .grid td.merge.m-dist b { font-size:12.5px; }
  .wk { display:inline-flex; width:22px; height:18px; border-radius:4px; align-items:center; justify-content:center;
        font-style:normal; font-size:11px; font-weight:800; letter-spacing:-.03em; vertical-align:middle; }
  .silk { display:inline-block; width:18px; height:14px; object-fit:contain; vertical-align:middle; }
  /* ③-补 原项目 site/style.css 的等级徽章样式（JBIS 配色）；徽章置于比赛名之后，margin-left 与原项目一致 */
  .yj-grade { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:4px;
              font-size:10.5px; font-weight:700; line-height:1.5; color:#fff; vertical-align:1px; }
  .yj-g1 { background-color:#d5302a; }
  .yj-g2 { background-color:#0a3b7e; }
  .yj-g3 { background-color:#087220; }
  .yj-listed { background-color:#dca026; }
  .yj-open { background-color:rgba(10,167,160,.15); color:#0a7a75; }
  .yj-nar { background-color:#c2318e; }

  /* A · 编辑部极简：无竖线、单色系、青绿只作点缀 */
  .v-a .card { border-top:3px solid #17705c; }
  .v-a .c-count { color:#17705c; }
  .v-a .grid th { border-bottom:1.5px solid #14181c; color:#6b7681; padding-bottom:7px; }
  .v-a .grid td { border-bottom:1px solid #f1f3f5; }
  .v-a .grid tr.grp-start td { border-top:1.5px solid #d8dee3; }
  .v-a .grid tr:nth-child(even) td { background:#fafbfc; }
  .v-a .grid .merge { border-right:1px solid #eaeef1; }
  .v-a .grid tr.grp-start .merge.m-no::before { content:""; }

  /* B · 报纸印刷：米色纸、墨色双线、最紧行距、零斑马 */
  .v-b .card { background:#fbf8f1; border-top:4px double #2a2620; }
  .v-b .c-head { border-bottom:1.5px solid #2a2620; margin:0; padding:18px 22px 12px; }
  .v-b .c-brand h3 { font-family:Georgia,"Noto Serif SC","Hiragino Mincho ProN",serif; letter-spacing:.24em; font-size:27px; }
  .v-b .c-kicker { color:#9a8f7d; }
  .v-b .c-meta, .v-b .c-foot { color:#9a8f7d; }
  .v-b .c-foot { margin:0; padding:8px 22px 12px; }
  .v-b .grid { font-size:11.5px; }
  .v-b .grid th { border-bottom:1.5px solid #2a2620; color:#8a7d68; font-family:Georgia,serif; letter-spacing:.06em; }
  .v-b .grid td { border-bottom:1px solid #e9e2d3; }
  .v-b .grid tr.grp-start td { border-top:1px solid #bdb3a0; }
  .v-b .grid .merge { border-right:1px solid #ded6c4; }
  .v-b .merge.m-time b { color:#2a2620; }
  .v-b .c-horse b { font-size:12px; }
  .v-b .c-count { color:#2a2620; }

  /* C · 冷灰网格（定稿）：极淡结构网格 + 青绿强调；枠番列用方案 A 单色块 */
  .v-c .card { border-top:3px solid #0aa7a0; }
  .v-c .c-count { color:#0aa7a0; }
  .v-c .grid th { background:#f3f5f7; border-bottom:1px solid #d9dee3; color:#7c8792; }
  .v-c .grid td { border-bottom:1px solid #f0f2f4; }
  .v-c .grid tr.grp-start td { border-top:1px solid #cfd6dc; }
  .v-c .grid tr:nth-child(even) td { background:#fafbfc; }
  .v-c .grid .c-wk, .v-c .grid .c-silk, .v-c .grid .merge { border-right:1px solid #eef1f4; }
  .v-c .merge.m-time b { color:#0b6b64; }
</style>
</head>
<body>
<div class="wrap">
  <div class="intro">
    <h1>出馬表 · 定稿：冷灰网格（枠番用方案 A 样式）</h1>
    <p class="intro-layout"><b>版式归属：紧凑一览</b>（<code>layout=dense</code> / <code>site/share.js → drawDense()</code>，项目默认版式）。特征：平面大表、比赛级信息纵向合并成列、连续行、无每场独立块头。另一个版式「逐场分卡」（<code>layout=cards</code> / <code>drawCards()</code>，每场一块带独立块头）本页未涉及、也未改动。</p>
    <p>信息密度与线上「紧凑表」完全一致：<code>12 列</code>、<code>24px 行高</code>、比赛级信息纵向合并、真实数据 ${picked.length} 場 ${heads} 頭。本轮：① 容器宽度按表格实际宽度撑开（${TABLE_W}px），<b>取消一切横向滚动</b>；② 北京时间 / 场次 / 比赛名 / 距离四个合并列<b>上下 + 左右双向居中</b>，并删掉 <code>JRA</code>、<code>GⅡ</code> 两行小标题；③ 级别徽章改用原项目 <code>levelBadge()</code> 的 <code>.yj-grade</code> JBIS 配色与半角文案，并<b>置于比赛名之后</b>（与主站 / 分卡版式同口径）。此前已落地：<code>セン → セ</code>、文本列宽动态测算（长马名不截断）、枠番单色块（色=枠番，数字=馬番）。</p>
  </div>
  ${compare}
  ${shell("v-a", "A · 编辑部极简（推荐）", "去掉全部竖线与斑马对比，只靠一条表头下横线 + 比赛分隔线组织；青绿只用于级别徽章和计数，枠色块是唯一彩色。", table("v-a"))}
  ${shell("v-b", "B · 报纸印刷", "米色纸 + 墨色双线报头，零斑马、零圆角、最紧行距；最接近 image#1 的紧凑气质，但列数与线上完全相同。", table("v-b"))}
  ${shell("v-c", "C · 冷灰网格 · 定稿", "保留极淡结构网格与青绿强调；枠番列采用方案 A 的单色块——颜色编码枠番（JRA 8 色）、块内只写馬番，一列一个数字，天然对齐。已合并 セ / 动态列宽 / 合并列居中放大三项修正。", table("v-c"))}
</div>
</body>
</html>`;

fs.writeFileSync(path.join(ROOT, "design/dense-cards-demo.html"), html);
console.log("OK -> design/dense-cards-demo.html", (html.length / 1024).toFixed(0) + "KB", "races:", picked.map((g) => `${g[0].venue}${g[0].raceNo}R/${g.length}頭`).join(", "));
