// 全球重赏收集 · 页面逻辑（探索分支 feat/global-graded）
// 数据：/api/data（API 服务 9094）；兜底 /global-graded-data.json（静态副本）
"use strict";

const state = {
  data: null,            // graded.json 内容
  year: "all",           // all | 2025 | 2026 …（自然年 1/1-12/31）
  region: "all",         // all | jra | nar | overseas
  country: "all",        // all | JP | GB | ...
  grades: new Set(),     // 空集 = 全部级别
  ped: "all",            // all | line | bms
  rank: "all",           // all | win(1着) | top3(1-3着)
  q: "",
  video: {},             // raceId -> resolved entry
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- 数据加载 ----------
async function loadData() {
  let res = await fetch("/api/data").catch(() => null);
  if (!res || !res.ok) res = await fetch("/global-graded-data.json");
  if (!res.ok) throw new Error("数据加载失败（先跑 npm run graded:collect）");
  state.data = await res.json();
}

// ---------- 筛选 ----------
function filteredRaces() {
  const { data, year, region, country, grades, q } = state;
  return (data?.races ?? []).filter((r) => {
    if (year !== "all" && r.year !== year) return false;
    if (region === "overseas" && r.region !== "overseas") return false;
    if (region === "jra" && r.org !== "JRA") return false;
    if (region === "nar" && r.org !== "NAR") return false;
    if (country !== "all" && r.country !== country) return false;
    if (grades.size && !grades.has(r.grade)) return false;
    return true;
  });
}

function visibleRows(races) {
  const q = state.q.trim().toLowerCase();
  const rows = [];
  for (const r of races) {
    for (const u of r.runners) {
      if (state.ped === "line" && !u.di.line) continue;
      if (state.ped === "bms" && !u.di.broodmare) continue;
      if (state.rank === "win" && u.rank !== 1) continue;
      if (state.rank === "top3" && !(u.rank >= 1 && u.rank <= 3)) continue;
      if (q && !(`${u.horse ?? ""}${u.horseEn ?? ""}`.toLowerCase().includes(q))) continue;
      rows.push({ race: r, u });
    }
  }
  return rows;
}

// ---------- 渲染 ----------
function renderChips() {
  // 自然年 chips（1/1-12/31，含计数）
  const years = Object.entries(state.data?.years ?? {}).sort((a, b) => b[0] - a[0]);
  $("#chips-year").innerHTML =
    `<button class="chip ${state.year === "all" ? "on" : ""}" data-y="all">全部年份</button>` +
    years.map(([y, n]) => `<button class="chip ${state.year === y ? "on" : ""}" data-y="${y}">${y}年 <small>${n}</small></button>`).join("");
  $("#chips-year").querySelectorAll("[data-y]").forEach((b) =>
    b.onclick = () => { state.year = b.dataset.y; renderChips(); renderTable(); });

  const counts = state.data?.countries ?? {};
  const order = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const html = [`<button class="chip ${state.country === "all" ? "on" : ""}" data-c="all">全部国家</button>`]
    .concat(order.map(([code, n]) => {
      const c = state.data.countryMeta?.[code];
      const label = c ?? code;
      return `<button class="chip ${state.country === code ? "on" : ""}" data-c="${code}">${esc(label)} <small>${n}</small></button>`;
    }));
  $("#chips-country").innerHTML = html.join("");
  $("#chips-country").querySelectorAll("[data-c]").forEach((b) =>
    b.onclick = () => { state.country = b.dataset.c; renderChips(); renderTable(); });

  const grades = ["G1", "G2", "G3", "JG1", "JG2", "JG3", "Jpn1", "Jpn2", "Jpn3"];
  $("#chips-grade").innerHTML =
    `<button class="chip ${state.grades.size ? "" : "on"}" data-g="">全部级别</button>` +
    grades.map((g) => `<button class="chip ${state.grades.has(g) ? "on" : ""}" data-g="${g}">${g} <small>${gradeCount(g)}</small></button>`).join("");
  $("#chips-grade").querySelectorAll("[data-g]").forEach((b) =>
    b.onclick = () => {
      const g = b.dataset.g;
      if (!g) state.grades.clear(); else state.grades.has(g) ? state.grades.delete(g) : state.grades.add(g);
      renderChips(); renderTable();
    });
}

function gradeCount(g) {
  return filteredRaces().filter((r) => r.grade === g).length;
}

function renderTable() {
  const rows = visibleRows(filteredRaces());
  const CAP = 500;
  const shown = rows.slice(0, CAP);
  const tb = $("#tbl tbody");
  tb.innerHTML = shown.map(({ race: r, u }) => {
    const v = state.video[r.id];
    const videoCell = v
      ? (v.resolved
        ? `<a class="vt" href="${esc(v.url)}" target="_blank" title="${esc(v.title)}">▶ ${esc(v.title)}</a>`
        : `<span class="rg">未解析</span> <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(v.query)}" target="_blank">YT</a> <a href="https://x.com/search?q=${encodeURIComponent(v.query)}&f=live" target="_blank">X</a>`)
      : `<a href="#" data-v="${esc(r.id)}">▶ 解析</a> <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery(r))}" target="_blank" title="YouTube 检索">YT</a> <a href="https://x.com/search?q=${encodeURIComponent(ytQuery(r))}&f=live" target="_blank" title="X 检索">X</a>`;
    const diTag = u.di.line
      ? `<span class="di" title="${u.di.lineVia === "sire" ? "父 = Deep Impact" : "父父 = Deep Impact"}">直系</span>`
      : u.di.broodmare ? `<span class="di" title="母父 = Deep Impact">母父</span>` : "";
    const rankCell = u.rank != null
      ? `<span class="rk${u.rank <= 3 ? u.rank : ""}">${u.rank}</span>`
      : (u.finishRaw ? `<span class="rkr" title="非完走">${esc(u.finishRaw)}</span>` : `<span class="rkr">—</span>`);
    return `<tr${u.rank === 1 ? ` class="win"` : ""}>
      <td>${r.date}</td>
      <td><span class="rg ${esc(r.org ?? "")}">${esc(r.countryLabel)}${r.org ? "·" + r.org : ""}</span></td>
      <td><span class="g ${esc(r.grade)}">${esc(r.grade)}</span></td>
      <td><b>${esc(r.name)}</b></td>
      <td>${esc(r.venue)}${r.time ? ` <span class="rg">${esc(r.time)}</span>` : ""}</td>
      <td>${rankCell}</td>
      <td>${u.rank === 1 ? "🥇 " : ""}${esc(u.horseEn || u.horse)}${diTag}</td>
      <td>${esc(u.jockey)}</td>
      <td>${esc(u.trainer)}</td>
      <td>${esc(u.sire)}</td>
      <td>${esc(u.sireSire)}</td>
      <td>${esc(u.bms)}</td>
      <td>${videoCell}</td>
    </tr>`;
  }).join("");
  $("#cut").textContent = rows.length > CAP ? `共 ${rows.length} 匹，仅显示前 ${CAP} 行（继续筛选缩小范围）`
    : `共 ${rows.length} 匹`;
  tb.querySelectorAll("[data-v]").forEach((a) => a.onclick = (e) => { e.preventDefault(); resolveVideo(a.dataset.v); });
}

function ytQuery(r) {
  const y = r.date.slice(0, 4);
  return [r.name, y, r.region === "overseas" ? r.grade : null].filter(Boolean).join(" ");
}

// ---------- 视频 ----------
async function resolveVideo(raceId) {
  try {
    const res = await fetch(`/api/video?race=${encodeURIComponent(raceId)}`);
    state.video[raceId] = await res.json();
  } catch {
    state.video[raceId] = { resolved: false, query: ytQuery(state.data.races.find((r) => r.id === raceId) ?? {}) };
  }
  renderTable();
}

// ---------- 重新检索按钮 ----------
let pollTimer = null;
function pollStatus() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    let st;
    try { st = await (await fetch("/api/status")).json(); } catch { return; }
    $("#status").textContent = st.running
      ? `⏳ 检索中…（${st.startedAt?.slice(11, 19) ?? ""} 起）\n${tail(st.log, 3)}`
      : (st.startedAt ? (st.ok ? "✅ 检索完成" : "⚠️ 检索结束（有报错，看服务台日志）") : "");
    if (!st.running) {
      for (const id of ["btn-collect", "btn-backfill-jp", "btn-backfill-ov"]) $("#" + id).disabled = false;
      jobBusy = false;
      clearInterval(pollTimer);
      if (st.startedAt) { await loadData(); renderAll(); }
    }
  }, 2000);
}
const tail = (s, n) => String(s ?? "").trimEnd().split("\n").slice(-n).join("\n");

async function startCollect() {
  if (jobBusy) return;
  $("#btn-collect").disabled = true;
  jobBusy = true;
  try {
    const res = await fetch("/api/collect", { method: "POST" });
    const j = await res.json();
    if (!j.ok) { $("#status").textContent = "⚠️ " + (j.error ?? "启动失败"); $("#btn-collect").disabled = false; return; }
  } catch { /* 无 API 服务（纯静态打开）时不可用 */ }
  pollStatus();
}

// ---------- 控件 ----------
function renderTabs() {
  const tabs = [["all", "全部"], ["jra", "日本 JRA"], ["nar", "日本 NAR"], ["overseas", "海外"]];
  $("#tabs-region").innerHTML = tabs.map(([k, l]) =>
    `<button data-r="${k}" class="${state.region === k ? "on" : ""}">${l}</button>`).join("");
  $("#tabs-region").querySelectorAll("[data-r]").forEach((b) =>
    b.onclick = () => { state.region = b.dataset.r; renderTabs(); renderChips(); renderTable(); });

  const peds = [["all", "全部血统"], ["line", "DI 直系"], ["bms", "DI 母父"]];
  $("#tabs-ped").innerHTML = peds.map(([k, l]) =>
    `<button data-p="${k}" class="${state.ped === k ? "on" : ""}">${l}</button>`).join("");
  $("#tabs-ped").querySelectorAll("[data-p]").forEach((b) =>
    b.onclick = () => { state.ped = b.dataset.p; renderTabs(); renderTable(); });

  const ranks = [["all", "全部名次"], ["win", "1着"], ["top3", "1-3着"]];
  $("#tabs-rank").innerHTML = ranks.map(([k, l]) =>
    `<button data-k="${k}" class="${state.rank === k ? "on" : ""}">${l}</button>`).join("");
  $("#tabs-rank").querySelectorAll("[data-k]").forEach((b) =>
    b.onclick = () => { state.rank = b.dataset.k; renderTabs(); renderTable(); });
}

function renderAll() {
  const c = state.data?.counts;
  $("#stats").textContent = c
    ? `${c.races} 场重赏 · ${c.runners} 匹 · DI 直系 ${c.diLine} · DI 母父 ${c.diBms}（数据截至 ${state.data.generatedAt?.slice(0, 16).replace("T", " ")}）`
    : "";
  renderTabs(); renderChips(); renderTable();
}

$("#btn-collect").onclick = startCollect;
$("#q").oninput = (e) => { state.q = e.target.value; renderTable(); };

// 全年回填按钮：POST /api/backfill?year=&region=（与采集共用任务槽，轮询同一 /api/status）
async function startBackfill(region) {
  if (jobBusy) return;
  const year = state.year !== "all" ? state.year : (Object.keys(state.data?.years ?? {}).sort().pop() ?? new Date().getFullYear());
  for (const id of ["btn-collect", "btn-backfill-jp", "btn-backfill-ov"]) $("#" + id).disabled = true;
  jobBusy = true;
  try {
    const res = await fetch(`/api/backfill?year=${year}&region=${region}`, { method: "POST" });
    const j = await res.json();
    if (!j.ok) { $("#status").textContent = "⚠️ " + (j.error ?? "启动失败"); return; }
  } catch { /* 纯静态打开时不可用 */ }
  pollStatus();
}
let jobBusy = false;
$("#btn-backfill-jp").onclick = () => startBackfill("japan");
$("#btn-backfill-ov").onclick = () => startBackfill("overseas");

loadData().then(renderAll).catch((e) => {
  $("#status").textContent = "❌ " + e.message;
});
