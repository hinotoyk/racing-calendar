// netkeiba 出馬表 / 结果页解析（docs/RESULTS.md §4.4；2026-11-09 修正 JRA 结果页）
// 三套模板：
//  1) All_Result_Table（表头驱动）：nar.* result.html（NAR，14 列）、
//     race.* result.html?race_id=（JRA，15 列，多「コーナー通過順」）→ parseAllResultTable
//  2) table.race_table_01（td 顺序，25 列）：db.* /race/{id}/，EUC-JP → parseJra（fallback）
// 归一出口：{ runners: [{ finish, frame, num, name, nkId, time, margin, passing,
//                        last3f, pop, winOdds, bodyWeight, bodyDelta, jockey, trainer, abnormal }] }
import { nkNameKey } from "./parse-netkeiba.js";

const strip = (s) =>
  String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const first = (s, re) => {
  const m = String(s ?? "").match(re);
  return m ? m[1] : null;
};
const toNum = (s) => {
  const v = parseFloat(String(s ?? "").replace(/,/g, "").replace(/[^\d.\-+]/g, ""));
  return Number.isFinite(v) ? v : null;
};
const orNull = (s) => strip(s) || null;

// 着顺：数字名次，或异常态单字 除/中/失/取/止（与 docs/RESULTS.md §4.2 口径一致）
const finishOf = (s) => {
  const t = strip(s);
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const ab = t.match(/[除中止取失]/);
  return ab ? ab[0] : null;
};
const bodyOf = (s) => {
  const t = strip(s);
  return {
    bodyWeight: toNum(first(t, /^(\d+)/)),
    bodyDelta: toNum(first(t, /\(([+-]?\d+)\)/)),
  };
};

// ---------- 赛前出馬表：归一马名 → nkId ----------
// 兼容 NAR 的 id="umalink_{id}" 与 JRA 的 href=".../horse/{id}"（JRA 无 umalink_）
export function parseNkShutubaMap(html) {
  const map = new Map();
  for (const m of String(html ?? "").matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1];
    const nkId = first(attrs, /umalink_(\d+)/) ?? first(attrs, /\/horse\/(\d{8,12})/);
    if (!nkId) continue;
    const raw = first(attrs, /title="([^"]*)"/) ?? strip(m[2]);
    const name = nkNameKey(raw);
    if (name && !map.has(name)) map.set(name, nkId);
  }
  return map;
}

// ---------- All_Result_Table：NAR / JRA 共用（按表头名定位列，避免两套 class 差异） ----------
const HEAD_MAP = new Map([
  ["着順", "finish"], ["枠", "frame"], ["馬番", "num"], ["馬名", "name"],
  ["性齢", "sexage"], ["斤量", "weight"], ["騎手", "jockey"], ["タイム", "time"],
  ["着差", "margin"], ["人気", "pop"], ["単勝オッズ", "winOdds"], ["後3F", "last3f"],
  ["コーナー通過順", "passing"], ["厩舎", "trainer"], ["馬体重(増減)", "body"],
]);
function parseAllResultTable(html) {
  const at = html.indexOf('id="All_Result_Table"');
  if (at < 0) return null;
  const table = html.slice(at, at + 200000);
  const trs = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  let cols = null;
  for (const tr of trs.slice(0, 3)) {
    const ths = [...tr.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => strip(x[1]).replace(/\s+/g, ""));
    if (ths.length >= 10) {
      cols = ths.map((t) => HEAD_MAP.get(t) ?? null);
      break;
    }
  }
  if (!cols) return null;
  const idx = (f) => cols.indexOf(f);
  const runners = [];
  for (const tr of trs) {
    const tds = [...tr.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((x) => ({ a: x[1], h: x[2] }));
    if (tds.length < 10) continue;
    const cell = (f) => strip(tds[idx(f)]?.h ?? "");
    const finish = finishOf(tds[idx("finish")]?.h ?? "");
    if (finish == null) continue;
    const horseTd = tds[idx("name")]?.h ?? "";
    const detail = cell("sexage");
    const trainerTd = tds[idx("trainer")]?.h ?? "";
    runners.push({
      finish,
      frame: toNum(cell("frame")),
      num: toNum(cell("num")),
      name: orNull(first(horseTd, /title="([^"]*)"/) ?? strip(horseTd)),
      nkId: first(horseTd, /umalink_(\d+)/) ?? first(horseTd, /\/horse\/(\d+)/),
      sex: orNull(first(detail, /([牝牡騸セセン])/)),
      age: toNum(first(detail, /(\d+)/)),
      weight: toNum(cell("weight")),
      jockey: orNull(cell("jockey")),
      time: orNull(cell("time")),
      margin: orNull(cell("margin")),
      passing: idx("passing") >= 0 ? orNull(cell("passing")) : null,
      last3f: toNum(cell("last3f")),
      pop: toNum(cell("pop")),
      winOdds: toNum(cell("winOdds")),
      ...bodyOf(cell("body")),
      trainer: orNull(first(trainerTd, /title="([^"]*)"/) ?? strip(trainerTd)),
      abnormal: typeof finish === "string" ? finish : null,
    });
  }
  return runners.length ? runners : null;
}

// ---------- db.* /race/{id}/ 的 race_table_01（td 顺序，共 25 列） ----------
function parseJra(html) {
  const at = html.indexOf('class="race_table_01');
  if (at < 0) return null;
  const table = html.slice(at, at + 200000);
  const runners = [];
  for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tr = m[1];
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1]));
    if (cells.length < 20) continue; // 结果表固定 25 列，払戻/其它表不误入
    const finish = finishOf(cells[0]);
    if (finish == null) continue;
    const trainer = (cells[22] ?? "").replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, "");
    runners.push({
      finish,
      frame: toNum(cells[1]),
      num: toNum(cells[2]),
      name: orNull(cells[3]),
      nkId: first(tr, /\/horse\/(\d{8,12})/) ?? first(tr, /umalink_(\d+)/),
      sex: first(cells[4], /([牝牡騸セ])/) ?? null,
      age: toNum(first(cells[4], /(\d+)/)),
      weight: toNum(cells[5]),
      jockey: orNull(cells[6]),
      time: orNull(cells[7]),
      margin: orNull(cells[8]),
      passing: orNull(cells[14]),
      last3f: toNum(cells[15]),
      winOdds: toNum(cells[16]),
      pop: toNum(cells[17]),
      ...bodyOf(cells[18]),
      trainer: orNull(trainer),
      abnormal: typeof finish === "string" ? finish : null,
    });
  }
  return runners.length ? runners : null;
}

// 按页面实际模板自动分派（不再按 scope 猜）；赛前 / 未生成结果返回 null → 调用方按软空计数
export function parseNkResult(html, scope) {
  if (!html || html.length < 500) return null;
  const all = parseAllResultTable(html);
  if (all) return { scope, runners: all, template: "All_Result_Table" };
  const jra = parseJra(html);
  if (jra) return { scope, runners: jra, template: "race_table_01" };
  return null;
}
