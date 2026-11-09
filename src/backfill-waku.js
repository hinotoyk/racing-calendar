// 枠順/馬番 轻量补采（docs/DESIGN.md §11 · 北京 12:00 补采档）
//
// 职责只有两件（其余一律不碰）：
//   ① 整表缺失：02:00 全量档跑的时候出馬表还没公开 → 文档是空壳（races 有、runners 空）。
//      抓 1 次出馬表页建整表；马名/血统/彩衣全部从 data/pedigree 缓存挂，0 额外请求。
//   ② 有表但缺 枠番/馬番：先在本地解决（data/results 的终态号 + 馬番→枠番 推导），仍缺才抓 1 次。
//
// 与 collect-races.js（全量档）的区别：
//   不跑赛历、不解析当日页、不抓马页/血统/彩衣（这些由全量档负责），不重建已有文档；
//   已完整场次 0 请求；已完赛场次 0 请求（号从 data/results 取）。
//
// 用法：node src/backfill-waku.js [--days 2] [--dates 2026-11-10,...] [--tracks 210,221]
//                                [--delay 1200] [--dry] [--limit 40]
import fs from "node:fs";
import path from "node:path";
import { SITE } from "./config.js";
import { fetchHtmlSoft } from "./lib/fetch.js";
import { readGz, writeGz } from "./lib/bundle.js";
import { parseEntryPage } from "./lib/parse-race.js";
import { applyHorseName, jbisNameOf } from "./lib/jbis-name.js";
import { cachedOwnerSilk } from "./lib/silks.js";
import { wfSilkOf } from "./lib/winfinal.js";
import { pedCache } from "./lib/ped-cache.js";
import { venueName, scopeOf } from "./race-config.js";

const DATA_DIR = path.resolve("data", "races");
const RESULTS_DIR = path.resolve("data", "results");
const PED_DIR = path.resolve("data", "pedigree");
const MANIFEST = path.join(DATA_DIR, "manifest.json");

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
// 含今天共 N 天：默认「今天 + 明天」两天（再往后的日期由每晚 02:00 全量档负责）
const DAYS = parseInt(argOf("--days") ?? "2", 10);
const DATE_ARG = argOf("--dates");
const TRACK_ARG = argOf("--tracks");
const DELAY = parseInt(argOf("--delay") ?? String(SITE.delayMs), 10);
const LIMIT = parseInt(argOf("--limit") ?? "0", 10);
const DRY = argv.includes("--dry");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (date) => date.replace(/-/g, "");
const at = (date) => `${date}T00:00:00+09:00`;

function jstToday() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const TODAY = jstToday();
const DATES = DATE_ARG ? DATE_ARG.split(",").map((s) => s.trim()).filter(Boolean) : Array.from({ length: DAYS }, (_, i) => addDays(TODAY, i));

// ---------- 本地数据源 ①：已完赛的终态 馬番/枠番 ----------
// data/results/{date}/{track}.json 的 runner 带 num+frame（含取消马），比出馬表更权威。
// 12:00 补采时当天上午的场次已经跑完，直接取本地值 → 0 请求。
const resultsCache = new Map();
function resultsOf(date, track) {
  const key = `${date}/${track}`;
  if (resultsCache.has(key)) return resultsCache.get(key);
  let map = null;
  const file = path.join(RESULTS_DIR, date, `${track}.json`);
  if (fs.existsSync(file)) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      map = new Map();
      for (const race of doc.races ?? []) {
        for (const r of race.runners ?? []) {
          const id = r.horse?.id;
          if (!id || (r.num == null && r.frame == null)) continue;
          if (!map.has(id)) map.set(id, { num: r.num ?? null, frame: r.frame ?? null });
        }
      }
    } catch {
      map = null;
    }
  }
  resultsCache.set(key, map);
  return map;
}

// ---------- 本地数据源 ②：馬番 → 枠番 推导 ----------
// 枠番是馬番 + 出走頭数的函数（1..8 枠，超出 8 头时从 8 枠往前每枠 2 头，17 头以上再往前每枠 3 头）。
// 已用全库 22 天 1,080 个「馬番连续」场次校验：中央 192 场 / 地方 888 场，0 例不符。
function framesFor(heads) {
  if (heads < 1 || heads > 18) return null;
  const counts = new Array(8).fill(0);
  for (let i = 0; i < Math.min(heads, 8); i++) counts[i] = 1;
  let extra = heads - 8;
  for (let f = 7; f >= 0 && extra > 0; f--, extra--) counts[f]++;
  for (let f = 7; f >= 0 && extra > 0; f--, extra--) counts[f]++;
  const out = [];
  for (let f = 0; f < 8; f++) for (let k = 0; k < counts[f]; k++) out.push(f + 1);
  return out;
}

// 只在能确定「枠表对得上」时推导：馬番必须 1..N 连续、且与当日页头数一致（有取消/欠番就放弃）
function deriveFrames(race) {
  const rs = (race.runners ?? []).filter((x) => x.num != null).sort((a, b) => a.num - b.num);
  const heads = rs.length;
  if (!heads || heads > 18) return 0;
  if (race.heads && race.heads !== heads) return 0;
  if (!rs.every((x, i) => x.num === i + 1)) return 0;
  const table = framesFor(heads);
  if (!table) return 0;
  let filled = 0;
  rs.forEach((x, i) => {
    if (x.frame == null) {
      x.frame = table[i];
      filled++;
    }
  });
  return filled;
}

// ---------- 本地数据源 ③：马名 / 父父 / 彩衣 缓存（0 请求） ----------
const sireStore = pedCache(path.join(PED_DIR, "jbis-sire.json"));

// 整表重建时才需要：出馬表页只给日文名 + 父/母/母父，缺英文名、父父、彩衣
function enrichFromCache(runners, date) {
  const year = parseInt(date.slice(0, 4), 10);
  const s = { names: 0, sireSire: 0, silk: 0, silkMiss: 0 };
  for (const r of runners) {
    const nameRec = jbisNameOf(r.horse?.id);
    if (nameRec && applyHorseName(r, nameRec)) s.names++;

    if (!r.sireSire && r.sire?.id) {
      const rec = sireStore.get(r.sire.id);
      if (rec?.sire) {
        r.sireSire = rec.sire;
        s.sireSire++;
      }
    }

    if (r.silk) continue;
    const byOwner = cachedOwnerSilk(r.owner);
    if (byOwner?.colours && fs.existsSync(path.resolve(byOwner.colours))) {
      r.silk = { url: byOwner.colours, owner: byOwner.owner ?? null, via: "cache" };
      s.silk++;
      continue;
    }
    const name = r.horse?.nameJp ?? r.horse?.name;
    const birthYear = r.horse?.foaled
      ? parseInt(r.horse.foaled.slice(0, 4), 10)
      : r.age != null
        ? year - r.age
        : null;
    const wf = wfSilkOf(name, birthYear);
    if (wf?.colours && fs.existsSync(path.resolve(wf.colours))) {
      r.silk = { url: wf.colours, owner: wf.owner ?? null, via: "winfinal" };
      s.silk++;
      continue;
    }
    s.silkMiss++;
  }
  return s;
}

// 按馬 id 回填：只填空字段，绝不覆盖已有值；人马变动（取消/追加）交给全量档
function mergeWaku(race, parsed) {
  const byId = new Map((race.runners ?? []).map((x) => [x.horse?.id, x]));
  let horses = 0;
  let seats = 0;
  for (const p of parsed.runners) {
    const x = byId.get(p.horse?.id);
    if (!x) continue;
    let hit = false;
    if (x.num == null && p.num != null) {
      x.num = p.num;
      hit = true;
      seats++;
    }
    if (x.frame == null && p.frame != null) {
      x.frame = p.frame;
      hit = true;
      seats++;
    }
    if (hit) horses++;
  }
  return { horses, seats };
}

// 整表写入：空壳 → 完整出馬表（含缓存补的马名/父父/彩衣）
function fillTable(race, parsed, date) {
  race.runners = parsed.runners;
  race.heads = parsed.runners.length || race.heads;
  race.status = "entries";
  const s = enrichFromCache(race.runners, date);
  return { horses: parsed.runners.length, seats: parsed.runners.length * 2, cache: s };
}

async function fetchEntry(date, track, no) {
  const rr = String(no).padStart(2, "0");
  for (const p of ["race", "race/result"]) {
    const url = `https://www.jbis.or.jp/${p}/${ymd(date)}/${track}/${rr}/`;
    const html = await fetchHtmlSoft(url);
    stats.requests++;
    await sleep(DELAY);
    if (!html) continue;
    // 出馬表页没有 runners（未公开/已转结果页）→ 才走 /race/result/ 兜底
    const parsed = parseEntryPage(html);
    if (parsed?.runners?.length) return parsed;
  }
  return null;
}

const stats = {
  requests: 0,
  changedRaces: 0,
  horses: 0,
  seats: 0,
  errors: 0,
  tables: 0,
  fromResults: 0,
  derived: 0,
  skipped: 0,
  touched: [],
};
const t0 = Date.now();

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
} catch {
  manifest = null;
}
let manifestDirty = false;

for (const date of DATES) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) {
    console.log(`[skip] ${date}: 无已采数据（新日期由全量档创建）`);
    continue;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json.gz"))
    .filter((f) => (TRACK_ARG ? TRACK_ARG.split(",").includes(f.replace(/\.json\.gz$/, "")) : true));

  for (const f of files) {
    const track = f.replace(/\.json\.gz$/, "");
    const file = path.join(dir, f);
    let doc;
    try {
      doc = JSON.parse(readGz(file));
    } catch (err) {
      console.log(`[err]  ${date} ${track}: 读取失败 ${err.message}`);
      stats.errors++;
      continue;
    }
    // 海外场次没有「枠」概念（frame 恒空），不参与补采
    if (doc.scope === "overseas") continue;

    const res = resultsOf(date, track);
    let touched = false;
    let wholeTable = 0;

    for (const race of doc.races ?? []) {
      if (race.status !== "entries") continue;

      // ① 本地先解决：results 终态号 → 枠番推导
      if (race.runners?.length) {
        if (res) {
          for (const x of race.runners) {
            const hit = res.get(x.horse?.id);
            if (!hit) continue;
            if (x.num == null && hit.num != null) {
              x.num = hit.num;
              stats.fromResults++;
              touched = true;
            }
            if (x.frame == null && hit.frame != null) {
              x.frame = hit.frame;
              stats.fromResults++;
              touched = true;
            }
          }
        }
        const d = deriveFrames(race);
        if (d) {
          stats.derived += d;
          touched = true;
        }
      }

      const missing = !race.runners?.length || race.runners.some((x) => x.num == null || x.frame == null);
      if (!missing) {
        if (race.runners?.length) stats.skipped++;
        continue;
      }
      if (LIMIT && stats.requests >= LIMIT) continue;

      let parsed = null;
      try {
        parsed = await fetchEntry(date, track, race.no);
      } catch (err) {
        stats.errors++;
        console.log(`[err]  ${date} ${track} ${race.no}R: ${err.message}`);
        continue;
      }
      if (!parsed) {
        console.log(`[soft] ${date} ${track} ${race.no}R: 出馬表未公开/无枠列（可用本地数据已补）`);
        continue;
      }

      if (!race.runners?.length) {
        const r = fillTable(race, parsed, date);
        wholeTable++;
        stats.tables++;
        stats.horses += r.horses;
        stats.seats += r.seats;
        stats.changedRaces++;
        touched = true;
        console.log(
          `[table] ${date} ${track} ${race.no}R ${race.name ?? ""}: ${r.horses} 頭` +
            `（马名+${r.cache.names} 父父+${r.cache.sireSire} 彩衣+${r.cache.silk}/缺${r.cache.silkMiss}）`
        );
      } else {
        const r = mergeWaku(race, parsed);
        if (r.horses) {
          stats.horses += r.horses;
          stats.seats += r.seats;
          stats.changedRaces++;
          touched = true;
          console.log(`[waku] ${date} ${track} ${race.no}R ${race.name ?? ""}: 枠/馬番 +${r.seats}（${r.horses} 頭）`);
        } else {
          console.log(`[same] ${date} ${track} ${race.no}R: 源站仍未给出枠番/馬番`);
        }
      }
    }

    if (!touched) continue;
    // capturedAt 只在整表重建时更新（等价于重采）；只补号的场次记 wakuAt，避免「抓取时间」口径失真
    doc.wakuAt = at(TODAY);
    if (wholeTable) doc.capturedAt = at(TODAY);
    if (!DRY) {
      writeGz(file, JSON.stringify(doc));
      stats.touched.push(`${date}/${track}`);
      if (manifest?.dates?.[date]) {
        const runners = (doc.races ?? []).reduce((n, r) => n + (r.runners?.length ?? 0), 0);
        const decoded = (doc.races ?? []).filter((r) => r.status === "entries").length;
        manifest.dates[date][track] = {
          venue: doc.venue ?? venueName(track),
          scope: doc.scope ?? scopeOf(track),
          races: (doc.races ?? []).length,
          decoded,
          runners,
          status: runners ? "ok" : "pending",
          capturedAt: doc.capturedAt ?? at(TODAY),
        };
        manifestDirty = true;
      }
    } else {
      stats.touched.push(`${date}/${track}(dry)`);
    }
  }
}

if (manifestDirty && manifest) {
  manifest.updatedAt = at(TODAY);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}

const sec = Math.round((Date.now() - t0) / 1000);
console.log(
  `waku -> changed=${stats.changedRaces} requests=${stats.requests} horses=${stats.horses} seats=${stats.seats} ` +
    `errors=${stats.errors} ${sec}s${DRY ? " (dry)" : ""}` +
    ` | tables=${stats.tables} from results=${stats.fromResults} derived=${stats.derived} already-complete=${stats.skipped}` +
    (stats.touched.length ? ` | ${stats.touched.join(", ")}` : "")
);

// 全部请求都失败才算异常（偶发 soft/未公开不算）
if (stats.requests > 0 && stats.errors === stats.requests) process.exit(1);
