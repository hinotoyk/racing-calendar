/* ============================================================
 * share-grid.js —— 出馬表分享卡 · Excel 式批量编辑（§参考 yunji-web editor-table.js §104）
 * ------------------------------------------------------------
 * 定稿：整页密表 + 单元格就地编辑 + Enter↓ / Tab→ / 方向键移动 + Ctrl+Z·Y 撤销重做 +
 * 行首勾选批量删除 + 粘贴导入（Excel TSV）+ 列显隐 + CSS 伪全屏。
 * 分组结构：比赛头行（race 级字段，就地改）+ 出走馬行（runner 级字段）；编辑直接改
 * share.js 持有的 races 数据并回调 onChange()（画布即时重绘），无草稿层、无提交。
 * 手机端不开放（与 yunji 同款：窄屏隐藏编辑表格，只留提示）。
 * ============================================================ */

const WD = ["日", "月", "火", "水", "木", "金", "土"];

/* 列定义（三段式定稿 2026-10-29）：前面固定比赛名+格（先看是哪场）→ 中间编辑列（出走馬）
 * → 后面补固定的日期/场/R 等上下文列。race:1 = 比赛级（只在比赛头行可编辑，出走馬行灰显回显）；
 * front:1 = 比赛头行的前置段；num = 右对齐数字 */
const RACE_FRONT_COLS = [
  { k: "raceName", label: "比赛名", w: 210, race: 1, front: 1 },
  { k: "level", label: "格", w: 82, race: 1, type: "select", opts: ["", "G1", "G2", "G3", "L", "OP", "地方重赏"], front: 1 },
];
const RACE_BACK_COLS = [
  { k: "date", label: "日期", w: 88, race: 1 },
  { k: "venue", label: "场", w: 58, race: 1 },
  { k: "raceNo", label: "R", w: 36, race: 1, num: 1 },
  { k: "surface", label: "芝ダ", w: 52, race: 1, type: "select", opts: ["芝", "ダ", "障"] },
  { k: "distance", label: "距离", w: 58, race: 1, num: 1 },
  { k: "startTime", label: "当地", w: 58, race: 1 },
];
const RUN_COLS = [
  { k: "frame", label: "枠", w: 38, num: 1 },
  { k: "num", label: "番", w: 38, num: 1 },
  { k: "horseName", label: "馬名", w: 150 },
  { k: "sexage", label: "性齢", w: 52, virt: 1 },
  { k: "jockey", label: "騎手", w: 96 },
  { k: "weight", label: "斤量", w: 48, num: 1 },
  { k: "trainer", label: "調教師", w: 104 },
];
const LEVEL_LABEL = { "": "普通", G1: "G1", G2: "G2", G3: "G3", L: "L", OP: "OP", 地方重赏: "重賞" };

/* ---------- 比赛名显示缩短（2026-10-29 定稿，纯展示；不改原始数据） ----------
 * UK/IRE 命名模式：赞助商… 赛事类型 (级别) (Registered As The 注册名) (GBB Race) (Div n)。
 * 1) 有 Registered As → 直接采用官方注册名（跨年稳定，赞助商每年可能换）；
 * 2) 噪声标签剔除：GBB Race / GBBPlus / GBB/GBBPlus（繁育奖金计划）、Registered As 本体；
 * 3) 有意义标签原位保留：Grade/Group/Listed（级别）、Div/Division（同场分流）、
 *    0-100 等评级、Q.R.（合格骑师）、F & M 等其余括号段一律不动。
 * 赞助商前缀不剥（无词典不可靠，如 squareintheair.com Handicap Chase 赞助商即主体名）。 */
export function shortRaceName(name) {
  const s = String(name ?? "").trim();
  if (!s) return "";
  const parens = /([（(][^（）)]*[）)])/g;
  const bare = (m) => m.slice(1, -1).trim();
  // 噪声 = 奖金计划 + 注册名本体 + 级别标签（GⅡ/L 徽章与表格「格」列已表达，避免重复）
  const isJunk = (t) => /^(GBB|Registered As\b|Grade\b|Group\b|Listed\b)/i.test(t);
  const tags = [];
  let m;
  const re = new RegExp(parens.source, "g");
  while ((m = re.exec(s))) tags.push(bare(m[0]));
  const reg = tags.find((t) => /^Registered As\s+/i.test(t));
  if (reg) {   // 官方注册名 + 其余非噪声标签（Grade/Div/评级…，保留括号）
    const keep = tags.filter((t) => !isJunk(t)).map((t) => `(${t})`);
    return [reg.replace(/^Registered As\s+/i, "").trim(), ...keep].filter(Boolean).join(" ");
  }
  // 无注册名：原位剔除噪声标签，其余原样（保住中位标签如 (Q.R.) 的位置）
  return s.replace(parens, (mm) => (isJunk(bare(mm)) ? " " : mm))
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([）)])/g, "$1")
    .trim();
}

export function createGrid(opts) {
  const root = opts.root;                 // 工具条 + 表格卡容器
  const racesOf = opts.races;             // () => races（share.js 持有）
  const onChange = opts.onChange;         // 数据变更回调（画布重绘 / 计数）

  const els = {};
  const S = {
    view: [],            // [{t:'race',race} | {t:'run',race,runner}]
    sel: new Set(),      // runner 对象引用
    hidden: {},
    cur: null, editing: null,
    undoJ: [], redoJ: [],
    batch: 0, jbuf: [],
    target: null,        // 追加/粘贴的目标比赛
    fs: false,
  };

  /* ---------- 小工具 ---------- */
  const $ = (s, el) => (el || document).querySelector(s);
  const $all = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const commitVal = (v) => { const s = String(v ?? "").trim(); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s; };
  const sexAgeGet = (r) => `${r.sex ?? ""}${r.age ?? ""}`;
  const sexAgeSet = (r, v) => {
    const m = /^([牡牝セ])\s*(\d+)?\s*$/.exec(String(v ?? "").trim());
    r.sex = m ? m[1] : (String(v ?? "").trim() || null);
    r.age = m && m[2] ? +m[2] : null;
  };
  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg; els.toast.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { els.toast.hidden = true; }, 2400);
  }

  /* ---------- 撤销/重做 ---------- */
  function push(entry) {
    if (S.batch) { S.jbuf.push(entry); return; }
    S.undoJ.push(entry);
    if (S.undoJ.length > 80) S.undoJ.shift();
    S.redoJ.length = 0;
    syncToolbar();
  }
  function jBegin() { S.batch++; S.jbuf = []; }
  function jEnd() {
    S.batch--;
    if (!S.batch && S.jbuf.length) {
      const buf = S.jbuf; S.jbuf = [];
      push({ undo: () => { for (let i = buf.length - 1; i >= 0; i--) buf[i].undo(); }, redo: () => buf.forEach((e) => e.redo()) });
    }
  }
  function undo() {
    if (S.editing) commitEdit();
    const e = S.undoJ.pop();
    if (!e) { toast("没有可撤销的操作"); return; }
    S.redoJ.push(e); e.undo(); afterHistory(); toast("已撤销");
  }
  function redo() {
    if (S.editing) commitEdit();
    const e = S.redoJ.pop();
    if (!e) { toast("没有可重做的操作"); return; }
    S.undoJ.push(e); e.redo(); afterHistory(); toast("已重做");
  }
  function afterHistory() { hydrate(); onChange(); }   // 撤销/重做可能改结构 → 重建视图再回调

  /* ---------- 派生字段（日期/时间改动 → instant/weekday/dateLabel 重算） ---------- */
  function tzOffOf(race) {
    if (race.startTimeTz === "Asia/Tokyo") return "+09:00";
    const m = /([+-]\d{2}:\d{2})$/.exec(race.startTimeInstant ?? "");
    return m ? m[1] : "+09:00";
  }
  function touchRace(race) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(race.date ?? "")) {
      race.weekday = WD[new Date(race.date + "T00:00:00Z").getUTCDay()] ?? "";
      race.dateLabel = race.date.slice(5);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(race.date ?? "") && /^\d{1,2}:\d{2}$/.test(race.startTime ?? "")) {
      race.startTimeInstant = `${race.date}T${race.startTime}:00${tzOffOf(race)}`;
    }
  }

  /* ---------- 视图构建 ---------- */
  function hydrate() {
    S.view = [];
    for (const race of racesOf()) {
      S.view.push({ t: "race", race });
      for (const runner of race.runners) S.view.push({ t: "run", race, runner });
    }
    S.target = racesOf().at(-1) ?? null;
    S.cur = null;   // 重建后旧光标行号失效
    render();
  }
  const cols = () => [...RACE_FRONT_COLS, ...RUN_COLS, ...RACE_BACK_COLS].filter((c) => !S.hidden[c.k]);
  function itemAt(vi) { return S.view[vi] ?? null; }
  function locateCell(vi, key) {
    return $(`td[data-vi="${vi}"][data-c="${CSS.escape(key)}"]`, els.tbody);
  }

  /* ---------- 单元格取值 / 赋值 ---------- */
  function cellGet(item, c) {
    if (c.race) return item.race[c.k];            // 比赛级列：出走馬行也回显所属比赛的值（只读）
    if (c.virt) return sexAgeGet(item.runner);
    return item.runner[c.k];
  }
  function cellSet(item, c, val) {
    if (c.virt) return sexAgeSet(item.runner, val);
    if (item.t === "race") { item.race[c.k] = val; touchRace(item.race); }
    else item.runner[c.k] = val;
  }

  /* ---------- 渲染 ---------- */
  function renderHead() {
    let h = '<tr><th class="sg-mark"></th><th class="sg-ck"><input id="sg-ckAll" type="checkbox" title="全选/全不选出走馬"></th>';
    for (const c of cols()) h += `<th data-k="${esc(c.k)}"${c.race ? ' data-race="1"' : ""}>${esc(c.label)}</th>`;
    h += "</tr>";
    els.thead.innerHTML = h;
    const ck = $("#sg-ckAll", els.thead);
    if (ck) ck.addEventListener("change", () => {
      if (ck.checked) S.view.forEach((v) => { if (v.t === "run") S.sel.add(v.runner); });
      else S.sel.clear();
      render(); syncToolbar();
    });
  }

  function cellText(item, c) {
    const v = cellGet(item, c);
    if (c.k === "level") return v ? (LEVEL_LABEL[v] ?? v) : "";
    if (v == null || v === "") return "";
    if (c.k === "raceName") return shortRaceName(v);   // 表格显示缩短；编辑时输入框仍是完整原名
    return String(v);
  }

  function render() {
    const h = [];
    let raceToggle = false;
    S.view.forEach((item, vi) => {
      if (item.t === "race") {
        raceToggle = !raceToggle;
        h.push(`<tr class="sg-race${raceToggle ? "" : " alt"}" data-vi="${vi}">`);
        h.push('<td class="sg-mark"><i>◈</i></td><td class="sg-ck"><input type="checkbox" class="sg-all" data-vi="' + vi + '" title="全选该场"></td>');
        // 前段：比赛名 + 格（可编辑）
        for (const c of cols()) {
          if (!c.race || !c.front) continue;
          h.push(`<td class="sg-c${c.num ? " num" : ""}" data-vi="${vi}" data-c="${esc(c.k)}">${esc(cellText(item, c))}</td>`);
        }
        // 中段：出走馬列区域 = 场操作（N頭 / ↑↓ ＋ ✕）
        const n = item.race.runners.length;
        const rc = item.race;
        const idx = racesOf().indexOf(rc);
        h.push(`<td class="sg-ops" colspan="${Math.max(1, cols().filter((c) => !c.race).length)}">` +
          `<span class="sg-n">${n}頭</span>` +
          `<span class="sg-opb">` +
          `<button type="button" data-op="up" data-vi="${vi}" title="上移本场" ${idx <= 0 ? "disabled" : ""}>↑</button>` +
          `<button type="button" data-op="down" data-vi="${vi}" title="下移本场" ${idx >= racesOf().length - 1 ? "disabled" : ""}>↓</button>` +
          `<button type="button" data-op="add" data-vi="${vi}" title="本场追加出走馬">＋</button>` +
          `<button type="button" data-op="delr" data-vi="${vi}" title="删除本场">✕</button>` +
          `</span></td>`);
        // 后段：日期 / 场 / R 等固定上下文列（可编辑）
        for (const c of cols()) {
          if (!c.race || c.front) continue;
          h.push(`<td class="sg-c${c.num ? " num" : ""}" data-vi="${vi}" data-c="${esc(c.k)}">${esc(cellText(item, c))}</td>`);
        }
        h.push("</tr>");
      } else {
        const r = item.runner;
        h.push(`<tr class="sg-run" data-vi="${vi}">`);
        h.push('<td class="sg-mark"><i>·</i></td>');
        h.push(`<td class="sg-ck"><input type="checkbox" class="sg-sel" data-vi="${vi}"${S.sel.has(r) ? " checked" : ""}></td>`);
        for (const c of cols()) {
          if (c.race) {
            const v = cellText(item, c);
            h.push(`<td class="sg-echo${c.num ? " num" : ""}" data-vi="${vi}" data-c="${esc(c.k)}"${v ? ` title="${esc(v)}"` : ""}>${esc(v)}</td>`);
          } else {
            h.push(`<td class="sg-c${c.num ? " num" : ""}" data-vi="${vi}" data-c="${esc(c.k)}">${esc(cellText(item, c))}</td>`);
          }
        }
        h.push("</tr>");
      }
    });
    if (!S.view.length) h.push('<tr><td class="sg-empty" colspan="20">没有比赛：返回列表勾选，或手动添加比赛</td></tr>');
    els.tbody.innerHTML = h.join("");
    els.meta.textContent = `${racesOf().length} 场 · ${racesOf().reduce((n, r) => n + r.runners.length, 0)}頭`;
    syncToolbar();
  }

  function syncToolbar() {
    if (els.undoBtn) els.undoBtn.disabled = !S.undoJ.length;
    if (els.redoBtn) els.redoBtn.disabled = !S.redoJ.length;
    if (els.delBtn) els.delBtn.disabled = !S.sel.size;
    if (els.delBtn) els.delBtn.textContent = `删除所选${S.sel.size ? `（${S.sel.size}）` : ""}`;
  }

  /* ---------- 就地编辑 ---------- */
  function startEdit(td) {
    const vi0 = +td.getAttribute("data-vi"), key = td.getAttribute("data-c");
    if (S.editing) {
      if (S.editing.td === td) return;
      commitEdit();
      td = locateCell(vi0, key);
      if (!td) return;
    }
    const item = itemAt(vi0);
    if (!item) return;
    const c = cols().find((x) => x.k === key);
    if (!c) return;
    if (item.t === "run" && c.race) { setCursor(td); return; }   // 出走馬行上的比赛字段灰显只读
    setCursor(null);
    const itemRef = item.t === "race" ? item.race : item.runner;
    const oldRaw = c.virt ? sexAgeGet(item.runner) : (itemRef[c.k] == null ? "" : itemRef[c.k]);
    const old = oldRaw == null ? "" : String(oldRaw);
    if (window.getComputedStyle(td).position === "static") td.style.position = "relative";
    td.innerHTML = '<span class="invisible whitespace-pre">' + esc(old) + "</span>";
    let inp;
    if (c.type === "select") {
      inp = document.createElement("select");
      c.opts.forEach((o) => {
        const op = document.createElement("option"); op.value = o; op.textContent = o === "" ? "（普通）" : o; inp.appendChild(op);
      });
      if (![...inp.options].some((op) => op.value === old) && old) {
        const op2 = document.createElement("option"); op2.value = old; op2.textContent = old; inp.appendChild(op2);
      }
      inp.value = old;
    } else {
      inp = document.createElement("input");
      inp.type = "text"; inp.value = old;
      inp.placeholder = c.k === "date" ? "YYYY-MM-DD" : c.k === "time" ? "HH:MM" : "";
    }
    inp.className = "sg-inp absolute left-0 top-0" + (c.num ? " num" : "");
    td.appendChild(inp); inp.focus();
    if (inp.select) inp.select();
    S.editing = { td, vi: vi0, key, old, input: inp, item, c, itemRef };
    inp.addEventListener("blur", () => commitEdit());
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commitEdit(); moveCursor(1, 0, true); }
      else if (e.key === "Tab") { e.preventDefault(); commitEdit(); moveCursor(0, 1, true); }
      else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    });
  }
  function commitEdit() {
    if (!S.editing) return;
    const e = S.editing; S.editing = null;
    applyCell(e.item, e.c, e.input.value, e.old);
  }
  function cancelEdit() {
    if (!S.editing) return;
    const e = S.editing; S.editing = null;
    render();
    const td = locateCell(e.vi, e.key);
    if (td) setCursor(td);
  }
  function applyCell(item, c, val, old) {
    val = String(val ?? "").trim();
    const oldEff = old == null ? "" : String(old);
    if (val === oldEff) {   // 未变更：只回光标，不进日志
      render();
      const td = locateCell(S.view.indexOf(item), c.k);
      if (td) setCursor(td);
      return;
    }
    jBegin();
    push({
      undo: () => setVal(c, item, oldEff),
      redo: () => setVal(c, item, val),
    });
    setVal(c, item, val);
    jEnd();
    render(); onChange();
    const td = locateCell(S.view.indexOf(item), c.k);
    if (td) setCursor(td);

    function setVal(col, it, v) {
      if (col.virt) sexAgeSet(it.runner, v);
      else if (it.t === "race") { it.race[col.k] = col.type === "select" ? v : commitVal(v); touchRace(it.race); }
      else it.runner[col.k] = col.type === "select" ? v : commitVal(v);
    }
  }

  /* ---------- 光标 ---------- */
  function setCursor(td) {
    $all("td.cur", els.tbody).forEach((x) => x.classList.remove("cur"));
    if (!td) { S.cur = null; return; }
    td.classList.add("cur");
    S.cur = { vi: +td.getAttribute("data-vi"), key: td.getAttribute("data-c") };
  }
  function cursorTd() { return S.cur ? locateCell(S.cur.vi, S.cur.key) : null; }
  function moveCursor(dr, dc, thenEdit) {
    if (!S.cur) return;
    const vi = Math.max(0, Math.min(S.view.length - 1, S.cur.vi + dr));
    const item = itemAt(vi);
    if (!item) return;
    const vis = cols();
    // 本行实际存在的列：比赛头行 = 比赛级列（前段+后段，跳过出走馬跨列区）；出走馬行 = 全部
    const keys = vis.filter((c) => (item.t === "race" ? c.race : true)).map((c) => c.k);
    let ci = keys.indexOf(S.cur.key);
    if (ci < 0) ci = 0;   // 纵向跨行落进不存在的列 → 取该行第一列
    ci = Math.max(0, Math.min(keys.length - 1, ci + dc));
    const td = locateCell(vi, keys[ci]);
    if (!td) return;
    td.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (thenEdit) startEdit(td); else setCursor(td);
  }

  /* ---------- 行/场操作 ---------- */
  function targetRace(vi) {
    if (vi != null) {
      const item = itemAt(vi);
      if (item) { S.target = item.race; return item.race; }
    }
    if (!S.target || !racesOf().includes(S.target)) S.target = racesOf().at(-1) ?? null;
    return S.target;
  }
  function addRunner(vi) {
    const race = targetRace(vi);
    if (!race) { toast("先添加一场比赛"); return; }
    const runner = { frame: null, num: race.runners.length + 1, horseName: "", sex: null, age: null, jockey: null, weight: null };
    jBegin();
    race.runners.push(runner);
    race.heads = race.runners.length;
    push({
      undo: () => { const i = race.runners.indexOf(runner); if (i >= 0) race.runners.splice(i, 1); race.heads = race.runners.length; },
      redo: () => { race.runners.push(runner); race.heads = race.runners.length; },
    });
    jEnd();
    hydrate(); onChange();
    const item = S.view.find((v) => v.t === "run" && v.runner === runner);
    if (item) {
      const td = locateCell(S.view.indexOf(item), "horseName");
      if (td) { td.scrollIntoView({ block: "nearest" }); startEdit(td); }
    }
  }
  function delSelected() {
    if (!S.sel.size) return;
    // 删除前定格：{race, runner, idx}（idx = 删除时位置，撤销按位插回）
    const kept = [];
    for (const race of racesOf()) {
      for (let i = race.runners.length - 1; i >= 0; i--) {
        if (S.sel.has(race.runners[i])) kept.push({ race, runner: race.runners[i], idx: i });
      }
    }
    if (!kept.length) return;
    const remove = () => kept.forEach(({ race, runner }) => { const i = race.runners.indexOf(runner); if (i >= 0) race.runners.splice(i, 1); });
    const restore = () => kept.forEach(({ race, runner, idx }) => race.runners.splice(Math.min(idx, race.runners.length), 0, runner));
    const heads = () => racesOf().forEach((r) => { r.heads = r.runners.length; });
    jBegin();
    push({
      undo: () => { restore(); heads(); },
      redo: () => { remove(); heads(); S.sel.clear(); },
    });
    remove(); heads();
    jEnd();
    S.sel.clear();
    hydrate(); onChange();
    toast("已删除所选出走馬（Ctrl+Z 可恢复）");
  }
  function delRace(vi) {
    const race = targetRace(vi);
    if (!race) return;
    const idx = racesOf().indexOf(race);
    jBegin();
    push({
      undo: () => { racesOf().splice(Math.min(idx, racesOf().length), 0, race); },
      redo: () => { const i = racesOf().indexOf(race); if (i >= 0) racesOf().splice(i, 1); },
    });
    racesOf().splice(idx, 1);
    jEnd();
    S.sel.clear();
    hydrate(); onChange();
    toast("已删除本场（Ctrl+Z 可恢复）");
  }
  function moveRace(vi, dir) {
    const race = targetRace(vi);
    if (!race) return;
    const i = racesOf().indexOf(race), j = i + dir;
    if (j < 0 || j >= racesOf().length) return;
    jBegin();
    push({
      undo: () => { const cur = racesOf().indexOf(race); if (cur >= 0) racesOf().splice(cur, 1); racesOf().splice(i, 0, race); },
      redo: () => { const cur = racesOf().indexOf(race); if (cur >= 0) racesOf().splice(cur, 1); racesOf().splice(j, 0, race); },
    });
    racesOf().splice(i, 1); racesOf().splice(j, 0, race);
    jEnd();
    hydrate(); onChange();
  }

  /* ---------- 粘贴导入（Excel TSV：列序 = 可见出走馬列） ---------- */
  function parseTsv(txt) {
    return txt.replace(/\r/g, "").split("\n").map((l) => l.split("\t")).filter((cells) => cells.some((x) => x.trim() !== ""));
  }
  function pasteImport() {
    const race = targetRace();
    if (!race) { toast("先添加一场比赛"); return; }
    const doImport = (txt) => {
      const grid = parseTsv(txt);
      if (!grid.length) { toast("剪贴板没有可解析的内容"); return; }
      const runCols = cols().filter((c) => !c.race);
      jBegin();
      const added = [];
      push({
        undo: () => { added.forEach((r) => { const i = race.runners.indexOf(r); if (i >= 0) race.runners.splice(i, 1); }); race.heads = race.runners.length; },
        redo: () => { added.forEach((r) => { if (!race.runners.includes(r)) race.runners.push(r); }); race.heads = race.runners.length; },
      });
      grid.forEach((cells) => {
        const runner = { frame: null, num: race.runners.length + 1, horseName: "", sex: null, age: null, jockey: null, weight: null };
        runCols.forEach((c, i) => {
          const v = (cells[i] ?? "").trim();
          if (v === "") return;
          if (c.virt) sexAgeSet(runner, v);
          else runner[c.k] = commitVal(v);
        });
        if (!runner.horseName) runner.horseName = "馬名未入力";
        race.runners.push(runner);
        added.push(runner);
      });
      race.heads = race.runners.length;
      jEnd();
      hydrate(); onChange();
      toast(`已向 ${race.venue ?? ""}${race.raceNo ?? ""}R 导入 ${grid.length} 行（Ctrl+Z 可撤销）`);
    };
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(doImport).catch(() => {
        const t = window.prompt("剪贴板读取被拒绝——请 Ctrl+V 粘贴到这里（每行一頭，Tab 分列，按可见出走馬列序：枠 番 馬名 性齢 騎手 …）：");
        if (t) doImport(t);
      });
    } else {
      const t = window.prompt("请 Ctrl+V 粘贴 TSV（每行一頭，Tab 分列，按可见出走馬列序）：");
      if (t) doImport(t);
    }
  }

  /* ---------- 列显隐 ---------- */
  function buildColMenu() {
    els.colMenu.innerHTML = [...RACE_FRONT_COLS, ...RUN_COLS, ...RACE_BACK_COLS].map((c) =>
      `<label class="sg-col"><input type="checkbox" class="sg-colck" data-k="${esc(c.k)}"${S.hidden[c.k] ? "" : " checked"}> ${esc(c.label)}</label>`
    ).join("");
    $all(".sg-colck", els.colMenu).forEach((ck) => {
      ck.addEventListener("change", () => {
        if (!ck.checked) S.hidden[ck.getAttribute("data-k")] = 1;
        else delete S.hidden[ck.getAttribute("data-k")];
        renderHead(); render();
      });
    });
  }

  /* ---------- 全屏（CSS 伪全屏，同 yunji） ---------- */
  function fsToggle() {
    S.fs = !S.fs;
    root.classList.toggle("sg-fs", S.fs);
    document.body.style.overflow = S.fs ? "hidden" : "";
    if (els.fsBtn) els.fsBtn.textContent = S.fs ? "✕ 退出全屏" : "⛶ 全屏";
    if (!S.fs) render();
  }

  /* ---------- 事件 ---------- */
  function bind() {
    els.grid.addEventListener("click", (e) => {
      const opBtn = e.target.closest("[data-op]");
      if (opBtn) {
        const vi = +opBtn.getAttribute("data-vi"), op = opBtn.getAttribute("data-op");
        if (op === "up") moveRace(vi, -1);
        else if (op === "down") moveRace(vi, 1);
        else if (op === "add") addRunner(vi);
        else if (op === "delr") delRace(vi);
        return;
      }
      const td = e.target.closest("td[data-c]");
      if (td) startEdit(td);
    });
    els.grid.addEventListener("change", (e) => {
      if (e.target.classList.contains("sg-sel")) {
        const item = itemAt(+e.target.getAttribute("data-vi"));
        if (!item) return;
        e.target.checked ? S.sel.add(item.runner) : S.sel.delete(item.runner);
        syncToolbar();
      } else if (e.target.classList.contains("sg-all")) {
        const item = itemAt(+e.target.getAttribute("data-vi"));
        if (item?.t === "race") {
          if (e.target.checked) item.race.runners.forEach((r) => S.sel.add(r));
          else item.race.runners.forEach((r) => S.sel.delete(r));
          render(); syncToolbar();
        }
      }
    });
    // 键盘流挂 document（点击 td 后焦点在 body，表格元素收不到 keydown）；
    // 正在编辑 / 焦点在其它输入控件（筛选、手动添加表单、倍率下拉）时让位。
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && S.fs && !S.editing) { fsToggle(); return; }
      if (S.editing) return;
      if (e.target?.closest?.("input, textarea, select")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (!S.cur) return;
      const map = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (map[e.key]) { e.preventDefault(); moveCursor(map[e.key][0], map[e.key][1], false); }
      else if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); const td = cursorTd(); if (td) startEdit(td); }
      else if (e.key === "Delete" || e.key === "Backspace") {
        const td = cursorTd();
        if (!td) return;
        const item = itemAt(S.cur.vi);
        const c = cols().find((x) => x.k === S.cur.key);
        if (!item || !c || (item.t === "run" && c.race)) return;
        const ref = item.t === "race" ? item.race : item.runner;
        const old = c.virt ? sexAgeGet(item.runner) : (ref[c.k] == null ? "" : String(ref[c.k]));
        if (old !== "") applyCell(item, c, "", old);
      }
    });
    if (els.search) els.search.addEventListener("input", () => { /* 预留：行过滤 */ });
    if (els.addBtn) els.addBtn.addEventListener("click", () => addRunner(null));
    if (els.delBtn) els.delBtn.addEventListener("click", delSelected);
    if (els.undoBtn) els.undoBtn.addEventListener("click", undo);
    if (els.redoBtn) els.redoBtn.addEventListener("click", redo);
    if (els.pasteBtn) els.pasteBtn.addEventListener("click", pasteImport);
    if (els.fsBtn) els.fsBtn.addEventListener("click", fsToggle);
    if (els.colBtn) els.colBtn.addEventListener("click", (e) => { e.stopPropagation(); buildColMenu(); els.colMenu.hidden = !els.colMenu.hidden; });
    document.addEventListener("click", (e) => {
      if (els.colMenu && !e.target.closest("#sg-colMenu") && !e.target.closest("#sg-colBtn")) els.colMenu.hidden = true;
    });
  }

  /* ---------- init ---------- */
  ["grid", "toolbar", "thead", "tbody", "meta", "addBtn", "delBtn", "undoBtn", "redoBtn", "pasteBtn", "colBtn", "colMenu", "fsBtn", "toast"].forEach((k) => {
    els[k] = opts[k] ? (typeof opts[k] === "string" ? document.getElementById(opts[k]) : opts[k]) : null;
  });
  bind();
  renderHead();
  hydrate();

  return {
    hydrate,
    clearHistory() { S.undoJ = []; S.redoJ = []; S.sel.clear(); S.editing = null; syncToolbar(); },
  };
}
