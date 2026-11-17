// 按父马名批量补 runner.sireSire（祖父）—— 已知种马血统的定点回填
//
// ## 为什么
// 南美三国（智利/巴西/阿根廷）的节目源只给「父马」，不给「父父」。
// 于是前端「按祖父筛选」（血统快捷标签 sireSire）在这些国家筛不出东西 ——
// 不是赛场上没有该血统，而是卡片里字段空着。
// 典型：智利 Haras Matriarca 的 Hiraboku Deep（父 Deep Impact），
// 其产驹跑在 Club Hípico / Valparaíso，sireSire 全空。
//
// ## 用法
//   node src/patch-siresire.js --sire "Hiraboku Deep" --sireSire "DEEP IMPACT (JPN)" --dry
//   node src/patch-siresire.js --sire "Hiraboku Deep" --sireSire "DEEP IMPACT (JPN)"
//   node src/patch-siresire.js --sire "X" --sireSire "Y" --dates 2026-11-16,2026-11-18 --force
//
// 只填空值，默认不动已有 sireSire（--force 才覆盖）。--countries 可限定 CHI,BRA,ARG。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DATA_DIR = path.resolve("data", "races");
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);

const Sire = (val("--sire") || "").trim();
const SireSire = (val("--sireSire") || "").trim();
const DRY = has("--dry");
const FORCE = has("--force");
const DATES = (val("--dates") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const COUNTRIES = (val("--countries") || "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

if (!Sire || !SireSire) {
  console.error("用法: node src/patch-siresire.js --sire <父马名> --sireSire <祖父名> [--dry] [--force] [--dates a,b] [--countries CHI,BRA,ARG]");
  process.exit(2);
}

// 卡片里的血统字段有两种形态：字符串（部分源）或 {id,name,country}（Teletrak/TurfeOnline）
const nm = (v) => (v && typeof v === "object" ? String(v.name ?? "") : String(v ?? ""));

// 比对时剥国别后缀与大小写差异：「Hiraboku Deep」「HIRABOKU DEEP (JPN)」视为同一匹
const norm = (s) =>
  nm(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const target = norm(Sire);
// 写入值与卡片同形态：sire 是对象 → 写 {id,name,country}，让 build 的 nameWithCountry 拼出国别；
// 是字符串 → 直接写「名字 (国别)」。--sireSire 允许写成 "Deep Impact (JPN)" 或 "Deep Impact|JPN"。
const [ssName, ssCountry] = SireSire.includes("|")
  ? SireSire.split("|").map((s) => s.trim())
  : [SireSire, null];
const ssValue = (likeSire) =>
  likeSire && typeof likeSire === "object"
    ? { id: null, name: ssName, country: ssCountry }
    : SireSire;
const stat = { files: 0, touchedFiles: 0, runners: 0, patched: 0, skippedFilled: 0, samples: [] };

const dirs = fs
  .readdirSync(DATA_DIR)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .filter((d) => !DATES.length || DATES.includes(d))
  .sort();

for (const date of dirs) {
  const dir = path.join(DATA_DIR, date);
  for (const fn of fs.readdirSync(dir)) {
    if (!fn.endsWith(".json.gz")) continue;
    stat.files++;
    const file = path.join(dir, fn);
    let doc;
    try {
      doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    } catch {
      continue;
    }
    if (COUNTRIES.length && !COUNTRIES.includes(String(doc.country || "").toUpperCase())) continue;

    let changed = 0;
    for (const race of doc.races || []) {
      for (const r of race.runners || []) {
        if (norm(r.sire) !== target) continue;
        stat.runners++;
        if (nm(r.sireSire) && !FORCE) {
          stat.skippedFilled++;
          continue;
        }
        r.sireSire = ssValue(r.sire);
        changed++;
        stat.patched++;
        if (stat.samples.length < 8) {
          stat.samples.push(`${date} ${doc.country} ${doc.track} ${race.no}R #${r.num} ${r.horse?.name ?? "?"}`);
        }
      }
    }

    if (changed) {
      stat.touchedFiles++;
      if (!DRY) {
        fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(doc), "utf8"), { level: 9 }));
      }
    }
  }
}

console.log(
  `[patch-siresire] ${Sire} → 祖父 ${SireSire}${DRY ? "（干跑）" : ""}\n` +
    `  扫描卡片 ${stat.files}，命中该父马 ${stat.runners} 头，写入 ${stat.patched} 头，` +
    `已有值跳过 ${stat.skippedFilled} 头，改动文件 ${stat.touchedFiles}`
);
for (const s of stat.samples) console.log("  ·", s);
