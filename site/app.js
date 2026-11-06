// 出走表展示（docs/DESIGN.md §7）— yunji-web 风格
// 数据：_site/derived/index.json + {date}.json（按日懒加载；{date}.json 为字典包，经 codec.mjs 解包）
// 约定（用户定稿 2026-10-22，均以北京时间为基准日）：
//   - 日期标签每次加载按「今天」现算：默认窗口 = 今天±2 共 5 天，‹ › 翻页，可选任意有数据日
//   - 场地 scope = JRA / NAR / 国家组码（GB、IRE、FR、USA…，来自 Racing Post 源）；分 中央/地方/海外 三段
//   - 场 chips 按 中央/地方/海外 分组，且只列当前场地选择下存在的场（选 FR 才出现 FR 场；全部才三组全列）；
//     级别 = 13 桶（index.levels，半角标签）
//   - 表列：当地比赛时间（日付+発走，附场馆）/ 北京时间（由 startTimeInstant 换算）/ 比赛名 / 距离 /
//           枠 / 番 / 馬名 / 性齢 / 斤量 / 騎手 / 調教師 / 父 / 父父 / 母 / 母父
import { unpackRows } from "./codec.mjs";
import { normalizeHorseName } from "./horse-name.mjs";

const $ = (s) => document.querySelector(s);
const JBIS = "https://www.jbis.or.jp";

let sireSel, sireSireSel, bmsSel, groupSel;   // 血统/分组选择器实例（main 中创建）

// embed 模式（DESIGN.md §10）：宿主站 iframe 深链 ?embed=1 —— 装饰层收起/锁亮色由
// index.html head 内联脚本挂 <html data-embed> + style.css 属性选择器完成，本文件只读标记；
// syncUrl 需要在筛选变化时保留 embed=1（模式标志不随状态重写丢失）。
const qpEmbed = /[?&]embed=1\b/.test(location.search);

const state = {
  index: null,
  cache: new Map(),
  dates: new Set(),
  winStart: "",        // 日期窗口起点（winStart + 4 = 窗口末日）
  scope: new Set(["JRA"]),   // 场地多选（默认仅 JRA；空 = 全部）
  venues: new Set(),   // 场馆名（中央/地方名单 + 海外）
  levels: new Set(),   // 13 桶级别
  sire: "",
  sireSire: "",
  bms: "",
  q: "",
  group: "",
  selectMode: false,          // （已废弃：勾选常驻，保留键位兼容旧 localStorage）
  selected: new Set(),        // 已勾选行键（行级勾选：同一场比赛的勾选行在分享卡里归入同一块）
  rows: [],
  alias: null,        // derived/horse-aliases.json：alias（归一化别名→canonical）/ display（canonical→展示名）
  aliasGroups: null,  // canonical → 归一化别名数组（血统下拉搜索用）
};

// 分组选项（血统下拉同款：v = 分组键，label = 展示名）；空 = 不分组
const GROUP_OPTIONS = [
  { v: "sire", label: "按 父" },
  { v: "sireSire", label: "按 父父" },
  { v: "bms", label: "按 母父" },
  { v: "jockey", label: "按 騎手" },
  { v: "trainer", label: "按 調教師" },
];

// ---------- 设备判定（yunji-web front/public/device.js 精简版）与分页状态 ----------
// 断点 768px：matchMedia 实时响应（与 CSS 同源），不支持时退回 innerWidth
const MB_MQL = window.matchMedia ? window.matchMedia("(max-width: 767px)") : null;
function isMb() {
  if (MB_MQL) return MB_MQL.matches;
  return (window.innerWidth || document.documentElement.clientWidth) < 768;
}

/* 分页：每页条数按设备固定（PC 100 / mb 20，不允许用户选择），页码按钮式（移植 yunji-web races.html） */
const PG = { page: 1, size: 0 };
const pgSizeDef = () => (isMb() ? 20 : 100);

// mb 日期轮播：5 天窗口内 mb 只显示 2 个 chip，winOff = 窗内偏移（0..3）；‹ › 步进、到边缘翻窗
let winOff = 0;

// 比赛唯一键（raceKey 缺失时兜底）
const rkOf = (r) => r.raceKey ?? `${r.date}|${r.track}|${r.raceNo}`;
// 行唯一键 = 比赛 + 馬番（未確定用馬名兜底）：勾选与分享卡都以行为单位
const rowKeyOf = (r) => `${rkOf(r)}|${r.num ?? "x"}|${r.horseId ?? r.horseName ?? ""}`;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 马匹链接：JBIS（10位数字 id）→ jbis.or.jp；RP 源（rp: 前缀）→ Sporting Life 档案
const horseLink = (id, name) => {
  if (!id) return esc(name ?? "");
  const href = id.startsWith("rp:")
    ? `https://www.sportinglife.com/racing/profiles/horse/${id.slice(3)}`
    : `${JBIS}/horse/${id}/`;
  return `<a href="${href}" target="_blank" rel="noopener">${esc(name)}</a>`;
};

// ---------- 时间（全部现算） ----------
const addDays = (date, n) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// 今天的北京日期（YYYY-MM-DD；不依赖浏览器时区设置）
const todayBJ = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
// 绝对时刻 → 北京「MM-dd HH:mm」
function bjTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(+d)) return "";
  const t = new Date(+d + 8 * 3600e3);
  const md = `${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
  const hm = `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
  return `${md} ${hm}`;
}
// date（YYYY-MM-DD）→ MM-dd（不带星期）
const dateLabelOf = (date) => `${date.slice(5, 7)}-${date.slice(8, 10)}`;

// ---------- 展示辅助（口径同 yunji race-rows.js；级别标签半角） ----------
const SURF_SHORT = { 芝: "草", ダ: "泥", 障: "障", AW: "AW" };   // 距离合并列：草1400 / 泥1400
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

// 枠番传统色（JRA 公式 1白2黒3赤4青5黄6緑7橙8桃，与 share.js WAKU 同源）
const frameBadge = (f) => (f == null || f === "" ? "" : `<span class="waku w${f}">${esc(f)}</span>`);
// 芝/ダ/障 色点（扫读用）
const surfDot = (s) => (s && SURF_SHORT[s] ? `<i class="surf-dot surf-${esc(s)}"></i>` : "");
const distText = (r) => (r.distance ? `${SURF_SHORT[r.surface] ?? r.surface ?? ""}${r.distance}` : "");
// 曜日（UTC 解析 date-only，与浏览器时区无关）
const WEEKDAY_JA = "日一二三四五六";
const weekdayOf = (date) => WEEKDAY_JA[new Date(date + "T00:00:00Z").getUTCDay()] ?? "";

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function ensure(date) {
  if (state.cache.has(date)) return state.cache.get(date);
  const d = await json(`derived/${date}.json`);
  const rows = d.v === 1 ? unpackRows(d) : d.rows;   // v1 = 字典包；旧版明文兜底
  state.cache.set(date, rows);
  return rows;
}

function allRows() {
  return [...state.dates].sort().flatMap((d) => state.cache.get(d) ?? []);
}

// 勾选数据源：所有已加载日期的行（不受当前筛选影响）——清空条件换场地勾选后，之前勾的行仍然在卡里
function rowsForPick() {
  return [...state.cache.keys()].sort().flatMap((d) => state.cache.get(d) ?? []);
}

// ---------- 筛选条 ----------
// tag：芯片内的细分标签（场地 row 用：JRA→中央 / NAR→地方），走 .wd 小字样式
function chip(label, value, on, key, count, tag) {
  const badge = count != null ? `<small>${count}</small>` : "";
  const off = count === 0 && !on ? " off" : "";   // 已选中的 0 头 chip 不置灰（默认 JRA 今日无赛仍可选）
  const sub = tag ? `<i class="wd">${esc(tag)}</i>` : "";
  return `<button data-k="${key}" data-v="${esc(value)}" class="filter-chip${on ? " on" : ""}${off}">${esc(label)}${sub}${badge}</button>`;
}

// 日期窗口：winStart 起 5 天；无数据日也展示并可点击（选中后表格为空态）
// mb：窗口内一次只显示 2 个 chip（winOff 偏移 0..3），‹ › 逐日步进、到边缘自动翻窗（PC 恒显 5 个）；
// 「本周末/今天」在独立容器 .f-quick，mb 换到第二行。
// align=false 时跳过「选中日保持可见」纠偏（‹ › 手动步进用——否则纠偏会把视口拉回选中日，步进卡死）
function renderDateTabs(align = true) {
  const byDate = new Map(state.index.dates.map((d) => [d.date, d]));
  const mb = isMb(), vis = mb ? 2 : 5, maxOff = 5 - vis;
  // 选中日（在窗内时）保持可见：偏移跟随
  const sel = [...state.dates].sort().find((d) => d >= state.winStart && d <= addDays(state.winStart, 4));
  if (mb && align && sel) {
    const idx = Math.round((Date.parse(sel) - Date.parse(state.winStart)) / 864e5);
    if (idx < winOff) winOff = Math.max(0, idx);
    else if (idx > winOff + vis - 1) winOff = Math.min(maxOff, idx - vis + 1);
  }
  winOff = Math.min(Math.max(winOff, 0), maxOff);
  const chips = [];
  for (let i = winOff; i < winOff + vis; i++) {
    const date = addDays(state.winStart, i);
    const info = byDate.get(date);
    chips.push(
      `<button data-d="${date}" class="filter-chip${state.dates.has(date) ? " on" : ""}">` +
      `${esc(dateLabelOf(date))}<i class="wd">${weekdayOf(date)}</i><small>${info?.runners ?? 0}頭</small></button>`,
    );
  }
  $("#date-tabs").innerHTML = chips.join("");
  // ‹ 在数据起点处禁用（更早日期从未采集）；mb 还需窗口已贴边且偏移归零
  const { first } = dataRange();
  $("#d-prev").disabled = !!first && state.winStart <= first && (!mb || winOff <= 0);
  $("#d-prev").title = $("#d-prev").disabled ? "已是最早数据日" : "更早日期";
  syncUrl();
}

// ---------- 筛选状态 ↔ URL（刷新不丢、可分享链接；replaceState 不污染历史） ----------
function syncUrl() {
  if (!state.index) return;
  const p = new URLSearchParams();
  if (state.dates.size) p.set("d", [...state.dates].sort().join(","));
  if (state.winStart) p.set("w", state.winStart);
  if (state.scope.size) p.set("scope", [...state.scope].join(","));
  if (state.venues.size) p.set("v", [...state.venues].join(","));
  if (state.levels.size) p.set("k", [...state.levels].join(","));
  if (state.sire) p.set("sire", state.sire);
  if (state.sireSire) p.set("ss", state.sireSire);
  if (state.bms) p.set("bms", state.bms);
  if (state.q.trim()) p.set("q", state.q.trim());
  if (state.group) p.set("group", state.group);
  if (qpEmbed) p.set("embed", "1");   // embed=1 是模式标志不是瞬态参数（DESIGN.md §10）：随 URL 保留，刷新/回壳不丢
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// 场地 chips：全部 / 中央(JRA) / 地方(NAR) / 海外国家组码（动态，多选、带头数）
// 分三段陈列（段间细竖线 + 「海外」组名）：中央·地方是日本国内，其余国家组码一律归海外
const SCOPE_TAG = { JRA: "中央", NAR: "地方" };
const isJpScope = (s) => s === "JRA" || s === "NAR";
function renderScopes() {
  const counts = new Map();
  for (const r of allRows()) counts.set(r.scope, (counts.get(r.scope) ?? 0) + 1);
  const codes = [...new Set(state.index.venues.map((v) => v.scope))];
  const jp = ["JRA", "NAR"].filter((s) => s === "JRA" || codes.includes(s));
  const ov = codes.filter((s) => !isJpScope(s)).sort((a, b) => a.localeCompare(b));
  const one = (sc) => chip(sc, sc, state.scope.has(sc), "scope", counts.get(sc) ?? 0, SCOPE_TAG[sc]);
  $("#scope-chips").innerHTML =
    chip("全部", "", state.scope.size === 0, "scope", null) +
    `<i class="f-sep"></i>` + jp.map(one).join("") +
    (ov.length ? `<i class="f-sep"></i><b class="f-glabel">海外</b>` + ov.map(one).join("") : "");
}

// 竞马场分组：中央 / 地方 / 海外[国家码]——只取当前「场地」选择下确实存在的场
//   场地 = JRA → 仅中央 10 场；= NAR → 仅地方；含海外国家（FR / FR+GB / 多国）→ 仅这些国家的场
//   （多国时一国一组，组名「海外 FR」）；场地 = 全部 → 三组全列
// 切场地时 state.venues 已在 handler 里清空，不会残留不可见的选中场
function venueGroups() {
  const sel = state.scope, all = sel.size === 0;
  const groups = [];
  if (all || sel.has("JRA")) groups.push({ label: SCOPE_TAG.JRA, names: state.index.tracks.central });
  if (all || sel.has("NAR")) groups.push({ label: SCOPE_TAG.NAR, names: state.index.tracks.local });
  const byScope = new Map();
  for (const v of state.index.venues) {
    if (isJpScope(v.scope)) continue;                 // 中央 / 地方走上面固定名单（index 里只有当日有赛的场）
    if (!all && !sel.has(v.scope)) continue;          // 未选中的国家不出场
    let arr = byScope.get(v.scope);
    if (!arr) byScope.set(v.scope, (arr = []));
    if (!arr.includes(v.venue)) arr.push(v.venue);
  }
  const codes = [...byScope.keys()].sort((a, b) => a.localeCompare(b));
  const sorted = (arr) => arr.slice().sort((a, b) => a.localeCompare(b));
  // 选了多个国家 → 一国一组（组名「海外 FR」）；只选一个 / 场地=全部 → 合并成「海外」一组
  if (codes.length > 1 && !all)
    for (const c of codes) groups.push({ label: `海外 ${c}`, names: sorted(byScope.get(c)) });
  else if (codes.length)
    groups.push({ label: "海外", names: sorted(codes.flatMap((c) => byScope.get(c))) });
  return groups;
}

function renderVenues() {
  const counts = new Map();
  for (const r of allRows()) counts.set(r.venue, (counts.get(r.venue) ?? 0) + 1);
  const groups = venueGroups();
  if (!groups.length) {   // 手改 URL 传了不存在的国家组码时兜底
    $("#venue-chips").innerHTML = `<span class="vg-empty">当前场地选择下没有可选竞马场</span>`;
    return;
  }
  $("#venue-chips").innerHTML = groups
    .map((g) => {
      const seen = new Set();
      const names = g.names.filter((n) => (seen.has(n) ? false : seen.add(n)));
      return `<span class="vg"><b class="vg-k">${esc(g.label)}</b>` +
        names.map((n) => chip(n, n, state.venues.has(n), "venue", counts.get(n) ?? 0)).join("") +
        `</span>`;
    })
    .join("");
}

// 级别 chip 的展示名（值仍用数据里的 level 键）：无级别 → 普通比赛
const LEVEL_LABEL = { "无级别": "普通比赛" };
function renderLevels() {
  const counts = new Map();
  for (const r of allRows()) counts.set(r.level, (counts.get(r.level) ?? 0) + 1);
  $("#klass-chips").innerHTML = state.index.levels
    .map((k) => chip(LEVEL_LABEL[k.level] ?? k.level, k.level, state.levels.has(k.level), "level", counts.get(k.level) ?? 0))
    .join("");
}

// ---------- 马名 canonical（别名归一；别名字典缺失时退化为按归一化名合并） ----------
// 同一匹马在两源的写法不同（JBIS「Saxon Warrior(JPN)」/ RP「Saxon Warrior」、
// JBIS「ディープインパクト」/ RP「Deep Impact」），下拉/过滤/分组一律按 canonical 键合并，
// 展示名用行内出现最多的原始写法（displayOf），原形保留在表格与 CSV 中不动。
const canonMemo = new Map();
function canonOf(raw) {
  if (!raw) return raw;
  let c = canonMemo.get(raw);
  if (c !== undefined) return c;
  const k = normalizeHorseName(raw);
  c = state.alias?.alias?.[k] ?? k;
  canonMemo.set(raw, c);
  return c;
}
const displayOf = (canon) => state.alias?.display?.[canon] ?? canon;

// ---------- 血统快捷标签（点击 → 对应下拉自动选中；本地存储，自由增删） ----------
// 未保存过时用默认值；保存过则完全以本地为准（清空也是合法状态）。「＋当前」把下拉当前选择存为标签。
const PED_TAGS_KEY = "rc.ped.tags.v1";
const PED_TAGS_DEFAULT = {
  sire: ["コントレイル", "キズナ", "シルバーステート", "リアルスティール"],
  sireSire: ["ディープインパクト"],
  bms: ["ディープインパクト"],
};
const PED_TAG_KEYS = ["sire", "sireSire", "bms"];
const PED_TAG_LABEL = { sire: "父", sireSire: "父父", bms: "母父" };
let pedTags = loadPedTags();

function loadPedTags() {
  try {
    const j = JSON.parse(localStorage.getItem(PED_TAGS_KEY));
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const out = {};
      for (const k of PED_TAG_KEYS) {
        out[k] = Array.isArray(j[k]) ? j[k].filter((x) => typeof x === "string" && x).slice(0, 12) : [];
      }
      return out;
    }
  } catch {}
  return JSON.parse(JSON.stringify(PED_TAGS_DEFAULT));   // structuredClone 兜底：省事直接 JSON 往返
}
const savePedTags = () => {
  try {
    localStorage.setItem(PED_TAGS_KEY, JSON.stringify(pedTags));
  } catch {}
};

function renderPedTags() {
  const wrap = $("#ped-tags");
  if (!wrap) return;
  const selOf = { sire: sireSel, sireSire: sireSireSel, bms: bmsSel };
  const group = (key) => {
    const tags = pedTags[key] ?? [];
    const cur = state[key];
    const chips = tags.map((t) => {
      const on = cur && canonOf(t) === cur;
      return (
        `<span class="filter-chip qt${on ? " on" : ""}" data-k="${key}" data-t="${esc(t)}" role="button" tabindex="0" title="点击选中 / 再点取消">` +
        `${esc(t)}<i class="qt-x" data-k="${key}" data-t="${esc(t)}" title="移除此标签">✕</i></span>`
      );
    });
    const add = cur
      ? `<button class="filter-chip qt-add" data-add="${key}" title="把下拉当前选择（${esc(displayOf(cur))}）存为快捷标签">＋当前</button>`
      : "";
    const hint = tags.length || cur ? "" : '<i class="qt-empty">下拉选中后点「＋当前」保存</i>';
    return `<span class="qt-group"><b class="qt-k">${PED_TAG_LABEL[key]}</b>${chips.join("")}${add}${hint}</span>`;
  };
  wrap.innerHTML =
    PED_TAG_KEYS.map(group).join("") +
    `<button class="qt-reset" id="qt-reset" title="恢复默认快捷标签（父：コントレイル / キズナ / シルバーステート / リアルスティール；父父·母父：ディープインパクト）">恢复默认</button>`;
}

function pickPedTag(key, tag) {
  const sel = { sire: sireSel, sireSire: sireSireSel, bms: bmsSel }[key];
  const c = canonOf(tag);
  if (state[key] === c) {
    state[key] = "";            // 再点一次已选中的 = 取消
    sel?.setValue("");
  } else {
    state[key] = c;             // 下拉按 canonical 选中（展示名用标签原文，行内匹配走别名）
    sel?.setValue(c, tag);
  }
  apply();
  renderPedTags();
}

// ---------- 血统选择器（移植自 yunji-web public/selector.js 的 items + compact 模式） ----------
// 搜索下拉：聚焦展开全列表 / 输入即过滤 / ↑↓+Enter 键盘导航 / 点击外部关闭 / ✕ 清空（空 = 全部）
const selRegistry = [];
document.addEventListener("click", (e) => {
  for (const s of selRegistry) if (!s.wrap.contains(e.target)) s.close();
});

function makeSelector({ mount, placeholder, onPick }) {
  mount.innerHTML =
    '<div class="yj-sel"><div class="box">' +
    '<input type="text" placeholder="' + esc(placeholder) + '" autocomplete="off">' +
    '<button class="clear" type="button" aria-label="清空" hidden>✕</button>' +
    '</div><div class="drop yj-drop yj-drop-scroll"></div></div>';
  const wrap = mount.firstElementChild;
  const input = wrap.querySelector("input");
  const clear = wrap.querySelector(".clear");
  const drop = wrap.querySelector(".drop");
  let items = [];        // [{v, label?, n?}]：v = 取值，label = 展示名（缺省同 v），n = 头数（缺省不展示）
  let list = [];
  let hl = -1;
  let selected = "";

  const close = () => drop.classList.remove("open");
  const labelOf = (it) => it.label ?? it.v;

  function render(q) {
    q = (q ?? "").trim().toLowerCase();
    const qn = normalizeHorseName(q);   // 别名按归一化比较（空白/标点/大小写不敏感，跨语言走别名）
    clear.hidden = !q && !selected;
    list = items.filter(
      (it) =>
        !q ||
        labelOf(it).toLowerCase().includes(q) ||
        it.v.toLowerCase().includes(q) ||
        (qn && it.al?.some((a) => a.includes(qn)))
    );
    if (!list.length) {
      drop.innerHTML = '<div class="empty-row">未找到匹配选项</div>';
      return;
    }
    drop.innerHTML =
      '<div class="dhead">' + (q ? "匹配" : "共") + ' <b>' + list.length + '</b> 项</div>' +
      list
        .map((it, i) =>
          '<div class="row" data-i="' + i + '"><span class="nblock">' + esc(labelOf(it)) + '</span>' +
          (it.n != null ? '<span class="mt">' + it.n + '頭</span>' : '') + '</div>')
        .join("");
    hl = -1;
  }

  function markHl() {
    [...drop.querySelectorAll(".row")].forEach((el, i) => el.classList.toggle("hl", i === hl));
  }
  function choose(i) {
    const it = list[i];
    if (!it) return;
    selected = it.v;
    input.value = labelOf(it);
    clear.hidden = !selected;
    close();
    onPick(it.v);
  }

  input.addEventListener("focus", () => {
    // 聚焦只展开列表，不再清空已选（误触焦点会丢筛选条件的坑）；清空走 ✕ 或重新选择
    render(input.value);
    drop.classList.add("open");
  });
  input.addEventListener("input", () => {
    // 输入 = 开始新搜索：暂不动已选（筛选仍生效），失焦未选择时回显已选值
    render(input.value);
    drop.classList.add("open");
  });
  input.addEventListener("blur", () => {
    if (!selected) return;
    const it = items.find((x) => x.v === selected);
    if (it && input.value !== labelOf(it)) input.value = labelOf(it);
  });
  clear.addEventListener("click", (e) => {
    e.stopPropagation();
    selected = ""; input.value = ""; onPick("");
    render(""); input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if (!drop.classList.contains("open") || !list.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); hl = (hl + 1) % list.length; markHl(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hl = (hl - 1 + list.length) % list.length; markHl(); }
    else if (e.key === "Enter") { e.preventDefault(); if (hl >= 0) choose(hl); }
    else if (e.key === "Escape") { drop.classList.remove("open"); input.blur(); }
  });
  drop.addEventListener("mousedown", (e) => {
    const it = e.target.closest(".row");
    if (it) { e.preventDefault(); choose(parseInt(it.dataset.i, 10)); }
  });
  selRegistry.push({ wrap, close });

  return {
    setItems(next) {
      items = next;
      if (drop.classList.contains("open")) render(input.value);
    },
    setValue(v, labelOverride) {
      selected = v || "";
      const it = items.find((x) => x.v === selected);
      input.value = it ? labelOf(it) : (labelOverride ?? v ?? "");
      clear.hidden = !selected && !input.value;
    },
    open() {
      render(input.value);
      drop.classList.add("open");
    },
  };
}

// key 行的选项列表（canonical 合并同名马，按头数降序，取前 400）
function optionsOf(rows, key) {
  const m = new Map(); // canon → { n, raws: Map(原始写法→行数) }
  for (const r of rows) {
    const raw = r[key];
    if (!raw) continue;
    const c = canonOf(raw);
    const e = m.get(c) ?? { n: 0, raws: new Map() };
    e.n++;
    e.raws.set(raw, (e.raws.get(raw) ?? 0) + 1);
    m.set(c, e);
  }
  return [...m.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0], "ja"))
    .slice(0, 400)
    .map(([c, e]) => ({
      v: c,
      label: displayOf(c),
      n: e.n,
      al: state.aliasGroups?.[c] ?? [normalizeHorseName(c)],   // 归一化别名（下拉搜索用）
    }));
}

// ---------- 过滤 ----------
// 北京时间升序（早的发走排上面）；北京时间 = UTC+8 固定偏移，按绝对时刻排序等价。
// 同时刻并列时按 场次R / 竞马场 兜底；无时刻行（理论上没有）按原序殿后。
const bjSortKey = (r) => {
  const t = r.startTimeInstant ? Date.parse(r.startTimeInstant) : NaN;
  return Number.isNaN(t) ? null : t;
};
function cmpBjTime(a, b) {
  const ta = bjSortKey(a), tb = bjSortKey(b);
  if (ta !== null && tb !== null)
    return ta - tb || (a.raceNo ?? 0) - (b.raceNo ?? 0) || String(a.venue ?? "").localeCompare(String(b.venue ?? ""), "ja");
  if (ta !== null) return -1;
  if (tb !== null) return 1;
  return 0;
}

function apply() {
  PG.page = 1;   // 筛选条件变化 → 归第 1 页
  const q = state.q.trim().toLowerCase();
  state.rows = allRows()
    .filter((r) => {
      if (state.scope.size && !state.scope.has(r.scope)) return false;
      if (state.venues.size && !state.venues.has(r.venue)) return false;
      if (state.levels.size && !state.levels.has(r.level)) return false;
      if (state.sire && canonOf(r.sire) !== state.sire) return false;
      if (state.sireSire && canonOf(r.sireSire) !== state.sireSire) return false;
      if (state.bms && canonOf(r.bms) !== state.bms) return false;
      if (q) {
        const hay = [r.horseName, r.jockey, r.breeder, r.trainer, r.owner, r.raceName].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort(cmpBjTime);   // 全局按北京时间从小到大（跨日期交叉排）
  render();
  syncUrl();
}

// ---------- 勾选行 → 分享卡 ----------
function updatePickBar() {
  const n = state.selected.size;
  $("#pick-n").textContent = n;
  $("#pick-bar").hidden = !n || document.body.classList.contains("share-open");
  if (!n) {
    $("#pick-list").hidden = true;
    $("#pick-toggle").classList.remove("open");
    return;
  }
  // 上拉预览：按北京时间升序列出勾选行（馬名 · 场R · 比赛名），逐条可取消（与分享卡块序一致）
  const items = [];
  const selRows = rowsForPick().filter((r) => state.selected.has(rowKeyOf(r))).sort(cmpBjTime);
  for (const r of selRows) {
    const k = rowKeyOf(r);
    items.push(`<div class="pl-item"><span class="pl-h">${esc(r.horseName ?? "")}</span>` +
      `<span class="pl-r">${esc(r.venue)}${r.raceNo}R · ${esc(r.raceName ?? "")}</span>` +
      `<button type="button" class="pl-x" data-k="${esc(k)}" title="取消勾选">✕</button></div>`);
  }
  $("#pick-list").innerHTML = items.join("");
}

// 已勾选行 → 分享卡 race 对象：同一场比赛的勾选行归入同一块，只带勾选的馬（数据源为全部已加载日期）
// 卡内比赛块按北京时间升序（跨日交叉排；同刻按 场次R/竞马场 兜底），画布按数组顺序换天/换场地画标题
function collectShareRaces() {
  const groups = new Map();
  for (const r of rowsForPick()) {
    if (!state.selected.has(rowKeyOf(r))) continue;
    const rk = rkOf(r);
    if (!groups.has(rk)) groups.set(rk, []);
    groups.get(rk).push(r);
  }
  const bjKey = (o) => {
    const t = o.startTimeInstant ? Date.parse(o.startTimeInstant) : NaN;
    return Number.isNaN(t) ? Infinity : t;   // 无时刻（手动添加漏填）殿后
  };
  return [...groups.values()]
    .map((rows) => {
      const h = rows[0];
      return {
        raceKey: rkOf(h), date: h.date, dateLabel: h.dateLabel, weekday: h.weekday,
        scope: h.scope, country: h.country, venue: h.venue, raceNo: h.raceNo,
        raceName: h.raceName, level: h.level, surface: h.surface, distance: h.distance,
        heads: h.heads ?? rows.length, startTime: h.startTime, startTimeTz: h.startTimeTz,
        startTimeInstant: h.startTimeInstant,
        runners: rows.map((r) => ({
          frame: r.frame, num: r.num, horseName: r.horseName, sex: r.sex, age: r.age,
          color: r.color, silk: r.silk, jockey: r.jockey, weight: r.weight, trainer: r.trainer, belongs: r.belongs,
          owner: r.owner, breeder: r.breeder, sire: r.sire, sireSire: r.sireSire, dam: r.dam, bms: r.bms,
        })),
      };
    })
    .sort((a, b) => bjKey(a) - bjKey(b) || (a.raceNo ?? 0) - (b.raceNo ?? 0) || String(a.venue ?? "").localeCompare(String(b.venue ?? ""), "ja"));
}

// 进入分享卡：默认页内切换（share.js show() 走 body.share-open，勾选与 URL 筛选都留在本页）；
// 需要「新标签打开」时由分享工具条按钮走 sessionStorage 深链（?share=open）
function goShare() {
  const races = collectShareRaces();
  if (!races.length) return;
  $("#pick-list").hidden = true;
  $("#pick-toggle").classList.remove("open");
  import("./share.js").then((m) => m.show(races)).catch((e) => console.error(e));
}

// ?pick=demo / ?share=demo：视觉自检（按级别优先各取一场并展开为行级勾选，并按需打开分享卡）
function demoPick(open) {
  const picked = [];
  for (const lvl of ["G1", "地方重赏", "G2", "G3", "L", "OP"]) {
    if (picked.length >= 3) break;
    for (const r of allRows()) {
      if (r.level !== lvl) continue;
      const rk = rkOf(r);
      if (!picked.includes(rk)) { picked.push(rk); break; }
    }
  }
  const pickSet = new Set(picked);
  for (const r of allRows()) if (pickSet.has(rkOf(r))) state.selected.add(rowKeyOf(r));
  apply();
  updatePickBar();
  if (open) return import("./share.js").then((m) => m.show(collectShareRaces())).catch((e) => console.error(e));   // 自检：页内直开
  return Promise.resolve();
}

// ?share=demo&edit=1|2：批量编辑表格端到端自检（截图核对用）
// edit=1 → 就地改騎手 + 追加行输馬名 + 勾选删一行；edit=2 → 再撤销 3 步复原
async function gridSelfTest(full) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);
  const $g = (s) => document.querySelector(s);
  // ① 就地编辑：第 1 场第 2 行 騎手（view: 0=比赛头行，1/2=出走馬行）
  const td = $g('#sg-tbody td[data-c="jockey"][data-vi="2"]');
  td?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(120);
  const inp = td?.querySelector(".sg-inp");
  if (inp) { inp.value = "自己試験騎手"; inp.blur(); }
  await sleep(180);
  // ② 追加行（自动聚焦新行 馬名）→ 输入 → Enter
  $g("#sg-addBtn")?.click();
  await sleep(180);
  const inp2 = $g("#sg-tbody .sg-inp");
  if (inp2) {
    inp2.value = "テスト出走馬";
    inp2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }
  await sleep(180);
  // ③ 勾选一行 → 删除所选
  const ck = $g('#sg-tbody input.sg-sel[data-vi="1"]');
  if (ck) { ck.checked = true; ck.dispatchEvent(new Event("change", { bubbles: true })); }
  $g("#sg-delBtn")?.click();
  await sleep(250);
  // ④ 撤销 3 步：删行 → 追加行 → 改騎手，全部复原
  if (full) {
    for (let i = 0; i < 3; i++) { $g("#sg-undoBtn")?.click(); await sleep(150); }
  }
}

// ---------- 渲染 ----------
// ---------- 列定义与显隐（localStorage rc.cols.v4） ----------
// 默认展示：競馬場 R 比赛名 距离 北京时间 馬名 枠番 馬番 性齢 斤量 騎手 父 母父；
// 発走 / 調教師 / 父父 / 母 默认隐藏（発走在比赛分隔行里，其余经「自定义显示列」开回）。
const COLUMNS = [
  { k: "venue",    label: "競馬場", left: 1 },
  { k: "raceno",   label: "R" },
  { k: "race",     label: "比赛名", left: 1 },
  { k: "dist",     label: "距离" },
  { k: "start",    label: "発走", defHide: 1 },
  { k: "bj",       label: "北京时间" },
  { k: "name",     label: "馬名", left: 1 },
  { k: "waku",     label: "枠番" },
  { k: "num",      label: "馬番" },
  { k: "sexage",   label: "性齢" },
  { k: "silk",     label: "彩衣" },   // 勝負服小图（默认展示；采集覆盖时才有值，无值则空）
  { k: "weight",   label: "斤量" },
  { k: "jockey",   label: "騎手", left: 1 },
  { k: "trainer",  label: "調教師", left: 1, defHide: 1 },
  { k: "sire",     label: "父", left: 1 },
  { k: "siresire", label: "父父", left: 1, f: "sireSire", defHide: 1 },   // 数据字段为驼峰 sireSire，f 指明取值键
  { k: "dam",      label: "母", left: 1, defHide: 1 },
  { k: "bms",      label: "母父", left: 1 },
];
// 骟马 JBIS 原文为「セン」，展示统一收成单字「セ」：性齢列不再超宽截断
const sexShort = (s) => (s === "セン" ? "セ" : (s ?? ""));
const COLS_KEY = "rc.cols.v4";
const COLS_DEFAULT_HIDE = ["start", "trainer", "siresire", "dam"];
let hiddenCols = loadHiddenCols();
function loadHiddenCols() {
  try {
    const a = JSON.parse(localStorage.getItem(COLS_KEY));
    if (Array.isArray(a)) {
      return new Set(a.filter((k) => COLUMNS.some((c) => c.k === k)));
    }
  } catch {}
  return new Set(COLS_DEFAULT_HIDE);   // 未保存过 = 新默认：比赛级信息由分隔行承载，彩衣默认展示
}
const saveHiddenCols = () => { try { localStorage.setItem(COLS_KEY, JSON.stringify([...hiddenCols])); } catch {} };
const visCols = () => COLUMNS.filter((c) => !hiddenCols.has(c.k));

// 单元格渲染（每列一个分支；esc 统一在 case 内做）
function cellHtml(r, c) {
  switch (c.k) {
    case "venue":
      return esc(r.venue ?? "");
    case "raceno":
      return esc(r.raceNo ?? "");
    case "start":
      return `<span class="st">${esc(r.dateLabel ?? "")} ${esc(r.startTime ?? "")}</span>`;
    case "bj":
      return esc(bjTime(r.startTimeInstant));
    case "race": {
      const name = r.raceUrl
        ? `<a class="rlink" href="${esc(r.raceUrl)}" target="_blank" rel="noopener" title="${esc(r.raceName ?? "")}">${esc(r.raceName ?? "")}</a>`
        : `<span title="${esc(r.raceName ?? "")}">${esc(r.raceName ?? "")}</span>`;
      return `<span class="rname">${name}</span>${levelBadge(r.level)}`;
    }
    case "dist": return `${surfDot(r.surface)}${esc(distText(r))}`;
    case "waku": return frameBadge(r.frame);
    case "num":  return esc(r.num ?? "");
    case "name": return horseLink(r.horseId, r.horseName);
    case "sexage": return esc(sexShort(r.sex) + (r.age ?? ""));
    case "silk": {
      // 勝負服 73x55 小图（马主登记图，采集落盘）；懒加载，加载失败整图移除
      if (!r.silk) return "";
      return `<img class="silk-img" src="${esc(r.silk)}" alt="彩衣" loading="lazy" decoding="async" onerror="this.remove()">`;
    }
    case "weight": return esc(r.weight ?? "");
    default: return esc(r[c.f ?? c.k] ?? "");   // f = 列键与数据字段名不同时的取值键
  }
}

function rowHtml(r) {
  const k = esc(rowKeyOf(r));
  const box = `<input type="checkbox" class="pick-box" data-k="${k}"${state.selected.has(rowKeyOf(r)) ? " checked" : ""} aria-label="勾选 ${esc(r.horseName ?? "")}">`;
  const tds = visCols().map((c, i) => {
    // 勾选框锚定第一可见列（绝对定位在左侧预留区，任何列组合下都可用）
    const host = i === 0 ? " pk-host" : "";
    const cls = `${c.left ? "c-left" : "num"}${c.k === "bj" ? " bj" : ""}${host}`;
    return `<td class="${cls}" data-l="${esc(c.label)}">${i === 0 ? box : ""}${cellHtml(r, c)}</td>`;
  }).join("");
  return `<tr data-pk="${k}" title="${esc(r.startTimeInstant ?? "")}">${tds}</tr>`;
}

// 比赛分隔行（PC：同场比赛的首行前插入 场R · 比赛名 · 级别 · 北京时间 · 距离 · 当地发走 · 头数）
function raceSepHtml(r, heads) {
  const nm = r.raceUrl
    ? `<a class="rlink" href="${esc(r.raceUrl)}" target="_blank" rel="noopener">${esc(r.raceName ?? "")}</a>`
    : esc(r.raceName ?? "");
  const bj = bjTime(r.startTimeInstant);
  const meta = [distText(r), r.startTime ? `当地 ${esc(r.startTime)}` : "", heads != null ? `${esc(heads)}頭` : ""]
    .filter(Boolean).join(" · ");
  return `<tr class="sep"><td colspan="${visCols().length}"><b>${esc(r.venue)}${r.raceNo}R</b>${nm}${levelBadge(r.level)}` +
    `${bj ? `<span class="sep-bj">${esc(bj)} 北京</span>` : ""}` +
    `${meta ? `<span class="sep-meta">${meta}</span>` : ""}</td></tr>`;
}

// ---------- 移动端（≤767px）卡片渲染（yunji race-rows mbCard 同方案：JS 独立路径，同一份列定义） ----------
// 组头：比赛级信息一行带过（場R · 比赛名 · 级别 · 北京 · 距离 · 当地 · 头数）
function mbSepHtml(r, heads) {
  const nm = r.raceUrl
    ? `<a class="rlink" href="${esc(r.raceUrl)}" target="_blank" rel="noopener">${esc(r.raceName ?? "")}</a>`
    : esc(r.raceName ?? "");
  const bj = bjTime(r.startTimeInstant);
  const meta = [distText(r), r.startTime ? `当地 ${esc(r.startTime)}` : "", heads != null ? `${esc(heads)}頭` : ""]
    .filter(Boolean).join(" · ");
  return `<div class="yj-mb-sep"><b>${esc(r.venue)}${r.raceNo}R</b>${nm}${levelBadge(r.level)}` +
    `${bj ? `<span class="sep-bj">${esc(bj)} 北京</span>` : ""}` +
    `${meta ? `<span class="sep-meta">${meta}</span>` : ""}</div>`;
}

// 马卡片：top 行（馬番 · 枠色片 · 馬名 · 性齢）+ 分组行（label：value 项，空值/隐藏列不出现）
function mbCardHtml(r) {
  const rk = esc(rowKeyOf(r));
  const checked = state.selected.has(rowKeyOf(r));
  const show = (k) => visCols().some((c) => c.k === k);   // 跟随列显隐（PC hide 的列 mb 卡不出现）
  const item = (lb, v) => (v == null || v === "" ? "" : `<span class="yj-mb-item"><i>${esc(lb)}：</i><b>${v}</b></span>`);
  const top = [
    show("silk") && r.silk ? `<img class="silk-img" src="${esc(r.silk)}" alt="彩衣" loading="lazy" decoding="async" onerror="this.remove()">` : "",
    show("num") && r.num != null ? `<span class="yj-mb-no">${esc(r.num)}</span>` : "",   // 未確定（num 空）不画占位符
    show("waku") ? frameBadge(r.frame) : "",
    `<span class="yj-mb-horse">${horseLink(r.horseId, r.horseName)}</span>`,
    show("jockey") && r.jockey ? `<span class="yj-mb-jk">${esc(r.jockey)}</span>` : "",   // 騎手/斤量与馬名同排（用户定稿）
    show("weight") && r.weight != null ? `<span class="yj-mb-w">${esc(r.weight)}</span>` : "",
    show("sexage") ? `<span class="yj-mb-sexage">${esc(sexShort(r.sex) + (r.age ?? ""))}</span>` : "",
  ].join("");
  const linePed = [
    show("trainer") ? item("調教師", esc(r.trainer ?? "")) : "",
    show("sire") ? item("父", esc(r.sire ?? "")) : "",
    show("siresire") ? item("父父", esc(r.sireSire ?? "")) : "",
    show("dam") ? item("母", esc(r.dam ?? "")) : "",
    show("bms") ? item("母父", esc(r.bms ?? "")) : "",
  ].join("");
  return `<div class="yj-mb${checked ? " picked" : ""}" data-pk="${rk}">` +
    `<input type="checkbox" class="pick-box" data-k="${rk}"${checked ? " checked" : ""} aria-label="勾选 ${esc(r.horseName ?? "")}">` +
    `<div class="yj-mb-top">${top}</div>` +
    (linePed ? `<div class="yj-mb-line">${linePed}</div>` : "") +
    `</div>`;
}

// 渲染结果落位：mb → #mb-list 卡片列表（table 隐藏）；PC → tbody
function flushRows(parts) {
  const mb = isMb();
  $("#entry-table").hidden = mb;
  $("#mb-list").hidden = !mb;
  (mb ? $("#mb-list") : $("#entry-table tbody")).innerHTML = parts.join("");
}

// 表头按可见列重画（列显隐切换时调用）
function renderThead() {
  $("#entry-table thead tr").innerHTML = visCols()
    .map((c) => `<th class="${c.left ? "c-left" : ""}">${esc(c.label)}</th>`)
    .join("");
}

// ---------- 分页条（页码按钮式，移植 yunji-web races.html pageSeq / pagerHTML） ----------
// 页码序列：首尾页 + 当前页 ±2 窗口，间断处用 null 表示省略号
function pageSeq(cur, total) {
  const set = new Set([1, total]);
  for (let i = cur - 2; i <= cur + 2; i++) if (i >= 1 && i <= total) set.add(i);
  const pages = [...set].sort((a, b) => a - b);
  const out = [];
  for (let j = 0; j < pages.length; j++) {
    if (j > 0 && pages[j] - pages[j - 1] > 1) out.push(null);
    out.push(pages[j]);
  }
  return out;
}

function pagerHTML(page, pages, total) {
  const btns = pageSeq(page, pages).map((p) =>
    p === null ? '<span class="pg-ell">…</span>'
      : `<button type="button" class="pg-btn${p === page ? " on" : ""}" data-page="${p}">${p}</button>`
  ).join("");
  return `<div class="pager">` +
    `<button type="button" class="pg-nav" data-page="${page - 1}"${page <= 1 ? " disabled" : ""}>‹ 上一页</button>` +
    btns +
    `<button type="button" class="pg-nav" data-page="${page + 1}"${page >= pages ? " disabled" : ""}>下一页 ›</button>` +
    `<span class="pg-info">第 ${page} / ${pages} 页 · 共 ${total} 頭</span>` +
    `</div>`;
}

// 分页条挂载：pages<=1 时清空挂载点（不渲染）
function renderPager(pages, total) {
  $("#pager-mount").innerHTML = pages > 1 ? pagerHTML(PG.page, pages, total) : "";
}

// 空态说明：默认只选 JRA 时，工作日通常没有中央比赛，给一键行动按钮
function emptyHtml() {
  const jraOnly = state.scope.size === 1 && state.scope.has("JRA");
  const text = jraOnly
    ? "当前条件下没有出走马（中央比赛多在周六、周日；出馬表约开赛前 2 日公开）"
    : "当前条件下没有出走马（中央出馬表约开赛前 2 日公开，地方约前日，海外为英国当日）";
  const acts = [];
  if (state.scope.size) acts.push(`<button class="e-act" data-act="all-scope" type="button">切换到全部场地</button>`);
  acts.push(`<button class="e-act" data-act="near" type="button">跳到最近有赛日</button>`);
  return `${esc(text)}<span class="e-acts">${acts.join("")}</span>`;
}

// 渲染当前视图：前端内存分页，每页最多 PG.size 条数据行；≤100 行直接 innerHTML，无需分块
let pageRows = [];   // 当前页实际展示的行（不分组 = 切片；分组 = 各组页内区间展开），「全选本页」依据
function render() {
  $("#skel")?.remove();   // 首帧骨架屏：首次真实渲染后移除
  PG.size ||= pgSizeDef();   // 首次惰性初始化（PC 100 / mb 20）
  const rows = state.rows;
  const races = new Set(rows.map((r) => r.raceKey ?? r.date + r.track + r.raceNo)).size;
  const colspan = visCols().length;

  $("#empty").hidden = rows.length > 0;
  $("#empty").innerHTML = rows.length ? "" : emptyHtml();

  let pages = 1, shown = 0;
  pageRows = [];

  if (!state.group) {
    // 不分组：数据行等宽切片；同场比赛首行前插入分隔行（场R · 比赛名 · 级别）
    pages = Math.max(1, Math.ceil(rows.length / PG.size));
    PG.page = Math.min(Math.max(PG.page, 1), pages);   // 页码越界修正
    const start = (PG.page - 1) * PG.size;
    shown = Math.min(rows.length - start, PG.size);   // 本页数据行数（末页为余数）
    pageRows = rows.slice(start, start + PG.size);
    const parts = [];
    let lastRk = null;
    for (const r of pageRows) {
      const rk = rkOf(r);
      if (rk !== lastRk) { parts.push(isMb() ? mbSepHtml(r, r.heads) : raceSepHtml(r, r.heads)); lastRk = rk; }
      parts.push(isMb() ? mbCardHtml(r) : rowHtml(r));
    }
    flushRows(parts);
  } else {
    // 分组视图：整组分页——页内按整组装填，装不下整组就整组移到下一页（最后一组不截断）；
    // 单组超过一页容量时才组内截断，跨页组在新页自动重复组头；组头 tr.sub 不占条数
    // 血统三键按 canonical 合组（同一匹马两种写法进同一组），组头显示展示名
    const key = state.group;
    const pedKey = key === "sire" || key === "sireSire" || key === "bms";
    const groups = new Map();
    for (const r of rows) {
      const k = pedKey && r[key] ? canonOf(r[key]) : r[key] || "—";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const label = { sire: "父", sireSire: "父父", bms: "母父", jockey: "騎手", trainer: "調教師" }[key] ?? key;
    const segs = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "ja"))
      .map(([k, list]) => ({ k, list }));
    const packed = [];   // 每页 = [{k, list, a, b}]，a..b 为该组在本页包含的行区间
    let cur = [], curN = 0;
    for (const seg of segs) {
      const L = seg.list.length;
      if (L > PG.size) {   // 单组超页 → 独占若干页（组内截断不可避免）
        if (cur.length) { packed.push(cur); cur = []; curN = 0; }
        for (let i = 0; i < L; i += PG.size) packed.push([{ k: seg.k, list: seg.list, a: i, b: Math.min(L, i + PG.size) }]);
        continue;
      }
      if (curN + L > PG.size) { packed.push(cur); cur = []; curN = 0; }
      cur.push({ k: seg.k, list: seg.list, a: 0, b: L });
      curN += L;
    }
    if (cur.length) packed.push(cur);

    pages = Math.max(1, packed.length);
    PG.page = Math.min(Math.max(PG.page, 1), pages);
    const parts = [];
    for (const seg of packed[PG.page - 1] ?? []) {
      const gr = new Set(seg.list.map((r) => r.raceKey ?? r.date + r.track + r.raceNo)).size;
      parts.push(isMb()
        ? `<div class="yj-mb-sub"><b>${label}：${esc(pedKey ? displayOf(seg.k) : seg.k)}</b>${seg.list.length} 頭 / ${gr} R</div>`
        : `<tr class="sub"><td colspan="${colspan}"><b>${label}：${esc(pedKey ? displayOf(seg.k) : seg.k)}</b>${seg.list.length} 頭 / ${gr} R</td></tr>`);
      const segRows = seg.list.slice(seg.a, seg.b);
      let lastRk = null;   // 组内同样按比赛加分隔行（比赛级列默认隐藏后，这里是场R信息的唯一来源）
      for (const r of segRows) {
        const rk = rkOf(r);
        if (rk !== lastRk) { parts.push(isMb() ? mbSepHtml(r, r.heads) : raceSepHtml(r, r.heads)); lastRk = rk; }
        parts.push(isMb() ? mbCardHtml(r) : rowHtml(r));
      }
      pageRows.push(...segRows);
      shown += seg.b - seg.a;
    }
    flushRows(parts);
  }

  $("#count").innerHTML = `共 <b>${rows.length}</b> 頭 · <b>${races}</b> R` +
    (pages > 1 ? ` <span class="muted">当前第 ${PG.page} / ${pages} 页 · 显示 ${shown} 条</span>` : "");
  renderPager(pages, rows.length);
  $("#sel-page").hidden = $("#desel-page").hidden = !pageRows.length;   // 全选/取消本页：有行时显示
}

// 数据实际覆盖范围（采集窗口从 JST 当天起，更早日期从未采集）
const dataRange = () => {
  const ds = state.index.dates.map((d) => d.date);
  return { first: ds[0] ?? null, last: ds.at(-1) ?? null };
};

// 日期默认：只选「今天」；窗口起点钳到最早数据日（之前日期不展示）；今天无数据则取最近有数据日
function defaultDates() {
  const today = todayBJ();
  const { first } = dataRange();
  const dataDates = state.index.dates.map((d) => d.date);
  state.winStart = addDays(today, -2);
  if (first && state.winStart < first) state.winStart = first;   // 10-20/10-21 这类空日不再占位
  if (dataDates.includes(today)) {
    state.dates = new Set([today]);
    return;
  }
  const nearest = dataDates.reduce((a, b) =>
    Math.abs(new Date(b + "T00:00:00Z") - new Date(today + "T00:00:00Z")) <
    Math.abs(new Date(a + "T00:00:00Z") - new Date(today + "T00:00:00Z")) ? b : a,
  );
  state.winStart = addDays(nearest, -2);
  if (first && state.winStart < first) state.winStart = first;
  state.dates = new Set([nearest]);
}

// 场地默认：优先 JRA；当前所选日期没有中央出走（如工作日）时退回 NAR；两者皆空则保持 JRA
function defaultScope() {
  const runnersIn = (scope) => state.index.dates
    .filter((d) => state.dates.has(d.date))
    .flatMap((d) => d.tracks ?? [])
    .filter((t) => t.scope === scope)
    .reduce((n, t) => n + (t.runners ?? 0), 0);
  const jra = runnersIn("JRA");
  const nar = runnersIn("NAR");
  state.scope = new Set([jra > 0 ? "JRA" : nar > 0 ? "NAR" : "JRA"]);
}

// ---------- 初始化 ----------
// 只加载 index 里有数据的天；选中的无数据日（历史/未来空日）直接视为 0 行，不请求 404
async function loadDates() {
  const have = new Set(state.index.dates.map((d) => d.date));
  for (const d of state.dates) {
    if (have.has(d) && !state.cache.has(d)) await ensure(d);
  }
}

async function refresh() {
  await loadDates();
  const rows = allRows();
  sireSel.setItems(optionsOf(rows, "sire"));
  sireSireSel.setItems(optionsOf(rows, "sireSire"));
  bmsSel.setItems(optionsOf(rows, "bms"));
  // 下拉回显当前筛选（URL 恢复 / 快捷标签变更后保持一致；canonical 不在选项内时兜底展示名）
  sireSel.setValue(state.sire, state.sire ? displayOf(state.sire) : "");
  sireSireSel.setValue(state.sireSire, state.sireSire ? displayOf(state.sireSire) : "");
  bmsSel.setValue(state.bms, state.bms ? displayOf(state.bms) : "");
  renderScopes();
  renderVenues();
  renderLevels();
  renderDateTabs();
  apply();
}

function resetFilters() {
  state.venues.clear();
  state.levels.clear();
  state.sire = state.sireSire = state.bms = "";
  state.q = "";
  state.group = "";
  $("#f-q").value = "";
  sireSel?.setValue("");
  sireSireSel?.setValue("");
  bmsSel?.setValue("");
  groupSel?.setValue("");
  renderPedTags();
  defaultDates();
  defaultScope();
  refresh();
}

async function main() {
  state.index = await json("derived/index.json");
  // 马名别名字典（canonical 合并同名马；缺失时退化为按归一化名合并）
  try {
    state.alias = await json("derived/horse-aliases.json");
    const groups = {};
    for (const [a, c] of Object.entries(state.alias.alias ?? {})) (groups[c] ??= []).push(a);
    state.aliasGroups = groups;
  } catch {
    state.alias = null;
  }
  if (!state.index.dates.length) {
    $("#skel")?.remove();
    $("#count").textContent = "尚无出走表数据";
    $("#empty").hidden = false;
    $("#empty").textContent = "尚无数据：运行 npm run collect 后重新构建站点";
    return;
  }
  // URL 筛选状态恢复（syncUrl 写入的 d/w/scope/v/k/sire/ss/bms/q/group）
  const qp = new URLSearchParams(location.search);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const urlDates = (qp.get("d") ?? "").split(",").filter((d) => DATE_RE.test(d));
  const urlWin = qp.get("w");
  if (urlDates.length) {
    state.dates = new Set(urlDates);
    if (urlWin && DATE_RE.test(urlWin)) state.winStart = urlWin;
    else state.winStart = addDays([...state.dates].sort()[0], -1);
  }
  if (qp.get("scope")) state.scope = new Set(qp.get("scope").split(",").filter(Boolean));
  if (qp.get("v")) state.venues = new Set(qp.get("v").split(",").filter(Boolean));
  if (qp.get("k")) state.levels = new Set(qp.get("k").split(",").filter(Boolean));
  // 血统深链 canonical 化：state.sire* 存 canonical（行内比较 canonOf(r.sire) !== state.sire），
  // syncUrl 写出的已是 canonical；但外部宿主深链（racing-calendar ?embed=1&sire=コントレイル，
  // DESIGN.md §10）传的是展示名 → 必须过 canonOf（归一 + 别名表）才能与行内 canonical 匹配。
  if (qp.get("sire")) state.sire = canonOf(qp.get("sire")) || "";
  if (qp.get("ss")) state.sireSire = canonOf(qp.get("ss")) || "";
  if (qp.get("bms")) state.bms = canonOf(qp.get("bms")) || "";
  if (qp.get("q")) { state.q = qp.get("q"); $("#f-q").value = state.q; }
  const g = qp.get("group");
  if (["sire", "sireSire", "bms", "jockey", "trainer"].includes(g)) state.group = g;

  // 日期/场地默认值只在 URL 未指定时套用（?d=/?scope= 深链恢复优先）——
  // 此前无条件执行，syncUrl 写进 URL 的 d/w/scope 在刷新/分享打开时会被默认值覆盖回「今天+JRA」。
  if (!urlDates.length) defaultDates();
  if (!qp.get("scope")) defaultScope();

  // 血统选择器（参考 yunji selector.js：搜索下拉 + 键盘导航 + 点击外部关闭）
  sireSel = makeSelector({ mount: $("#m-sire"), placeholder: "父", onPick: (v) => { state.sire = v || ""; apply(); renderPedTags(); } });
  sireSireSel = makeSelector({ mount: $("#m-siresire"), placeholder: "父父", onPick: (v) => { state.sireSire = v || ""; apply(); renderPedTags(); } });
  bmsSel = makeSelector({ mount: $("#m-bms"), placeholder: "母父", onPick: (v) => { state.bms = v || ""; apply(); renderPedTags(); } });
  // 分组选择器：与血统下拉同款；空 = 不分组
  groupSel = makeSelector({ mount: $("#m-group"), placeholder: "不分组", onPick: (v) => { state.group = v || ""; render(); } });
  groupSel.setItems(GROUP_OPTIONS);

  // 血统快捷标签行：点标签 → 对应下拉选中；✕ 移除；＋当前 存标签；恢复默认
  $("#ped-tags").addEventListener("click", (e) => {
    const x = e.target.closest("i.qt-x");
    if (x) {
      const { k, t } = x.dataset;
      pedTags[k] = (pedTags[k] ?? []).filter((s) => canonOf(s) !== canonOf(t));
      savePedTags();
      renderPedTags();
      return;
    }
    if (e.target.closest("#qt-reset")) {
      pedTags = JSON.parse(JSON.stringify(PED_TAGS_DEFAULT));
      savePedTags();
      renderPedTags();
      return;
    }
    const add = e.target.closest("[data-add]");
    if (add) {
      const key = add.dataset.add;
      const c = state[key];
      if (!c) return;
      const tags = pedTags[key] ?? (pedTags[key] = []);
      if (!tags.some((s) => canonOf(s) === c)) {
        tags.push(displayOf(c));
        if (tags.length > 12) tags.shift();   // 每项上限 12 个，超出丢最旧
        savePedTags();
      }
      renderPedTags();
      return;
    }
    const tag = e.target.closest(".qt[data-t]");
    if (tag) pickPedTag(tag.dataset.k, tag.dataset.t);
  });
  renderPedTags();
  renderThead();

  // 事件
  $("#reset").onclick = resetFilters;
  // 日期 ‹ ›：PC 平移 5 天窗口；mb 在窗口内逐日步进（winOff），到边缘自动翻窗——连续按的体感是逐日移动
  const dateStep = (dir) => {
    const mb = isMb(), vis = mb ? 2 : 5, maxOff = 5 - vis;
    if (mb) {
      const off = winOff + dir;
      if (off >= 0 && off <= maxOff) { winOff = off; }
      else {
        const { first } = dataRange();
        let next = addDays(state.winStart, dir * 5);
        if (first && next < first) next = first;
        state.winStart = next;
        winOff = dir < 0 ? maxOff : 0;
      }
    } else {
      const { first } = dataRange();
      const next = addDays(state.winStart, dir * 5);
      state.winStart = first && next < first ? first : next;
    }
    renderDateTabs(false);   // 手动步进：不拉回选中日
  };
  $("#d-prev").onclick = () => dateStep(-1);
  $("#d-next").onclick = () => dateStep(1);
  $("#d-today").onclick = () => {
    // 回到今天：窗口与选中日一并重置（此前只平移窗口不动选中日，点了今天数据还停在原日期）
    defaultDates();
    refresh();
  };
  // 本周末：一次选中本周六日（北京时间的今天所在周；周日当天 = 昨天+今天）
  $("#d-weekend").onclick = () => {
    const today = todayBJ();
    const dow = new Date(today + "T00:00:00Z").getUTCDay();
    const sat = addDays(today, dow === 0 ? -1 : 6 - dow);
    state.dates = new Set([sat, addDays(sat, 1)]);
    state.winStart = addDays(sat, -1);   // 5 天窗口：周六日都在窗内
    refresh();
  };
  $("#scope-chips").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const v = b.dataset.v;
    if (v === "") state.scope.clear();
    else if (state.scope.has(v)) state.scope.delete(v);
    else state.scope.add(v);
    state.venues.clear();
    refresh();
  };
  $("#venue-chips").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || b.classList.contains("off")) return;
    const v = b.dataset.v;
    state.venues.has(v) ? state.venues.delete(v) : state.venues.add(v);
    b.classList.toggle("on");
    apply();
  };
  $("#klass-chips").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || b.classList.contains("off")) return;
    const v = b.dataset.v;
    state.levels.has(v) ? state.levels.delete(v) : state.levels.add(v);
    b.classList.toggle("on");
    apply();
  };
  $("#date-tabs").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset.d;
    if (state.dates.has(d) && state.dates.size > 1) state.dates.delete(d);
    else state.dates.add(d);
    b.classList.toggle("on");
    refresh();
  };
  $("#f-q").oninput = (e) => { state.q = e.target.value; apply(); };

  // 勾选常驻：整行点击 = 勾/取消（馬名・比赛名链接照常打开；checkbox 自身走 change）
  $("#entry-table").addEventListener("click", (e) => {
    if (e.target.closest("a") || e.target.closest(".pick-box")) return;
    const tr = e.target.closest("tr[data-pk]");
    if (!tr) return;
    const k = tr.dataset.pk;
    const on = !state.selected.has(k);
    on ? state.selected.add(k) : state.selected.delete(k);
    const box = tr.querySelector(".pick-box");
    if (box) box.checked = on;
    updatePickBar();
  });

  // mb 卡片：点击卡片 = 勾/取消（与 PC 行为一致）
  $("#mb-list").addEventListener("click", (e) => {
    if (e.target.closest("a") || e.target.closest(".pick-box")) return;
    const card = e.target.closest(".yj-mb[data-pk]");
    if (!card) return;
    const k = card.dataset.pk;
    const on = !state.selected.has(k);
    on ? state.selected.add(k) : state.selected.delete(k);
    const box = card.querySelector(".pick-box");
    if (box) box.checked = on;
    card.classList.toggle("picked", on);
    updatePickBar();
  });

  // 空态行动按钮：切换全部场地 / 跳最近有赛日
  $("#empty").addEventListener("click", (e) => {
    const b = e.target.closest(".e-act");
    if (!b) return;
    if (b.dataset.act === "all-scope") {
      state.scope.clear();
      state.venues.clear();
      refresh();
    } else if (b.dataset.act === "near") {
      const dataDates = state.index.dates.map((d) => d.date);
      const today = todayBJ();
      const near = dataDates.reduce((a, c) =>
        Math.abs(new Date(c + "T00:00:00Z") - new Date(today + "T00:00:00Z")) <
        Math.abs(new Date(a + "T00:00:00Z") - new Date(today + "T00:00:00Z")) ? c : a
      );
      state.dates = new Set([near]);
      state.winStart = addDays(near, -1);
      refresh();
    }
  });

  // ---------- 列显隐（summary「列」菜单；localStorage 记忆；loc/馬名 固定显示） ----------
  function renderColMenu() {
    $("#col-mount").innerHTML =
      `<span class="col-wrap"><button id="col-btn" class="sel-page" type="button">自定义显示列 ▾</button>` +
      `<div id="col-menu" class="col-menu" hidden>` +
      COLUMNS.map((c) =>
        `<label class="col-item"><input type="checkbox" data-ck="${c.k}"${hiddenCols.has(c.k) ? "" : " checked"}>${esc(c.label)}</label>`
      ).join("") +
      `</div></span>`;
    const wrap = $("#col-mount .col-wrap");
    selRegistry.push({ wrap, close: () => $("#col-menu").hidden = true });
  }
  renderColMenu();
  $("#col-mount").addEventListener("click", (e) => {
    if (e.target.closest("#col-btn")) {
      const m = $("#col-menu");
      m.hidden = !m.hidden;
      return;
    }
    const ck = e.target.closest("input[data-ck]");
    if (!ck) return;
    if (!ck.checked && hiddenCols.size >= COLUMNS.length - 1) { ck.checked = true; return; }   // 至少保留一列
    ck.checked ? hiddenCols.delete(ck.dataset.ck) : hiddenCols.add(ck.dataset.ck);
    saveHiddenCols();
    renderThead();
    render();
  });

  // 分页交互：#pager-mount 上事件委托，重渲染后仍生效（disabled 与缺 data-page 跳过）
  $("#pager-mount").addEventListener("click", (e) => {
    const btn = e.target.closest(".pg-btn, .pg-nav");
    if (!btn || btn.disabled || !btn.dataset.page) return;
    const p = parseInt(btn.dataset.page, 10);
    if (!(p >= 1)) return;
    PG.page = p;
    render();
    // 表格顶已滚出视口上方时，翻页后回到 summary，避免停在长页尾部看不清新页开头
    if ($(".table-wrap").getBoundingClientRect().top < 0) $(".summary").scrollIntoView({ block: "start" });
  });

  // 断点切换：每页条数按设备重算（PC 100 / mb 20）并重渲染当前视图；页码越界由 render() 钳制
  // （老 Safari 无 addEventListener，退回 addListener）
  const onBreakpoint = () => {
    if (!state.index) return;   // 首次 render() 惰性初始化，加载完成前不响应
    PG.size = pgSizeDef();
    renderDateTabs();   // mb/PC 的日期 chip 数不同（3/5），断点切换重画
    render();
  };
  if (MB_MQL) {
    if (typeof MB_MQL.addEventListener === "function") MB_MQL.addEventListener("change", onBreakpoint);
    else if (typeof MB_MQL.addListener === "function") MB_MQL.addListener(onBreakpoint);
  }

  // 全选 / 取消本页：当前筛选 + 当前页展示的全部行（马）；render 重画勾选框（不重置页码）
  $("#sel-page").onclick = () => {
    for (const r of pageRows) state.selected.add(rowKeyOf(r));
    render();
    updatePickBar();
  };
  $("#desel-page").onclick = () => {
    for (const r of pageRows) state.selected.delete(rowKeyOf(r));
    render();
    updatePickBar();
  };
  $("#entry-table").addEventListener("change", (e) => {
    const b = e.target.closest(".pick-box");
    if (!b) return;
    b.checked ? state.selected.add(b.dataset.k) : state.selected.delete(b.dataset.k);
    updatePickBar();
  });
  $("#mb-list").addEventListener("change", (e) => {
    const b = e.target.closest(".pick-box");
    if (!b) return;
    b.checked ? state.selected.add(b.dataset.k) : state.selected.delete(b.dataset.k);
    b.closest(".yj-mb")?.classList.toggle("picked", b.checked);
    updatePickBar();
  });
  // mb：高级行折叠（竞马场/级别/血统/快捷；PC 按钮不显示，行恒展开）
  $("#f-adv").onclick = () => {
    const open = $(".filter-card").classList.toggle("adv-open");
    $("#f-adv").textContent = open ? "收起筛选 ▴" : "更多筛选 ▾";
  };
  $("#pick-clear").onclick = () => { state.selected.clear(); apply(); updatePickBar(); };
  $("#pick-go").onclick = goShare;
  // 已选预览：上拉列表开合
  $("#pick-toggle").onclick = () => {
    const list = $("#pick-list");
    list.hidden = !list.hidden;
    $("#pick-toggle").classList.toggle("open", !list.hidden);
    $("#pick-toggle").setAttribute("aria-expanded", String(!list.hidden));
  };
  // 预览列表逐条取消勾选
  $("#pick-bar").addEventListener("click", (e) => {
    const x = e.target.closest(".pl-x");
    if (!x) return;
    state.selected.delete(x.dataset.k);
    const box = document.querySelector(`#entry-table .pick-box[data-k="${CSS.escape(x.dataset.k)}"]`);
    if (box) box.checked = false;
    updatePickBar();
  });

  // 深链：?group=（已在上方 URL 恢复时读入 state.group）→ 这里只回显下拉；?_demo= 展开第一个血统下拉（视觉自检用）
  if (["sire", "sireSire", "bms", "jockey", "trainer"].includes(g)) groupSel.setValue(g);

  await refresh();
  if (qp.get("share") === "open") {            // 新标签页分享卡：读取 opener 复制来的 sessionStorage 载荷
    try {
      const picked = JSON.parse(sessionStorage.getItem("rc.share.payload") ?? "null");
      if (Array.isArray(picked) && picked.length) {
        const m = await import("./share.js");
        m.show(picked);
      }
    } catch (e) { console.error(e); }
    sessionStorage.removeItem("rc.share.payload");
  } else if (qp.get("share") === "demo") {     // 自检：全部日期 → 级别赛 → 直接打开分享卡（本页内）
    state.dates = new Set(state.index.dates.map((d) => d.date));
    await refresh();
    await demoPick(true);
    if (qp.has("edit")) await gridSelfTest(qp.get("edit") === "2");
  } else if (qp.get("pick") === "demo") {      // 自检：已选浮动条（&list=1 顺带展开上拉预览）
    demoPick(false);
    if (qp.has("list")) { $("#pick-list").hidden = false; $("#pick-toggle").classList.add("open"); }
  }
  if (qp.has("_demo")) sireSel.open();
}

main().catch((e) => {
  $("#count").textContent = "加载失败：" + e.message;
  console.error(e);
});
