// 一次性回填：node src/backfill-lookup.js [--no-patch-docs] [--skip-nameen]
//   1) RP 源文档中全部 父/母父 名 → JBIS id 解析（缓存 data/pedigree/name-lookup.json，
//      已缓存的跳过；每日 CI 增量只解析新名字，无需重跑本脚本）
//   2) 历史 rp 文档 sireSire=null 的按解析结果补写落盘（--no-patch-docs 跳过）
//   3) jbis-sire.json 缺 nameEn 的记录补抓马页（官方英文名，片假名↔英文归一的桥）
// 全程 1.2s 礼貌间隔；首次全量约 30–40 分钟，之后无需重跑。
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { pedCache } from "./lib/ped-cache.js";
import { createHorseLookup, preferredMapFromSireCache } from "./lib/horse-lookup.js";
import { fetchHtmlSoft } from "./lib/fetch.js";
import { parsePedigree } from "./lib/parse-race.js";
import { normalizeHorseName } from "./lib/horse-name.mjs";
import { SITE } from "./config.js";
import { enrichSireSire } from "./sources/racingpost.js";

const argv = process.argv.slice(2);
const DELAY = SITE.delayMs;
const PATCH_DOCS = !argv.includes("--no-patch-docs");
const BACKFILL_NAMEEN = !argv.includes("--skip-nameen");
const REVALIDATE = argv.includes("--revalidate"); // 用消歧新规则重验已缓存记录，并 overwrite 重写文档
const log = console.log;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpDocs() {
  const dir = path.resolve("data", "races");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort()) {
    for (const f of fs.readdirSync(path.join(dir, d)).filter((x) => x.startsWith("rp-") && x.endsWith(".json.gz"))) {
      const p = path.join(dir, d, f);
      try {
        out.push({ file: p, doc: JSON.parse(readGz(p)) });
      } catch (e) {
        log(`[warn] 跳过损坏文档 ${p}: ${e.message}`);
      }
    }
  }
  return out;
}

const lookup = createHorseLookup({
  cache: pedCache(path.resolve("data", "pedigree", "name-lookup.json")),
  delayMs: DELAY,
  preferred: (() => {
    try {
      const m = preferredMapFromSireCache(JSON.parse(fs.readFileSync(path.resolve("data", "pedigree", "jbis-sire.json"), "utf8")));
      log(`== 现役种公马别名 ${m.size} 名预置（jbis-sire 缓存）`);
      return m;
    } catch {
      return null;
    }
  })(),
  log,
});

// ---- 0) --revalidate：同名异马冲突/年龄不合理（老马误绑）的记录强刷 ----
if (REVALIDATE) {
  const raw = JSON.parse(fs.readFileSync(path.resolve("data", "pedigree", "name-lookup.json"), "utf8"));
  // 冲突检测：同一归一化名被不同 JBIS id 声明（口径同 build.js）
  const claims = new Map();
  const add = (name, id) => {
    const k = normalizeHorseName(name);
    if (!k || !id) return;
    if (!claims.has(k)) claims.set(k, new Set());
    claims.get(k).add(id);
  };
  for (const rec of Object.values(raw)) {
    if (!rec.resolvedId) continue;
    add(rec.name, rec.resolvedId);
    if (rec.resolvedName) add(rec.resolvedName, rec.resolvedId);
    if (rec.sire) add(rec.sire.name, rec.sire.id);
  }
  const sire = JSON.parse(fs.readFileSync(path.resolve("data", "pedigree", "jbis-sire.json"), "utf8"));
  for (const rec of Object.values(sire)) {
    add(rec.name, rec.id);
    if (rec.nameEn) add(rec.nameEn, rec.id);
    if (rec.sire) add(rec.sire.name, rec.sire.id);
  }
  const floor = new Date().getFullYear() - 45;
  const targets = new Set();
  for (const rec of Object.values(raw)) {
    if (rec.resolvedId && rec.birth != null && rec.birth < floor) targets.add(rec.name); // 现代父系不可能的老马
    if (claims.get(normalizeHorseName(rec.name ?? ""))?.size > 1) targets.add(rec.name); // 冲突别名
  }
  log(`== revalidate: ${targets.size} 名强刷（年龄下限 ${floor} 起 / 冲突别名）`);
  for (const name of targets) await lookup.resolve(name, { force: true, log });
  lookup.save();
}

// ---- 1+2) 解析名字 → 补写历史文档 ----
const units = rpDocs();
log(`== rp 文档 ${units.length} 份`);
const before = new Map(units.map((u) => [u.file, JSON.stringify(u.doc)]));
await enrichSireSire(
  units.map((u) => u.doc),
  { lookup, log, overwrite: REVALIDATE }
);

if (PATCH_DOCS) {
  let patched = 0;
  for (const u of units) {
    if (JSON.stringify(u.doc) === before.get(u.file)) continue;
    writeGz(u.file.replace(/\.gz$/, ""), JSON.stringify(u.doc));
    patched++;
  }
  log(`== 历史文档补写 ${patched} 份`);
}
lookup.save();

// ---- 3) jbis-sire 缺 nameEn 的补抓 ----
if (BACKFILL_NAMEEN) {
  const sireFile = path.resolve("data", "pedigree", "jbis-sire.json");
  const sireStore = pedCache(sireFile);
  const records = Object.entries(JSON.parse(fs.readFileSync(sireFile, "utf8")));
  const missing = records.filter(([, rec]) => !("nameEn" in rec) || rec.nameEn == null);
  log(`== jbis-sire ${records.length} 条，缺 nameEn ${missing.length} 条`);
  let ok = 0;
  for (const [id, rec] of missing) {
    const html = await fetchHtmlSoft(`https://www.jbis.or.jp/horse/${id}/`).catch(() => null);
    await sleep(DELAY);
    const ped = html ? parsePedigree(html) : null;
    if (!ped) continue;
    sireStore.set(id, { ...rec, nameEn: ped.nameEn ?? null, sire: ped.sire ?? rec.sire ?? null });
    ok++;
    if (ok % 50 === 0) {
      sireStore.save();
      log(`  ... ${ok}/${missing.length}`);
    }
  }
  sireStore.save();
  log(`== nameEn 回填 ${ok}/${missing.length} 条`);
}

log(`== 完成（lookup ${lookup.size()} 名）`);
