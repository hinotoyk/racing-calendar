// 出走表展示（docs/DESIGN.md §7）— yunji-web 风格
// 数据：_site/derived/index.json + {date}.json（按日懒加载；{date}.json 为字典包，经 codec.mjs 解包）
// 约定（用户定稿 2026-10-22，均以北京时间为基准日）：
//   - 日期标签每次加载按「今天」现算：默认窗口 = 今天±2 共 5 天，‹ › 翻页，可选任意有数据日
//   - 场地 scope = JRA / NAR / 国家组码（GB、IRE、FR、USA…，来自 Racing Post 源）
//   - 场 chips 常驻展示名单 17 场 + 有数据的海外场；级别 = 13 桶（index.levels，半角标签）
//   - 表列：当地比赛时间（日付+発走，附场馆）/ 北京时间（由 startTimeInstant 换算）/ 比赛名 / 距离 /
//           枠 / 番 / 馬名 / 性齢 / 斤量 / 騎手 / 調教師 / 父 / 父父 / 母 / 母父
import { unpackRows } from "./codec.mjs";
import { normalizeHorseName } from "./horse-name.mjs";

const $ = (s) => document.querySelector(s);
const JBIS = "https://www.jbis.or.jp";

let sireSel, sireSireSel, bmsSel, groupSel;   // 血统/分组选择器实例（main 中创建）

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
  selectMode: false,          // 勾选模式（分享卡入口）
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
function chip(label, value, on, key, count) {
  const badge = count != null ? `<small>${count}</small>` : "";
  const off = count === 0 && !on ? " off" : "";   // 已选中的 0 头 chip 不置灰（默认 JRA 今日无赛仍可选）
  return `<button data-k="${key}" data-v="${esc(value)}" class="filter-chip${on ? " on" : ""}${off}">${esc(label)}${badge}</button>`;
}

// 日期窗口：winStart 起 5 天；无数据日也展示并可点击（选中后表格为空态）
function renderDateTabs() {
  const byDate = new Map(state.index.dates.map((d) => [d.date, d]));
  const chips = [];
  for (let i = 0; i < 5; i++) {
    const date = addDays(state.winStart, i);
    const info = byDate.get(date);
    chips.push(
      `<button data-d="${date}" class="filter-chip${state.dates.has(date) ? " on" : ""}">` +
      `${esc(dateLabelOf(date))}<small>${info?.runners ?? 0}頭</small></button>`,
    );
  }
  $("#date-tabs").innerHTML = chips.join("");
  // ‹ 在数据起点处禁用（更早日期从未采集）
  const { first } = dataRange();
  $("#d-prev").disabled = !!first && state.winStart <= first;
  $("#d-prev").title = $("#d-prev").disabled ? "已是最早数据日" : "更早 5 天";
}

// 场地 chips：全部 / JRA / NAR / 数据里出现的国家组码（动态，多选、带头数）
function renderScopes() {
  const counts = new Map();
  for (const r of allRows()) counts.set(r.scope, (counts.get(r.scope) ?? 0) + 1);
  const rank = (s) => (s === "JRA" ? 0 : s === "NAR" ? 1 : 2);
  const scopes = [...new Set(state.index.venues.map((v) => v.scope))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b)
  );
  $("#scope-chips").innerHTML =
    chip("全部", "", state.scope.size === 0, "scope", null) +
    scopes.map((sc) => chip(sc, sc, state.scope.has(sc), "scope", counts.get(sc) ?? 0)).join("");
}

// 场：固定名单常驻（中央10 + 地方7）+ 有数据的海外场
function renderVenues() {
  const counts = new Map();
  for (const r of allRows()) counts.set(r.venue, (counts.get(r.venue) ?? 0) + 1);
  const names = [
    ...state.index.tracks.central,
    ...state.index.tracks.local,
    ...state.index.venues.filter((v) => v.scope !== "JRA" && v.scope !== "NAR").map((v) => v.venue).sort(),
  ];
  const seen = new Set();
  const list = names.filter((n) => (seen.has(n) ? false : seen.add(n)));
  $("#venue-chips").innerHTML = list
    .map((n) => chip(n, n, state.venues.has(n), "venue", counts.get(n) ?? 0))
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
    if (selected) { selected = ""; input.value = ""; onPick(""); }   // 同 yunji：聚焦即清空已选、展示全列表
    render(input.value);
    drop.classList.add("open");
  });
  input.addEventListener("input", () => {
    if (selected) { selected = ""; onPick(""); }
    render(input.value);
    drop.classList.add("open");
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
    setValue(v) {
      selected = v || "";
      const it = items.find((x) => x.v === selected);
      input.value = it ? labelOf(it) : (v || "");
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
function apply() {
  PG.page = 1;   // 筛选条件变化 → 归第 1 页
  const q = state.q.trim().toLowerCase();
  state.rows = allRows().filter((r) => {
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
  });
  render();
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
  // 上拉预览：按 rowsForPick 顺序列出勾选行（馬名 · 场R · 比赛名），逐条可取消
  const items = [];
  for (const r of rowsForPick()) {
    const k = rowKeyOf(r);
    if (!state.selected.has(k)) continue;
    items.push(`<div class="pl-item"><span class="pl-h">${esc(r.horseName ?? "")}</span>` +
      `<span class="pl-r">${esc(r.venue)}${r.raceNo}R · ${esc(r.raceName ?? "")}</span>` +
      `<button type="button" class="pl-x" data-k="${esc(k)}" title="取消勾选">✕</button></div>`);
  }
  $("#pick-list").innerHTML = items.join("");
}

// 已勾选行 → 分享卡 race 对象：同一场比赛的勾选行归入同一块，只带勾选的馬（数据源为全部已加载日期）
function collectShareRaces() {
  const groups = new Map();
  for (const r of rowsForPick()) {
    if (!state.selected.has(rowKeyOf(r))) continue;
    const rk = rkOf(r);
    if (!groups.has(rk)) groups.set(rk, []);
    groups.get(rk).push(r);
  }
  return [...groups.values()].map((rows) => {
    const h = rows[0];
    return {
      raceKey: rkOf(h), date: h.date, dateLabel: h.dateLabel, weekday: h.weekday,
      scope: h.scope, country: h.country, venue: h.venue, raceNo: h.raceNo,
      raceName: h.raceName, level: h.level, surface: h.surface, distance: h.distance,
      heads: h.heads ?? rows.length, startTime: h.startTime, startTimeTz: h.startTimeTz,
      startTimeInstant: h.startTimeInstant,
      runners: rows.map((r) => ({
        frame: r.frame, num: r.num, horseName: r.horseName, sex: r.sex, age: r.age,
        color: r.color, jockey: r.jockey, weight: r.weight, trainer: r.trainer, belongs: r.belongs,
        owner: r.owner, breeder: r.breeder, sire: r.sire, sireSire: r.sireSire, dam: r.dam, bms: r.bms,
      })),
    };
  });
}

// 进入分享卡（新标签页）：载荷经 sessionStorage 复制给新页，?share=open 读取后渲染
function goShare() {
  const races = collectShareRaces();
  if (!races.length) return;
  $("#pick-list").hidden = true;
  $("#pick-toggle").classList.remove("open");
  try {
    sessionStorage.setItem("rc.share.payload", JSON.stringify(races));
  } catch (e) {
    console.error(e);
    return;
  }
  window.open("?share=open", "_blank");
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
  if (open) import("./share.js").then((m) => m.show(collectShareRaces())).catch((e) => console.error(e));   // 自检：页内直开
}

// ---------- 渲染 ----------
function rowHtml(r) {
  const dist = r.distance ? `${SURF_SHORT[r.surface] ?? r.surface ?? ""}${r.distance}` : "";
  const distTitle = [r.surface, r.distance ? `${r.distance}m` : ""].filter(Boolean).join(" ");
  const name = r.raceUrl
    ? `<a class="rlink" href="${esc(r.raceUrl)}" target="_blank" rel="noopener" title="${esc(r.raceName ?? "")}">${esc(r.raceName ?? "")}</a>`
    : `<span title="${esc(r.raceName ?? "")}">${esc(r.raceName ?? "")}</span>`;
  return `<tr>
    <td class="c-left loc" title="${esc(r.startTimeInstant ?? "")}"><input type="checkbox" class="pick-box" data-k="${esc(rowKeyOf(r))}"${state.selected.has(rowKeyOf(r)) ? " checked" : ""} aria-label="勾选 ${esc(r.horseName ?? "")}"><span class="v">${esc(r.venue)}${r.raceNo}R</span>${esc(r.dateLabel ?? "")} ${esc(r.startTime ?? "")}</td>
    <td class="num">${esc(bjTime(r.startTimeInstant))}</td>
    <td class="c-left race"><span class="rname">${name}</span>${levelBadge(r.level)}</td>
    <td class="num" title="${esc(distTitle)}">${esc(dist)}</td>
    <td class="num">${r.frame ?? ""}</td>
    <td class="num">${r.num ?? ""}</td>
    <td class="c-left name">${horseLink(r.horseId, r.horseName)}</td>
    <td class="num">${esc((r.sex ?? "") + (r.age ?? ""))}</td>
    <td class="num">${r.weight ?? ""}</td>
    <td class="c-left">${esc(r.jockey ?? "")}</td>
    <td class="c-left">${esc(r.trainer ?? "")}</td>
    <td class="c-left ped">${esc(r.sire ?? "")}</td>
    <td class="c-left ped">${esc(r.sireSire ?? "")}</td>
    <td class="c-left ped">${esc(r.dam ?? "")}</td>
    <td class="c-left ped">${esc(r.bms ?? "")}</td>
  </tr>`;
}

const COLSPAN = 15;

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

// 空态说明：默认只选 JRA 时，工作日通常没有中央比赛，提示切换到日期 / 全部场地
function emptyText() {
  if (state.scope.size === 1 && state.scope.has("JRA")) {
    return "当前条件下没有出走马（中央比赛多在周六、周日；出馬表约开赛前 2 日公开，可切换日期或选「全部」）";
  }
  return "当前条件下没有出走马（中央出馬表约开赛前 2 日公开，地方约前日，海外为英国当日）";
}

// 渲染当前视图：前端内存分页，每页最多 PG.size 条数据行；≤100 行直接 innerHTML，无需分块
function render() {
  PG.size ||= pgSizeDef();   // 首次惰性初始化（PC 100 / mb 20）
  const rows = state.rows;
  const races = new Set(rows.map((r) => r.raceKey ?? r.date + r.track + r.raceNo)).size;

  $("#empty").hidden = rows.length > 0;
  $("#empty").textContent = rows.length ? "" : emptyText();

  const body = $("#entry-table tbody");
  let pages = 1, shown = 0;

  if (!state.group) {
    // 不分组：数据行等宽切片
    pages = Math.max(1, Math.ceil(rows.length / PG.size));
    PG.page = Math.min(Math.max(PG.page, 1), pages);   // 页码越界修正
    const start = (PG.page - 1) * PG.size;
    shown = Math.min(rows.length - start, PG.size);   // 本页数据行数（末页为余数）
    body.innerHTML = rows.slice(start, start + PG.size).map(rowHtml).join("");
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
      parts.push(`<tr class="sub"><td colspan="${COLSPAN}"><b>${label}：${esc(pedKey ? displayOf(seg.k) : seg.k)}</b>${seg.list.length} 頭 / ${gr} R</td></tr>`);
      parts.push(...seg.list.slice(seg.a, seg.b).map(rowHtml));
      shown += seg.b - seg.a;
    }
    body.innerHTML = parts.join("");
  }

  $("#count").innerHTML = `共 <b>${rows.length}</b> 頭 · <b>${races}</b> R` +
    (pages > 1 ? ` <span class="muted">当前第 ${PG.page} / ${pages} 页 · 显示 ${shown} 条</span>` : "");
  renderPager(pages, rows.length);
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
    $("#count").textContent = "尚无出走表数据";
    $("#empty").hidden = false;
    $("#empty").textContent = "尚无数据：运行 npm run collect 后重新构建站点";
    return;
  }
  defaultDates();
  defaultScope();

  // 血统选择器（参考 yunji selector.js：搜索下拉 + 键盘导航 + 点击外部关闭）
  sireSel = makeSelector({ mount: $("#m-sire"), placeholder: "父", onPick: (v) => { state.sire = v || ""; apply(); } });
  sireSireSel = makeSelector({ mount: $("#m-siresire"), placeholder: "父父", onPick: (v) => { state.sireSire = v || ""; apply(); } });
  bmsSel = makeSelector({ mount: $("#m-bms"), placeholder: "母父", onPick: (v) => { state.bms = v || ""; apply(); } });
  // 分组选择器：与血统下拉同款；空 = 不分组
  groupSel = makeSelector({ mount: $("#m-group"), placeholder: "不分组", onPick: (v) => { state.group = v || ""; render(); } });
  groupSel.setItems(GROUP_OPTIONS);

  // 事件
  $("#reset").onclick = resetFilters;
  $("#d-prev").onclick = () => {
    const { first } = dataRange();
    const next = addDays(state.winStart, -5);
    state.winStart = first && next < first ? first : next;
    renderDateTabs();
  };
  $("#d-next").onclick = () => { state.winStart = addDays(state.winStart, 5); renderDateTabs(); };
  $("#d-today").onclick = () => {
    const { first } = dataRange();
    state.winStart = addDays(todayBJ(), -2);
    if (first && state.winStart < first) state.winStart = first;
    renderDateTabs();
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
    render();
  };
  if (MB_MQL) {
    if (typeof MB_MQL.addEventListener === "function") MB_MQL.addEventListener("change", onBreakpoint);
    else if (typeof MB_MQL.addListener === "function") MB_MQL.addListener(onBreakpoint);
  }

  // 勾选比赛（分享卡入口）
  $("#pick-mode").onclick = () => {
    state.selectMode = !state.selectMode;
    document.body.classList.toggle("picking", state.selectMode);
    $("#pick-mode").textContent = state.selectMode ? "完成勾选" : "勾选比赛";
    $("#pick-mode").classList.toggle("on", state.selectMode);
    // 完成勾选：已有勾选 → 直接进分享卡页（新开一页数据）；没有则仅退出勾选模式
    if (!state.selectMode && state.selected.size) goShare();
  };
  $("#entry-table").addEventListener("change", (e) => {
    const b = e.target.closest(".pick-box");
    if (!b) return;
    b.checked ? state.selected.add(b.dataset.k) : state.selected.delete(b.dataset.k);
    updatePickBar();
  });
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

  // 深链：?group=sire|sireSire|bms|jockey|trainer；?_demo= 展开第一个血统下拉（视觉自检用）
  const qp = new URLSearchParams(location.search);
  const g = qp.get("group");
  if (["sire", "sireSire", "bms", "jockey", "trainer"].includes(g)) {
    state.group = g;
    groupSel.setValue(g);
  }

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
    demoPick(true);
  } else if (qp.get("pick") === "demo") {      // 自检：勾选模式 + 已选浮动条（&list=1 顺带展开上拉预览）
    state.selectMode = true;
    document.body.classList.add("picking");
    $("#pick-mode").textContent = "完成勾选";
    $("#pick-mode").classList.add("on");
    demoPick(false);
    if (qp.has("list")) { $("#pick-list").hidden = false; $("#pick-toggle").classList.add("open"); }
  }
  if (qp.has("_demo")) sireSel.open();
}

main().catch((e) => {
  $("#count").textContent = "加载失败：" + e.message;
  console.error(e);
});
