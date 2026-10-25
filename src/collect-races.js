// 出走表采集（docs/DESIGN.md §4）
// 赛历 → 当日页 → 出馬表 → 血统补全（父父 / 母父），按 日 × 场 落盘
import fs from "node:fs";
import path from "node:path";
import { SITE } from "./config.js";
import { fetchHtml, fetchHtmlSoft } from "./lib/fetch.js";
import { readGz, writeGz } from "./lib/bundle.js";
import { pedCache } from "./lib/ped-cache.js";
import { parseCalendar, parseDayPage, parseEntryPage, parsePedigree } from "./lib/parse-race.js";
import { venueName, scopeOf } from "./race-config.js";

const DATA_DIR = path.resolve("data", "races");
const PED_DIR = path.resolve("data", "pedigree");
const CAL_DIR = path.join(DATA_DIR, "_calendar");
const DELAY_MS = SITE.delayMs; // 礼貌抓取间隔

// ---------- CLI ----------
const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const FORCE = argv.includes("--force");
const DAYS = parseInt(argOf("--days") ?? String(SITE.days), 10);
const LIMIT = parseInt(argOf("--limit") ?? "0", 10);
const DATE_ARG = argOf("--dates");
const TRACK_ARG = argOf("--tracks");

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

const DATES = DATE_ARG
  ? DATE_ARG.split(",").map((s) => s.trim()).filter(Boolean)
  : Array.from({ length: DAYS + 1 }, (_, i) => addDays(jstToday(), i));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (date) => date.replace(/-/g, "");
const at = (date) => `${date}T00:00:00+09:00`;

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(file.endsWith(".gz") ? readGz(file) : fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 当日文档读取：优先压缩版（.json.gz），兼容旧明文（.json）
function readDoc(date, track) {
  for (const f of [`${track}.json.gz`, `${track}.json`]) {
    const p = path.join(DATA_DIR, date, f);
    if (fs.existsSync(p)) return readJson(p);
  }
  return null;
}

// ---------- 赛历 ----------
async function calendarOf(monthKey) {
  const [y, m] = monthKey.split("-");
  const url = `https://www.jbis.or.jp/race/calendar/?year=${y}&month=${m}`;
  const html = await fetchHtml(url);
  await sleep(DELAY_MS);
  const entries = parseCalendar(html);
  ensureDir(CAL_DIR);
  fs.writeFileSync(
    path.join(CAL_DIR, `${monthKey}.json`),
    JSON.stringify({
      schema: "jbis.race.calendar/v1",
      month: monthKey,
      capturedAt: at(jstToday()),
      url,
      entries,
    })
  );
  return entries;
}

// ---------- 血统缓存（单文件包，入库供 CI 增量复用） ----------
const sireStore = pedCache(path.join(PED_DIR, "jbis-sire.json"));
const horseStore = pedCache(path.join(PED_DIR, "jbis-horse.json"));

async function resolveSireSire(sire) {
  if (!sire?.id) return null;
  const cached = sireStore.get(sire.id);
  if (cached && "sire" in cached) return cached.sire;
  const html = await fetchHtmlSoft(`https://www.jbis.or.jp/horse/${sire.id}/`);
  await sleep(DELAY_MS);
  const ped = html ? parsePedigree(html) : null;
  const rec = {
    schema: "jbis.pedigree.sire/v1",
    id: sire.id,
    name: sire.name,
    nameEn: ped?.nameEn ?? null, // 官方英文名（归一化别名用）
    sire: ped?.sire ?? null,
    capturedAt: at(jstToday()),
  };
  sireStore.set(sire.id, rec);
  return rec.sire;
}

async function resolveHorsePedigree(horse) {
  if (!horse?.id) return null;
  const cached = horseStore.get(horse.id);
  if (cached && cached.dam) return cached;
  const html = await fetchHtmlSoft(`https://www.jbis.or.jp/horse/${horse.id}/`);
  await sleep(DELAY_MS);
  const ped = html ? parsePedigree(html) : null;
  if (!ped) return null;
  const rec = {
    schema: "jbis.pedigree.horse/v1",
    id: horse.id,
    name: horse.name,
    nameEn: ped.nameEn ?? null, // 官方英文名（归一化别名用）
    ...ped,
    capturedAt: at(jstToday()),
  };
  horseStore.set(horse.id, rec);
  return rec;
}

// ---------- 采集 ----------
async function collectTrack(date, track, dayHtml) {
  const { races } = parseDayPage(dayHtml);
  const out = {
    schema: "jbis.race.card/v1",
    date,
    track,
    venue: venueName(track),
    scope: scopeOf(track),
    source: `https://www.jbis.or.jp/race/calendar/${ymd(date)}/${track}/`,
    capturedAt: at(jstToday()),
    races: [],
  };

  for (const race of races) {
    const rec = { ...race, runners: [], status: race.status };
    if (race.status === "entries" && (!LIMIT || out.races.length < LIMIT)) {
      const rr = String(race.no).padStart(2, "0");
      let html = await fetchHtmlSoft(`https://www.jbis.or.jp/race/${ymd(date)}/${track}/${rr}/`);
      await sleep(DELAY_MS);
      let parsed = html ? parseEntryPage(html) : null;

      // 中央的出馬表若不在 /race/ 路径，回退到 /race/result/（同一模板时仍可取）
      if (!parsed) {
        html = await fetchHtmlSoft(`https://www.jbis.or.jp/race/result/${ymd(date)}/${track}/${rr}/`);
        await sleep(DELAY_MS);
        parsed = html ? parseEntryPage(html) : null;
      }

      if (parsed) {
        rec.runners = parsed.runners;
        rec.heads = parsed.runners.length || race.heads;
        rec.status = "entries";
      } else {
        rec.status = "pending";
      }
    }
    out.races.push(rec);
  }
  return out;
}

// 父父走父马缓存；母父缺失时用马页补全
async function enrichPedigree(doc) {
  const runners = doc.races.flatMap((r) => r.runners);
  const sires = new Map();
  for (const r of runners) if (r.sire?.id && !sires.has(r.sire.id)) sires.set(r.sire.id, r.sire);

  for (const sire of sires.values()) {
    const ss = await resolveSireSire(sire);
    for (const r of runners) if (r.sire?.id === sire.id) r.sireSire = ss;
  }

  for (const r of runners) {
    if (r.bms?.id) continue;
    const ped = await resolveHorsePedigree(r.horse);
    if (!ped) continue;
    r.bms = ped.damSire ?? null;
    r.dam = r.dam ?? ped.dam ?? null;
    r.sireSire = r.sireSire ?? ped.sireSire ?? null;
  }
  return doc;
}

function summarize(doc) {
  const runners = doc.races.reduce((n, r) => n + r.runners.length, 0);
  const done = doc.races.filter((r) => r.status === "entries").length;
  return { races: doc.races.length, decoded: done, runners };
}

// ---------- main ----------
const manifestFile = path.join(DATA_DIR, "manifest.json");
const manifest = readJson(manifestFile) ?? { schema: "jbis.race.manifest/v1", updatedAt: null, dates: {} };

const months = [...new Set(DATES.map((d) => d.slice(0, 7)))];
const calendar = {};
for (const m of months) {
  calendar[m] = await calendarOf(m);
  console.log(`[calendar] ${m}: ${calendar[m].length} 開催`);
}

for (const date of DATES) {
  const entries = (calendar[date.slice(0, 7)] ?? []).filter((e) => e.date === date);
  const tracks = TRACK_ARG ? entries.filter((e) => TRACK_ARG.split(",").includes(e.track)) : entries;

  if (!tracks.length) {
    console.log(`[skip] ${date}: 无開催（或赛历未更新）`);
    continue;
  }

  for (const e of tracks) {
    const file = path.join(DATA_DIR, date, `${e.track}.json.gz`);   // 压缩落盘
    const legacy = path.join(DATA_DIR, date, `${e.track}.json`);
    const existing = readDoc(date, e.track);
    const url = `https://www.jbis.or.jp/race/calendar/${ymd(date)}/${e.track}/`;
    try {
      const dayHtml = await fetchHtml(url);
      await sleep(DELAY_MS);
      const doc = await collectTrack(date, e.track, dayHtml);
      await enrichPedigree(doc);

      // 幂等：赛事数、头数、枠番/馬番/性齢一致则跳过（枠順更新、性齢修正会触发重写）
      const fp = (d) =>
        JSON.stringify(
          (d?.races ?? []).map((r) => [
            r.no,
            r.heads,
            (r.runners ?? []).map((x) => `${x.horse?.id}:${x.num}:${x.frame}:${x.sex ?? ""}${x.age ?? ""}`),
          ])
        );
      const same = !FORCE && existing && fp(existing) === fp(doc);
      // 防截断：--limit/--tracks 部分采集时，若已存文档更完整（头数更多）则不覆盖
      const partial = LIMIT > 0 || !!TRACK_ARG;
      const runnersOf = (d) => (d?.races ?? []).reduce((n, r) => n + (r.runners?.length ?? 0), 0);
      const keepExisting = partial && existing && runnersOf(existing) > runnersOf(doc);

      if (same || keepExisting) {
        console.log(`[same] ${date} ${e.track} ${doc.venue}: ${summarize(doc).runners} 頭`);
      } else {
        ensureDir(path.dirname(file));
        writeGz(file, JSON.stringify(doc));
        if (fs.existsSync(legacy)) fs.unlinkSync(legacy);   // 旧明文迁移
        const s = summarize(doc);
        console.log(`[ok]   ${date} ${e.track} ${doc.venue}: ${s.races} R / ${s.decoded} R 已出表 / ${s.runners} 頭`);
      }

      manifest.dates[date] = manifest.dates[date] || {};
      manifest.dates[date][e.track] = {
        venue: venueName(e.track),
        scope: scopeOf(e.track),
        ...summarize(doc),
        status: doc.races.some((r) => r.runners.length) ? "ok" : "pending",
        capturedAt: at(jstToday()),
      };
    } catch (err) {
      console.log(`[err]  ${date} ${e.track}: ${err.message}`);
      manifest.dates[date] = manifest.dates[date] || {};
      manifest.dates[date][e.track] = { venue: venueName(e.track), status: "error" };
    }
  }
}

manifest.updatedAt = at(jstToday());
ensureDir(DATA_DIR);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
sireStore.save();
horseStore.save();
console.log(`manifest -> ${manifestFile}（血统缓存 sire=${sireStore.size()} / horse=${horseStore.size()}，已入库 data/pedigree/）`);
