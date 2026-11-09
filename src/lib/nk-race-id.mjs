// netkeiba race_id 构造 / 反解 / 枚举口（docs/RESULTS.md §2.5c、§4.3）
// 地方 NAR：YYYY + jyo(2) + MM + DD + RR         例 202635110801 = 2026-11-08 盛岡 1R
// 中央 JRA：YYYY + jyo(2) + 回(2) + 日(2) + RR   例 202605041101 = 4回東京11日 1R
import { NK_JYO } from "../race-config.js";

const LOCAL_JYO = new Set(Object.values(NK_JYO));
const pad2 = (v) => String(v).padStart(2, "0");

// 中央 JBIS 场码 101-110 → netkeiba 场码 01-10（实测 105 東京→05、108 京都→08）
export function centralJyo(track) {
  const t = Number(track);
  return t >= 101 && t <= 110 ? pad2(t - 100) : null;
}

export function isLocalRaceId(id) {
  return LOCAL_JYO.has(String(id).slice(4, 6));
}
export const scopeOfRaceId = (id) => (isLocalRaceId(id) ? "local" : "central");

// 枚举口返回的 id 按「场码 + R」建索引，与本地 date × track × no 对齐
export const listKeyOfRaceId = (id) => {
  const s = String(id);
  return `${s.slice(4, 6)}:${s.slice(10, 12)}`;
};
export function expectedListKey(track, no) {
  const rr = pad2(no);
  if (NK_JYO[track]) return `${NK_JYO[track]}:${rr}`;
  const c = centralJyo(track);
  return c ? `${c}:${rr}` : null;
}

// 0 请求构造：地方直接可构；中央需调用方提供「回 / 日」（否则返回 null，走枚举口）
export function raceIdOf(date, track, no, { kaisai, day } = {}) {
  const ymd = date.replace(/-/g, "");
  const y = ymd.slice(0, 4);
  const md = ymd.slice(4, 8);
  const rr = pad2(no);
  if (NK_JYO[track]) return `${y}${NK_JYO[track]}${md}${rr}`;
  const c = centralJyo(track);
  if (c && kaisai != null && day != null) return `${y}${c}${pad2(kaisai)}${pad2(day)}${rr}`;
  return null;
}

export function parseRaceId(id) {
  const s = String(id ?? "");
  if (!/^\d{12}$/.test(s)) return null;
  const scope = scopeOfRaceId(s);
  return {
    id: s,
    scope,
    year: Number(s.slice(0, 4)),
    jyo: s.slice(4, 6),
    kaisaiOrMonth: Number(s.slice(6, 8)),
    dayOrDate: Number(s.slice(8, 10)),
    no: Number(s.slice(10, 12)),
  };
}

export const raceListUrl = (date) => `https://db.netkeiba.com/race/list/${date.replace(/-/g, "")}/`;

// 枚举口：/race/list/{yyyymmdd}/ 一次给当天全部 race_id（含中央）
export function parseRaceList(html) {
  const ids = new Set();
  const s = String(html ?? "");
  for (const m of s.matchAll(/\/race\/(\d{12})\/?/g)) ids.add(m[1]);
  for (const m of s.matchAll(/race_id=(\d{12})/g)) ids.add(m[1]);
  return [...ids];
}

// 赛前出馬表 / 赛后结果页：同一个 race_id 贯穿，赛前关联一次即可复用
export function shutubaUrlOf(id) {
  const base = isLocalRaceId(id) ? "nar.netkeiba.com" : "race.netkeiba.com";
  return `https://${base}/race/shutuba.html?race_id=${id}`;
}
// 中央优先 race.* 的「結果・払戻」页（All_Result_Table，UTF-8，当天即有）；
// db.* /race/{id}/ 是 25 列 race_table_01（EUC-JP），作为无结果表时的回退。
export function resultUrlOf(id) {
  return isLocalRaceId(id)
    ? `https://nar.netkeiba.com/race/result.html?race_id=${id}`
    : `https://race.netkeiba.com/race/result.html?race_id=${id}&rf=race_list`;
}
export function legacyResultUrlOf(id) {
  return isLocalRaceId(id) ? null : `https://db.netkeiba.com/race/${id}/`;
}
