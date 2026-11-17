// 阿根廷出走表血统回填：Stud Book Argentino（online，带磁盘缓存）
//
// 现状：La Plata 源页面只给「父 - 母」，母父/父父 全缺；San Isidro 源自带父/母/母父（部分），
// 父父 基本靠 si-sire 缓存碰运气。官方 Stud Book 的档案页首段就写着三代（父 / 母 / 母父），
// 父马档案页再给一层 → 父父。见 src/lib/studbookar.mjs 顶部注释。
//
// 用法：
//   node src/backfill-arg-ped.js                 # 全部 ARG 卡片
//   node src/backfill-arg-ped.js --date 2026-11-17
//   node src/backfill-arg-ped.js --dry
//   node src/backfill-arg-ped.js --no-sire-sire  # 不抓父父（省 1/3 请求）
// 幂等：只填缺失字段。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { horseProfile, cacheDir } from "./lib/studbookar.mjs";

const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const val = (k, d = null) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const DRY = has("dry");
const FORCE = has("force");
const WANT_SIRE_SIRE = !has("no-sire-sire");
const ONLY_DATE = val("date");
const LIMIT = Number(val("limit", "0")) || 0;
const CONC = Number(val("concurrency", "2")) || 2;

const RACES = path.resolve("data", "races");
const yearOf = (iso) => Number(String(iso ?? "").slice(0, 4)) || null;

function targetFiles() {
  const out = [];
  for (const day of fs.readdirSync(RACES).sort()) {
    if (ONLY_DATE && day !== ONLY_DATE) continue;
    const dir = path.join(RACES, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(".json.gz")) continue;
      if (!/^(lp|si)-/.test(f)) continue;
      out.push({ day, file: path.join(dir, f) });
    }
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

async function fetchAll(names, yearOfName) {
  const prof = new Map();
  const queue = [...names];
  let done = 0;
  let miss = 0;
  const worker = async () => {
    while (queue.length) {
      const name = queue.shift();
      const rec = await horseProfile(name, { force: FORCE, sireSire: WANT_SIRE_SIRE }).catch(() => null);
      prof.set(name, rec);
      done++;
      if (!rec || rec.missing) miss++;
      if (done % 10 === 0 || done === names.size) console.log(`  ... ${done}/${names.size}（未命中 ${miss}）`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, queue.length || 1) }, worker));
  return { prof, miss };
}

function patch(doc, prof) {
  const stat = { sex: 0, age: 0, bms: 0, sireSire: 0, sire: 0, dam: 0, color: 0 };
  let changed = 0;
  const empty = (v) => v == null || v === "" || (typeof v === "object" && (v.name == null || v.name === ""));
  for (const race of doc.races ?? []) {
    for (const r of race.runners ?? []) {
      const p = prof.get(r.horse?.name);
      if (!p || p.missing) continue;
      let touched = false;
      const set = (k, v, c) => {
        if (v == null || v === "" || !empty(r[k]) || r[k] === v) return;
        r[k] = v;
        stat[c]++;
        touched = true;
      };
      set("bms", p.bms ? { id: null, name: p.bms } : null, "bms");
      set("sireSire", p.sireSire ? { id: null, name: p.sireSire } : null, "sireSire");
      set("sire", p.sire ? { id: null, name: p.sire, country: null } : null, "sire");
      set("dam", p.dam ? { id: null, name: p.dam } : null, "dam");
      set("sex", p.sex, "sex");
      set("color", p.color, "color");
      const age = p.birth && yearOf(doc.date) ? yearOf(doc.date) - yearOf(p.birth) : null;
      set("age", age, "age");
      if (p.id && r.horse && !r.horse.sba) {
        r.horse.sba = p.id;
        touched = true;
      }
      if (touched) changed++;
    }
  }
  return { changed, ...stat };
}

async function main() {
  const files = targetFiles();
  console.log(`[backfill-arg-ped] 目标 ${files.length} 个卡片文件（cache: ${path.relative(process.cwd(), cacheDir)}）`);
  if (!files.length) return;
  const docs = files.map(({ day, file }) => ({ day, file, doc: JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")) }));
  const names = new Map();
  for (const { doc } of docs) {
    for (const race of doc.races ?? []) {
      for (const r of race.runners ?? []) {
        const n = r.horse?.name;
        if (n && !names.has(n)) names.set(n, yearOf(doc.date));
      }
    }
  }
  console.log(`[backfill-arg-ped] 唯一马名 ${names.size} 匹`);
  const { prof } = await fetchAll(new Set(names.keys()), names);

  const totals = { files: 0, changed: 0, bms: 0, sireSire: 0, sex: 0, age: 0, sire: 0, dam: 0, color: 0 };
  let hit = 0;
  const missed = [];
  for (const [n, p] of prof) {
    if (p && !p.missing) hit++;
    else missed.push(n);
  }
  for (const { day, file, doc } of docs) {
    const stat = patch(doc, prof);
    if (stat.changed) {
      if (!DRY) fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 }));
      totals.files++;
      console.log(
        `${day}/${path.basename(file)}: 马 ${stat.changed}｜母父 +${stat.bms} 父父 +${stat.sireSire} 父 +${stat.sire} 母 +${stat.dam} 性 +${stat.sex} 龄 +${stat.age}`
      );
    }
    for (const k of Object.keys(totals)) if (k !== "files" && k !== "changed") totals[k] += stat[k] ?? 0;
    totals.changed += stat.changed;
  }
  console.log(
    `\n[backfill-arg-ped] ${DRY ? "（dry-run）" : ""}命中 ${hit}/${names.size}｜改动 ${totals.files} 文件 / ${totals.changed} 行：` +
      `母父 +${totals.bms} · 父父 +${totals.sireSire} · 性 +${totals.sex} · 龄 +${totals.age}`
  );
  if (missed.length) console.log(`未收录：${missed.slice(0, 30).join(" / ")}`);
}

main();
