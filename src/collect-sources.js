// 多源采集入口（docs/DESIGN.md §8）
//   node src/collect-sources.js --source racingpost [--countries GB,IRE|all] [--tracks Carlisle]
//                               [--limit N] [--no-pedigree] [--dates 2026-10-22,...] [--force]
// 落盘：data/races/{date}/{源前缀}-{trackId}.json.gz（gzip 压缩）+ manifest.dates[date][sourceKey]
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { getSource } from "./sources/registry.js";

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const SOURCE = argOf("--source") ?? "racingpost";
const COUNTRIES_RAW = argOf("--countries")?.split(",").map((s) => s.trim()).filter(Boolean) ?? ["GB", "IRE"];
// "all" 语义：整串传给适配器（racingpost.js 按字符串 "all" 判定全国家）
const COUNTRIES = COUNTRIES_RAW.includes("all") ? "all" : COUNTRIES_RAW;
const TRACKS = argOf("--tracks")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const LIMIT = parseInt(argOf("--limit") ?? "0", 10);
const PEDIGREE = !argv.includes("--no-pedigree");
const FORCE = argv.includes("--force");
const DATES = argOf("--dates")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

const DATA_DIR = path.resolve("data", "races");
const manifestFile = path.join(DATA_DIR, "manifest.json");

function readJson(file) {
  try {
    return JSON.parse(file.endsWith(".gz") ? readGz(file) : fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 文档读取：优先压缩版（.json.gz），兼容旧明文（.json）
function readDoc(base) {
  const gz = `${base}.gz`;
  if (fs.existsSync(gz)) return readJson(gz);
  if (fs.existsSync(base)) return readJson(base);
  return null;
}

function summarize(doc) {
  const runners = doc.races.reduce((n, r) => n + (r.runners?.length ?? 0), 0);
  const decoded = doc.races.filter((r) => r.status === "entries").length;
  return { races: doc.races.length, decoded, runners };
}

// 幂等指纹（与 JBIS 采集器同规则）：赛事数 / 头数 / 马ID:番号 一致则跳过
function fingerprint(doc) {
  return JSON.stringify(
    (doc.races ?? []).map((r) => [r.no, r.heads, (r.runners ?? []).map((x) => `${x.horse?.id}:${x.num}`)])
  );
}

const src = await getSource(SOURCE);
console.log(`== source: ${src.id} (${src.label ?? ""})`);

const units = await src.collect({
  countries: COUNTRIES,
  tracks: TRACKS,
  limit: LIMIT,
  pedigree: PEDIGREE,
  fs,
  path,
});

const manifest = readJson(manifestFile) ?? { schema: "jbis.race.manifest/v1", updatedAt: null, dates: {} };
let written = 0;
let skipped = 0;

for (const { date, file, doc } of units) {
  if (DATES && !DATES.includes(date)) continue;
  const base = path.join(DATA_DIR, date, file);          // .../rp-{trackId}.json
  const file2 = `${base}.gz`;                            // 压缩落盘
  const existing = readDoc(base);
  // 防截断：--limit/--tracks 部分采集时，已存文档更完整（头数更多）则不覆盖
  const runnersOf = (d) => (d?.races ?? []).reduce((n, r) => n + (r.runners?.length ?? 0), 0);
  const partial = LIMIT > 0 || !!TRACKS;
  const keepExisting = partial && existing && runnersOf(existing) > runnersOf(doc);
  const same = !FORCE && existing && (fingerprint(existing) === fingerprint(doc) || keepExisting);

  const key = doc.sourceKey;
  manifest.dates[date] = manifest.dates[date] || {};
  if (same) {
    skipped++;
    console.log(`[same] ${date} ${file} ${doc.venue}: ${summarize(doc).runners} 頭`);
  } else {
    fs.mkdirSync(path.dirname(file2), { recursive: true });
    writeGz(base, JSON.stringify(doc));
    if (fs.existsSync(base)) fs.unlinkSync(base);        // 旧明文迁移
    written++;
    const s = summarize(doc);
    console.log(`[ok]   ${date} ${file} ${doc.venue}(${doc.country}): ${s.races} R / ${s.decoded} R 出表 / ${s.runners} 頭`);
  }
  manifest.dates[date][key] = {
    source: doc.source,
    venue: doc.venue,
    country: doc.country,
    scope: doc.scope,
    timeZone: doc.timeZone,
    localTimeZone: doc.localTimeZone,
    ...summarize(doc),
    status: doc.races.some((r) => (r.runners?.length ?? 0) > 0) ? "ok" : "pending",
    capturedAt: new Date().toISOString(),
  };
}

manifest.updatedAt = new Date().toISOString();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
console.log(`manifest -> ${manifestFile}（written=${written} skipped=${skipped}）`);
