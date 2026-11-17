// Club Hípico de Santiago 赛果采集（智利）：官方 JSON API → data/results/{date}/tk-{track}.json
//
// ## 为什么需要它（2026-11-17 实测）
// Teletrak 的 volante 只发出馬表，站点本身没有赛果页；但智利 CHS 官方站点有一段未公开文档的
// JSON 接口，赛后直接给全场名次与派彩：
//   GET https://apiweb.clubhipico.cl/resultados/{YYYY-MM-DD}
//   → [{ numero_evento, id_carrera, tc_codigo_carrera, numero_mandil, posicion, dividendo,
//        tiempo, distanciamiento_string, peso_caballo, nombre_jinete, ejemplar:{nombre,...} }, …]
// 同一场次的行用 (numero_evento, id_carrera, tc_codigo_carrera) 三元组唯一确定（实测：
// 三元组内马号不重复、名次 1..N 连续）；只靠 numero_evento 会把「同日分组赛」并成一场。
// 非赛日接口返回 `[]`。接口只覆盖 CHS（hipodromo="C"），CHC/VSC/HCH 没有对应公开赛果。
//
// ## raceKey 对齐
// 官方接口里没有我们卡片的 raceKey（卡片 `tk-{track}-{no}` 来自 volante 解析顺序），
// 因此按「同场马名集合重叠」把结果分组配到卡片场次（贪心一对一，命中 ≥3 才认），
// 再按马名把行号落到卡片 runner.num（马名缺失时回落 mandil）。宁缺勿错：配不上就不写。
//
// ## 人气
// 接口只给单胜派彩（dividendo，等价十进制赔率），不给人气栏 → winOdds 落盘，
// 人气由 build 阶段按同场赔率升序派生（src/build.js · resultsOf）。
//
// ## 用法
//   node src/collect-results-chs.js --days 7            # 回补过去一周（默认）
//   node src/collect-results-chs.js --dates 2026-11-16
//   node src/collect-results-chs.js --dry
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { BROWSER_UA } from "./lib/fetch.js";

export const id = "chs-results";

const API = "https://apiweb.clubhipico.cl";
const TZ = "America/Santiago";
const DATA_DIR = path.resolve("data", "races");
const RESULTS_DIR = path.resolve("data", "results");

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DRY = has("--dry");
const FORCE = has("--force");
const DAYS = parseInt(val("--days", "7"), 10);
const DELAY = parseInt(val("--delay", "1200"), 10);
const DATES = (val("--dates", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");

function todayInTz() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const targets = DATES.length
  ? DATES
  : Array.from({ length: DAYS }, (_, i) => addDays(todayInTz(), -i)).reverse();

const numOf = (v) => {
  const n = String(v ?? "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return n ? Number(n[0]) : null;
};
const normName = (s) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// ---------- 抓取 ----------
async function fetchDay(dateIso) {
  const url = `${API}/resultados/${dateIso}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const txt = await res.text();
      if (!txt.trim()) return [];
      const arr = JSON.parse(txt);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      if (i === 2) {
        console.warn(`[api] ${dateIso} → ${e.message}`);
        return null;
      }
      await sleep(1500);
    }
  }
  return null;
}

// ---------- 本地卡片 ----------
function cardsOf(dateIso) {
  const dir = path.join(DATA_DIR, dateIso);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^tk-.*\.json(\.gz)?$/.test(f)) continue;
    let doc;
    try {
      const p = path.join(dir, f);
      const raw = f.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(p)) : fs.readFileSync(p);
      doc = JSON.parse(String(raw));
    } catch {
      continue;
    }
    if (!doc?.races?.length) continue;
    if (doc.country && doc.country !== "CHI") continue;
    out.push({ file: f, doc });
  }
  return out;
}

// ---------- 结果分组 ----------
/** API 行 → 场次分组（三元组唯一确定一场） */
export function groupRows(rows) {
  const g = new Map();
  for (const x of rows ?? []) {
    const no = numOf(x.numero_evento);
    const pos = numOf(x.posicion);
    const mandil = numOf(x.numero_mandil);
    if (no == null || pos == null || mandil == null) continue;
    const key = `${no}|${x.id_carrera ?? "-"}|${x.tc_codigo_carrera ?? "-"}`;
    if (!g.has(key)) g.set(key, []);
    const list = g.get(key);
    if (list.some((r) => r.mandil === mandil)) continue; // 同组同号重复行（源站偶发）→ 取首行
    list.push({
      mandil,
      pos,
      name: x.ejemplar?.nombre ?? null,
      time: x.tiempo ?? null,
      gap: x.distanciamiento_string ?? null,
      odds: numOf(x.dividendo),
      body: numOf(x.peso_caballo),
      jockey: x.nombre_jinete ?? null,
      distance: numOf(x.distancia),
    });
  }
  for (const list of g.values()) list.sort((a, b) => a.pos - b.pos);
  return [...g.values()].filter((l) => l.length >= 2);
}

/** 分组 → 卡片场次：按马名集合重叠贪心一对一 */
export function matchGroupsToRaces(groups, races) {
  const raceNames = races.map((r) => {
    const set = new Set();
    for (const h of r.runners ?? []) {
      const n = normName(h.horse?.name ?? h.name);
      if (n) set.add(n);
    }
    return set;
  });
  const pairs = [];
  groups.forEach((rows, gi) => {
    const names = rows.map((r) => normName(r.name)).filter(Boolean);
    raceNames.forEach((set, ri) => {
      if (!set.size) return;
      let hit = 0;
      for (const n of names) if (set.has(n)) hit++;
      if (hit >= 3) pairs.push({ gi, ri, hit });
    });
  });
  pairs.sort((a, b) => b.hit - a.hit);
  const usedG = new Set();
  const usedR = new Set();
  const out = [];
  for (const p of pairs) {
    if (usedG.has(p.gi) || usedR.has(p.ri)) continue;
    usedG.add(p.gi);
    usedR.add(p.ri);
    out.push(p);
  }
  return out;
}

/** 一场结果 → race.result/v1 的 race 对象（行号按马名落到卡片 runner） */
function raceOfResult(rows, cardRace) {
  const byName = new Map();
  const nums = new Set();
  for (const h of cardRace.runners ?? []) {
    const n = normName(h.horse?.name ?? h.name);
    if (n && !byName.has(n)) byName.set(n, h.num);
    if (h.num != null) nums.add(h.num);
  }
  const runners = [];
  const seen = new Set();
  for (const r of rows) {
    const n = normName(r.name);
    const num = byName.get(n) ?? (nums.has(r.mandil) ? r.mandil : null);
    if (num == null || seen.has(num)) continue;
    seen.add(num);
    runners.push({
      num,
      finish: r.pos,
      horse: { name: r.name },
      time: r.pos === 1 ? r.time ?? null : null,
      margin: r.pos === 1 ? null : r.gap ?? null,
      winOdds: r.odds,
      pop: null,
      last3f: null,
      bodyWeight: r.body,
      jockey: r.jockey,
    });
  }
  if (!runners.length) return null;
  runners.sort((a, b) => a.finish - b.finish);
  return {
    no: cardRace.no,
    raceKey: cardRace.raceKey,
    status: "result",
    resultHeads: runners.length,
    heads: cardRace.runners?.length ?? runners.length,
    joined: runners.length,
    linked: runners.length,
    startTime: cardRace.startTime ?? null,
    timeOfficial: runners.find((r) => r.finish === 1)?.time ?? null,
    runners,
  };
}

async function main() {
  let written = 0;
  for (const date of targets) {
    const cards = cardsOf(date);
    if (!cards.length) {
      console.log(`[skip] ${date} 无本地智利卡片`);
      continue;
    }
    const rows = await fetchDay(date);
    await sleep(DELAY);
    if (rows == null) {
      console.log(`[skip] ${date} 接口抓取失败`);
      continue;
    }
    if (!rows.length) {
      console.log(`[skip] ${date} 接口无数据（非 CHS 赛日）`);
      continue;
    }
    const groups = groupRows(rows);
    for (const { file, doc } of cards) {
      const pairs = matchGroupsToRaces(groups, doc.races);
      if (!pairs.length) continue;
      const races = [];
      for (const p of pairs) {
        const race = raceOfResult(groups[p.gi], doc.races[p.ri]);
        if (race) races.push(race);
      }
      if (!races.length) continue;
      races.sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
      const total = races.reduce((n, r) => n + r.runners.length, 0);
      const outFile = path.join(RESULTS_DIR, date, `${doc.track}.json`);
      const docOut = {
        schema: "jbis.race.result/v1",
        date,
        track: doc.track,
        venue: doc.venue,
        scope: "overseas",
        source: "clubhipico",
        sourceUrl: `${API}/resultados/${date}`,
        updatedAt: new Date().toISOString(),
        races,
      };
      if (DRY) {
        console.log(`[dry]  ${date} ${doc.venue} → ${races.length}/${doc.races.length} 场 / 着顺 ${total} 行`);
        continue;
      }
      const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
      if (prev && !FORCE) {
        const before = prev.races?.reduce((n, r) => n + (r.runners?.length ?? 0), 0) ?? 0;
        if (before >= total) {
          console.log(`[same] ${date} ${doc.venue} 已有 ${before} 行 ≥ 本次 ${total} → 跳过`);
          continue;
        }
      }
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(docOut, null, 1));
      console.log(`[ok]   ${date} ${doc.venue} → results/${doc.track}.json（${races.length}/${doc.races.length} 场 / 着顺 ${total} 行）`);
      written++;
    }
  }
  console.log(`== 完成：写入 ${written} 篇（目标日 ${targets.join(",")}）`);
}

if (!process.env.CHS_LIB_ONLY) main().catch((e) => { console.error(e); process.exit(1); });
