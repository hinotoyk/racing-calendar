// 枠順/馬番 轻量补采（docs/DESIGN.md §11 · 12:00 补采档）
// 只做一件事：把「已落盘但缺枠番/馬番」的场次，从 JBIS 出馬表页补齐这两个字段。
//
// 与 collect-races.js（全量档）的区别：
//   不跑赛历、不解析当日页、不抓血统、不做马名权威化、不下彩衣、不重写整份文档；
//   已完整场次 0 请求；只按馬id 回填空字段，其余字段原样保留。
// 请求量 = 缺枠場次数（通常 = 明日出馬表 12R × 2–3 场 ≈ 24–40 次），而非全量档的 1000+ 次。
//
// 用法：node src/backfill-waku.js [--days 3] [--dates 2026-11-10,...] [--tracks 210,221]
//                                [--delay 1200] [--dry] [--limit 40]
import fs from "node:fs";
import path from "node:path";
import { SITE } from "./config.js";
import { fetchHtmlSoft } from "./lib/fetch.js";
import { readGz, writeGz } from "./lib/bundle.js";
import { parseEntryPage } from "./lib/parse-race.js";
import { venueName } from "./race-config.js";

const DATA_DIR = path.resolve("data", "races");
const MARK = path.resolve(".workbuddy", "imports", ".waku-dirty");

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const DAYS = parseInt(argOf("--days") ?? "3", 10); // 今天起 N 天（含今天），与全量档 SITE.days 对齐
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

const DATES = DATE_ARG
  ? DATE_ARG.split(",").map((s) => s.trim()).filter(Boolean)
  : Array.from({ length: DAYS + 1 }, (_, i) => addDays(jstToday(), i));

// 该场是否需要补：无 runners（出馬表没抓到过）或任一人缺枠番/馬番。已出结果的场次不再补。
function needWaku(race) {
  if (race.status !== "entries") return false;
  const rs = race.runners ?? [];
  if (!rs.length) return true;
  return rs.some((x) => x.frame == null || x.num == null);
}

// 按馬 id 回填：只填空字段，绝不覆盖已有值；出馬表人马变动（取消/追加）交给全量档
function mergeWaku(rec, parsed) {
  if (!rec.runners?.length) {
    rec.runners = parsed.runners;
    rec.heads = parsed.runners.length || rec.heads;
    return { horses: parsed.runners.length, fields: parsed.runners.length * 2, inserted: true };
  }
  const byId = new Map(rec.runners.map((x) => [x.horse?.id, x]));
  let horses = 0;
  let fields = 0;
  for (const p of parsed.runners) {
    const x = byId.get(p.horse?.id);
    if (!x) continue;
    let hit = false;
    if (x.frame == null && p.frame != null) {
      x.frame = p.frame;
      hit = true;
      fields++;
    }
    if (x.num == null && p.num != null) {
      x.num = p.num;
      hit = true;
      fields++;
    }
    if (hit) horses++;
  }
  return { horses, fields };
}

const stats = { requests: 0, races: 0, changedRaces: 0, horses: 0, seats: 0, errors: 0, touched: [] };
const t0 = Date.now();

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

    const todo = (doc.races ?? []).filter(needWaku);
    if (!todo.length) continue; // 已完整 → 0 请求

    console.log(`[need] ${date} ${track} ${venueName(track)}: ${todo.length} R 缺枠/馬番`);
    let changed = 0;

    for (const race of todo) {
      if (LIMIT && stats.requests >= LIMIT) break;
      const rr = String(race.no).padStart(2, "0");
      let parsed = null;
      for (const p of ["race", "race/result"]) {
        const url = `https://www.jbis.or.jp/${p}/${ymd(date)}/${track}/${rr}/`;
        const html = await fetchHtmlSoft(url);
        stats.requests++;
        await sleep(DELAY);
        parsed = html ? parseEntryPage(html) : null;
        if (parsed) break;
      }
      if (!parsed) {
        console.log(`[soft] ${date} ${track} ${race.no}R: 出馬表未公开/无枠列`);
        continue;
      }
      const res = mergeWaku(race, parsed);
      if (res.horses) {
        changed++;
        stats.changedRaces++;
        stats.horses += res.horses;
        stats.seats += res.fields;
        console.log(
          `[waku] ${date} ${track} ${race.no}R ${race.name ?? ""}: 枠+${res.fields}${res.inserted ? "（整表写入）" : ""}`
        );
      } else {
        console.log(`[same] ${date} ${track} ${race.no}R: 源站仍未给出枠番/馬番`);
      }
    }

    if (changed && !DRY) {
      doc.capturedAt = at(jstToday()); // 字段确实变了才更新抓取时间戳（口径与全量档一致）
      writeGz(file, JSON.stringify(doc));
      stats.touched.push(`${date}/${track}`);
    }
    if (changed && DRY) stats.touched.push(`${date}/${track}(dry)`);
  }
}

const sec = Math.round((Date.now() - t0) / 1000);
if (stats.changedRaces && !DRY) {
  fs.mkdirSync(path.dirname(MARK), { recursive: true });
  fs.writeFileSync(MARK, new Date().toISOString());
}

console.log(
  `waku -> changed=${stats.changedRaces} requests=${stats.requests} horses=${stats.horses} seats=${stats.seats} ` +
    `errors=${stats.errors} ${sec}s${DRY ? " (dry)" : ""}` +
    (stats.touched.length ? ` | ${stats.touched.join(", ")}` : "")
);

// 全部请求都失败才算异常（偶发 soft/未公开不算）
if (stats.requests > 0 && stats.errors === stats.requests) process.exit(1);
