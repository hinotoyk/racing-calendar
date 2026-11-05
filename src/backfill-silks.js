// 彩衣（勝負服）全量回填：遍历 data/races 全部日期×场次，为缺彩衣的出走马补齐。
//   NAR：netkeiba 出馬表捷径（race_id = YYYY+jyo+MM+DD+RR，整场 1 次抓取）
//   中央 / 未命中：netkeiba 马名搜索（生年精确匹配防同名错配）
// 结果写回各 .json.gz；图按马主落盘 data/silks/；缓存入库 data/pedigree/nk-horse.json / nk-map.json。
// 幂等：终态缓存（命中/确认无）后重跑为纯缓存读，无网络请求。
//
// 用法：node src/backfill-silks.js [--dates 2026-10-24,2026-10-25] [--tracks 104,105] [--delay 1200] [--dry]
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { enrichSilks, saveSilkCaches, silkStats, setSilkDelay } from "./lib/silks.js";

const DATA_DIR = path.resolve("data", "races");

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const DATES = argOf("--dates")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const TRACKS = argOf("--tracks")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const DRY = argv.includes("--dry");
if (argOf("--delay")) setSilkDelay(parseInt(argOf("--delay"), 10));

function readJson(file) {
  return JSON.parse(file.endsWith(".gz") ? readGz(file) : fs.readFileSync(file, "utf8"));
}

const dates = DATES ?? fs.readdirSync(DATA_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
let docs = 0, races = 0, horses = 0, silked = 0;

for (const date of dates) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json.gz") || (x.endsWith(".json") && x !== "manifest.json")).sort()) {
    const track = f.replace(/\.json(\.gz)?$/, "");
    if (TRACKS && !TRACKS.includes(track)) continue;
    const file = path.join(dir, f);
    let doc;
    try {
      doc = readJson(file);
    } catch (e) {
      console.log(`[err] ${date}/${f}: ${e.message}`);
      continue;
    }
    if (String(doc.source ?? "").includes("racingpost")) continue; // 海外源无彩衣概念

    docs++;
    const all = doc.races.reduce((n, r) => n + (r.runners?.length ?? 0), 0);
    const have0 = doc.races.reduce((n, r) => n + (r.runners ?? []).filter((x) => x.silk).length, 0);
    let touched = 0;
    for (const race of doc.races) {
      const rs = race.runners ?? [];
      if (!rs.length) continue;
      races++;
      // 已全员有彩衣 → 跳过（不打 netkeiba）；否则走捷径/兜底逐马补
      if (rs.every((x) => x.silk)) continue;
      const before = rs.filter((x) => x.silk).length;
      await enrichSilks(date, track, race);
      touched += rs.filter((x) => x.silk).length - before;
    }
    horses += all;
    silked += touched;
    if (touched && !DRY) {
      const gz = file.endsWith(".gz");
      const out = gz ? file : file + ".gz";
      writeGz(out, JSON.stringify(doc));
      if (!gz) fs.unlinkSync(file); // 旧明文迁移
    }
    console.log(`[doc] ${date}/${track} ${doc.venue ?? ""}: +${touched}（计 ${have0 + touched}/${all}）`);
  }
}

saveSilkCaches();
const s = silkStats();
console.log(`done: docs=${docs} races=${races} horses=${horses} 补彩衣=${silked}（nk-horse=${s.nkHorse} / nk-map=${s.nkMap}）${DRY ? " [DRY]" : ""}`);
