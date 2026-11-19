// ============================================================
// 全球重赏收集 · 海外全年回填（探索分支 feat/global-graded）
// ============================================================
//
// 思路（与 racing-calendar 的卡片管线解耦，独立最小闭环）：
//   Sporting Life（RP 集团官方数据，开放无 WAF）的「日级结果页」自带
//   全天全部比赛：赛名含 (Group 1)/(Grade 2)（→ grade.mjs 正则判级）、
//   国家 short_name（→ config.mjs 13 国映射）。
//   命中 G1-3 的场次再取「单场结果页」：rides[] 自带着顺 + 骑手 + 调教师
//   + 马 id（1 请求/场）。
//   血统：SL 马匹 profile 给 sire/damsire 名字（儿子/母父判定够用；
//   父父因 SL 相对马 id 数据缺陷不可链查，海外历史侧「DI 孙子」不判 —— 宁缺勿错），
//   名字级缓存 data/pedigree/rp-horse.json（与 rp 采集器共用，跨跑零重复请求）。
//
// 产出：data/global-graded/sl/<date>.json（global.sl.day/v1）
//   races:[] 的空文档 = 「该日无重赏」负缓存，续跑免费跳过。
//
// 覆盖国家（SL 口径）：GB(ENG/Wale/SCO/Scot) IE(Eire) FR HK SA(SAF) AE(UAE) US(USA)
// 其余 6 国（AR/BR/CL/TR/AU/NZ）走各自采集器，见 backfill.mjs。
//
// 用法：
//   node src/global/overseas-backfill.mjs --year 2026                    # 全年
//   node src/global/overseas-backfill.mjs --from 2026-01-01 --to 2026-03-31
//   node src/global/overseas-backfill.mjs --year 2026 --no-ped           # 只要结果不要血统
//   node src/global/overseas-backfill.mjs --year 2026 --force            # 无视缓存重抓
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { get, nextData } from "../sources/http.js";
import { slugify } from "../lib/sl-result.mjs";
import { countryOf } from "./config.mjs";
import { gradeOf } from "./grade.mjs";
import { diFlags } from "./pedigree.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT_DIR = path.join(ROOT, "data", "global-graded", "sl");
const PED_CACHE = path.join(ROOT, "data", "pedigree", "rp-horse.json");
const SL = "https://www.sportinglife.com";

const argv = process.argv.slice(2);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const YEAR = parseInt(val("--year", String(new Date().getFullYear())), 10);
const FORCE = argv.includes("--force");
const NO_PED = argv.includes("--no-ped");
const DELAY = parseInt(val("--delay", "350"), 10);
const FROM = val("--from", `${YEAR}-01-01`);
const TO = val("--to", `${YEAR}-12-31`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SL country short_name → 本项目国家码（config.mjs match 表）
function slCountry(shortName) {
  return countryOf(shortName)?.code ?? null;
}

// ---------- 血统缓存（与 rp 采集器共用一个文件，格式 pedCache 兼容） ----------
// rp-horse.json 是 JSON Map 序列化（{"id": rec}），直接读写保持兼容。
let pedStore = null;
function pedGet(horseId) {
  pedStore ??= fs.existsSync(PED_CACHE) ? JSON.parse(fs.readFileSync(PED_CACHE, "utf8")) : {};
  return pedStore[horseId] ?? null;
}
function pedSet(horseId, rec) {
  pedStore[horseId] = rec;
}
let pedDirty = false;
setInterval(() => {
  if (pedDirty && pedStore) {
    fs.mkdirSync(path.dirname(PED_CACHE), { recursive: true });
    fs.writeFileSync(PED_CACHE, JSON.stringify(pedStore));
    pedDirty = false;
  }
}, 10_000).unref();
process.on("exit", () => {
  if (pedDirty && pedStore) {
    fs.mkdirSync(path.dirname(PED_CACHE), { recursive: true });
    try { fs.writeFileSync(PED_CACHE, JSON.stringify(pedStore)); } catch { /* 尽力落盘 */ }
  }
});

// 马匹 profile：{sire, damsire}（名字级；id 是 SL 数据缺陷不可用）
async function pedOf(horseId, { log = () => {} } = {}) {
  if (!horseId) return null;
  const cached = pedGet(horseId);
  if (cached && "sire" in cached) return cached;
  const r = await get(`${SL}/racing/profiles/horse/${horseId}`).catch(() => null);
  await sleep(DELAY);
  const j = r && r.status === 200 ? nextData(r.text) : null;
  const prof = j?.props?.pageProps?.profile;
  if (!prof) {
    pedSet(horseId, { miss: 1, at: new Date().toISOString() });
    pedDirty = true;
    return null;
  }
  const rec = {
    name: prof.name ?? null,
    sire: prof.sire?.name ?? null,
    damsire: prof.damsire?.name ?? null,
    foaled: prof.foaled ?? null,
    at: new Date().toISOString(),
  };
  pedSet(horseId, rec);
  pedDirty = true;
  log(`[ped] ${rec.name} ← ${rec.sire} / ${rec.damsire}`);
  return rec;
}

// ---------- 日期序列 ----------
function datesOf(year, from, to) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to > today ? today : to}T00:00:00Z`);
  while (d <= end) {
    if (d.getUTCFullYear() === year) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// ---------- 日级抓取 ----------
async function fetchDay(date, { log = () => {} } = {}) {
  const file = path.join(OUT_DIR, `${date}.json`);
  if (!FORCE && fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    return { date, cached: true, races: prev.races ?? [] };
  }

  const r = await get(`${SL}/racing/results/${date}`).catch((e) => {
    throw new Error(`day page: ${e.message}`);
  });
  await sleep(DELAY);
  if (r.status !== 200) throw new Error(`day page HTTP ${r.status}`);
  const j = nextData(r.text);
  const meetings = j?.props?.pageProps?.meetings ?? [];

  // 日级索引 → 级别过滤（赛名 Group/Grade 正则）
  const graded = [];
  for (const m of meetings) {
    for (const race of m.races ?? []) {
      const id = String(race?.race_summary_reference?.id ?? "");
      if (!/^\d+$/.test(id)) continue;
      const grade = gradeOf({ name: race.name, raceClass: race.race_class }, {});
      if (!grade) continue;
      graded.push({
        raceId: id,
        name: race.name ?? "",
        grade,
        country: race.country_short_name ?? m.meeting_summary?.course?.country?.short_name ?? null,
        course: race.course_name ?? null,
        trackId: m.meeting_summary?.course?.course_reference?.id ?? null,
        offTime: race.off_time ?? null,
        distance: race.distance ?? null,
        stage: race.race_stage ?? null,
        surface: race.course_surface?.surface ?? null,
      });
    }
  }

  if (graded.length === 0) {
    // 负缓存：无重赏日，占位即可续跑
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: "global.sl.day/v1", date, capturedAt: new Date().toISOString(), races: [] }));
    return { date, cached: false, races: [] };
  }

  // 命中重赏 → 逐场取全序结果
  for (const g of graded) {
    const url = `${SL}/racing/results/${date}/${slugify(g.course)}/${g.raceId}/x`;
    const rr = await get(url).catch(() => null);
    await sleep(DELAY);
    const rj = rr && rr.status === 200 ? nextData(rr.text) : null;
    const res = rj?.props?.pageProps?.race;
    if (!res?.rides) { log(`[warn] ${date} ${g.name} 结果页缺失`); continue; }
    g.winningTime = res.race_summary?.winning_time ?? null;
    g.runners = [];
    for (const ride of res.rides) {
      const nr = ride.ride_status === "NONRUNNER";
      const row = {
        num: ride.cloth_number ?? null,
        draw: ride.draw_number ?? null,
        finish: nr ? null : (typeof ride.finish_position === "number" && ride.finish_position > 0 ? ride.finish_position : null),
        status: nr ? "除" : null,
        horse: ride.horse?.name ?? null,
        horseId: ride.horse?.horse_reference?.id ?? null,
        jockey: ride.jockey?.name ?? null,
        trainer: ride.trainer?.name ?? null,
        or: ride.official_rating ?? null,
      };
      if (!NO_PED && row.horseId) {
        const ped = await pedOf(row.horseId, { log }).catch(() => null);
        if (ped && "sire" in ped) {
          row.sire = ped.sire;
          row.bms = ped.damsire;
          row.di = diFlags({ sire: { name: ped.sire }, sireSire: { name: null }, bms: { name: ped.damsire } });
        }
      } else {
        row.di = diFlags({});
      }
      g.runners.push(row);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema: "global.sl.day/v1",
    date,
    capturedAt: new Date().toISOString(),
    races: graded,
  }));
  log(`[day] ${date}: ${graded.length} 重赏（${graded.map((g) => g.grade).join(",")}）`);
  return { date, cached: false, races: graded };
}

// ---------- 主流程 ----------
async function main() {
  const dates = datesOf(YEAR, FROM, TO);
  console.log(`[sl-backfill] ${YEAR} 年海外（SL）：${dates.length} 天（${FROM} ~ ${TO}${FORCE ? "，force" : ""}）`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0, empty = 0, err = 0, races = 0;
  for (const date of dates) {
    try {
      const res = await fetchDay(date, { log: console.log });
      if (res.cached) { ok++; if (res.races.length) races += res.races.length; continue; }
      if (res.races.length === 0) empty++;
      else { ok++; races += res.races.length; }
    } catch (e) {
      err++;
      console.log(`[sl-backfill] !! ${date}: ${e.message}`);
    }
  }
  console.log(`[sl-backfill] done: 有重赏日 ${ok}（${races} 场）/ 无重赏日 ${empty} / 失败 ${err}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
