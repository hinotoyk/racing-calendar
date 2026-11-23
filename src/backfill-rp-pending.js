// RP pending 出马表回填（2026-11-23）
//
// ## 背景
// racingpost 采集只抓 SL 当日 racecards index；美国夜场等卡片在采集时刻尚未放出
// 出马（rides=[]），落盘为 status=pending 的空壳（有场次无出马）。SL racecards 对
// 历史日期 307 回当日，无法用采集器重采；但 **单场结果页对历史日期永远可访问**，
// 且 pageProps.race.rides 与出马表是同一套 raw ride 结构 → 用它回填。
//
// ## 原则（宁缺勿错）
//   - 只往 runners 为空的场次里填，绝不动已有出马的场次；
//   - 结果页 404 / 无 rides / raceKey 缺失 → 原样保留 pending，只打日志；
//   - 血统（sire/dam/bms）不回填（ped=null，避免整场逐马档案请求），留空符合口径；
//   - 回填后 status=entries，manifest 汇总与 status 同步刷新。
//
// ## 用法
//   node src/backfill-rp-pending.js [--dry] [--delay 1000] [--dates 2026-11-22,...] [--tracks 99,51]
// 回填后需 npm run build 重建 derived。
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { get, nextData } from "./sources/http.js";
import { resultUrl } from "./lib/sl-result.mjs";
import { runnerOf } from "./sources/racingpost.js";

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DRY = has("--dry");
const DELAY = parseInt(val("--delay", "1000"), 10);
const DATES = val("--dates", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const TRACKS = val("--tracks", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

const DATA_DIR = path.resolve("data", "races");
const MANIFEST = path.join(DATA_DIR, "manifest.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readDoc(date, file) {
  const gz = path.join(DATA_DIR, date, file);
  const plain = gz.replace(/\.gz$/, "");
  try {
    if (fs.existsSync(gz)) return JSON.parse(readGz(gz));
    if (fs.existsSync(plain)) return JSON.parse(fs.readFileSync(plain, "utf8"));
  } catch {}
  return null;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const stats = { docs: 0, races: 0, filled: 0, runners: 0, skip404: 0, skipEmpty: 0 };

for (const [date, tracks] of Object.entries(manifest.dates)) {
  if (DATES.length && !DATES.includes(date)) continue;
  for (const [key, rec] of Object.entries(tracks)) {
    if (!key.startsWith("rp:")) continue;
    if (rec.status !== "pending") continue;
    if (TRACKS.length && !TRACKS.includes(key.slice(3))) continue;
    const file = fs.readdirSync(path.join(DATA_DIR, date)).find((f) => f.startsWith(`rp-${key.slice(3)}.`) ) ;
    const doc = file ? readDoc(date, file) : null;
    if (!doc?.races?.length) {
      console.log(`[skip] ${date} ${key} 文档读取失败`);
      continue;
    }
    const todo = doc.races.filter((r) => !(r.runners?.length ?? 0) && /^\d+$/.test(String(r.raceKey ?? "")));
    if (!todo.length) {
      // 空壳但无有效 raceKey（或早已补全）：manifest 状态修正为 ok/重建汇总
      syncManifest(manifest.dates[date][key], doc);
      continue;
    }
    stats.docs++;
    let changed = false;
    for (const race of todo) {
      const url = resultUrl(doc.date, doc.venue, String(race.raceKey));
      const rp = await get(url).catch(() => null);
      await sleep(DELAY);
      const rides = rp?.status === 200
        ? (nextData(rp.text)?.props?.pageProps?.race?.rides ?? null)
        : null;
      if (!rides) {
        stats.skip404++;
        console.log(`[miss] ${date} ${doc.venue} R${race.no} raceKey=${race.raceKey} 页面不可达（${rp?.status ?? "err"}）`);
        continue;
      }
      if (!rides.length) {
        stats.skipEmpty++;
        console.log(`[miss] ${date} ${doc.venue} R${race.no} raceKey=${race.raceKey} 结果页无 rides`);
        continue;
      }
      race.runners = rides
        .slice()
        .sort((a, b) => (a.cloth_number ?? 0) - (b.cloth_number ?? 0))
        .map((ride) => runnerOf(ride, null));
      race.status = "entries";
      stats.filled++;
      stats.runners += race.runners.length;
      changed = true;
      console.log(`[fill] ${date} ${doc.venue} R${race.no} ${race.name ?? ""} ← ${race.runners.length} 頭`);
    }
    if (changed && !DRY) {
      const base = path.join(DATA_DIR, date, file.replace(/\.gz$/, ""));
      writeGz(base, JSON.stringify(doc));
      if (fs.existsSync(base)) fs.unlinkSync(base); // 旧明文迁移（若有）
    }
    syncManifest(manifest.dates[date][key], doc);
  }
}

function syncManifest(rec, doc) {
  const runners = doc.races.reduce((n, r) => n + (r.runners?.length ?? 0), 0);
  rec.races = doc.races.length;
  rec.decoded = doc.races.filter((r) => r.status === "entries").length;
  rec.runners = runners;
  rec.status = runners > 0 ? "ok" : "pending";
}

if (!DRY) {
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`manifest -> ${MANIFEST}`);
}
console.log(
  `\n[summary] 文档 ${stats.docs} / 场次 ${stats.filled}+${stats.skip404 + stats.skipEmpty}未达 / 补出马 ${stats.runners} 頭` +
  (DRY ? "（DRY 未落盘）" : "")
);
