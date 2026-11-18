// 回补历史 AU 卡片的性别缺失（2026-11-18 发现的 parseProfileDesc "brown" bug 的存量修复）
//
// ## 背景
// parseProfileDesc 的 SEX_WORDS 曾混入毛色词 "brown"，描述 "bay or brown gelding"
// 会先命中 brown → sex 解析为 null（SEX_JP 无 brown），全站 464 頭受影响、18 张卡片。
// 解析器已修复；本脚本对存量卡片按 sourceUrl 重新拉页 → 用修复后的解析器回填性别。
//
// ## 用法
//   node src/backfill-ra-sex.js            # 全量扫 data/races 找受影响卡片并回补
//   node src/backfill-ra-sex.js --dry      # 只列出受影响卡片，不发请求
//   node src/backfill-ra-sex.js --days 3   # 只处理最近 N 天（默认全历史）
//
// ## 请求量
//   每张受影响卡片 1 次页面请求（18 张 = 18 请求），间隔 2.5s；
//   挑战页（Zenedge "Are you human?"）退避 60s 重试，与 racingaustralia.js 抓取层一致。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { BROWSER_UA } from "./lib/fetch.js";
import { parseProfileDesc, isoFromKey } from "./sources/racingaustralia.js";

const DATA_DIR = path.resolve("data", "races");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DRY = has("--dry");
const DAYS = val("--days") ? Number(val("--days")) : 0;

// 与 racingaustralia.js 相同的文本工具（未导出，本地复制）
const decodeEnt = (s) =>
  String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const strip = (s) => decodeEnt(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// 与 racingaustralia.js parseRaRaceBody 相同的资料块正则：马号 → 马名 → plain 描述
const profRe = /class="horse-number">(\d+)<[\s\S]*?class="horse-name"[^>]*>([\s\S]*?)<\/span>[\s\S]*?class="plain">([\s\S]*?)<\/span>/gi;

const SEX_JP = { gelding: "セ", mare: "牝", filly: "牝", colt: "牡", entire: "牡", horse: "牡" };
const COLOUR_JP = {
  bay: "鹿毛", brown: "青鹿毛", black: "青毛", chestnut: "栗毛",
  grey: "芦毛", roan: "駁毛", buckskin: "栃栗毛", palomino: "帕洛米诺", white: "白毛",
};

async function fetchPage(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const html = await res.text();
      if (/Are you human\?/i.test(html)) throw new Error("RA challenge page");
      return html;
    } catch (e) {
      if (i + 1 >= 3) throw e;
      console.log(`    [RA] ${e.message} → 退避 60s 重试（${i + 1}/3）`);
      await sleep(60000);
    }
  }
  return null;
}

function findAffected(days) {
  const out = []; // { file, day, docPath, doc }
  const cut = days ? Date.now() - days * 86400_000 : 0;
  for (const day of fs.readdirSync(DATA_DIR)) {
    const dir = path.join(DATA_DIR, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("ra-") || !f.endsWith(".json.gz")) continue;
      const docPath = path.join(dir, f);
      const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(docPath)));
      const n = doc.races.reduce((a, r) => a + r.runners.filter((h) => h.sex == null && h.ra?.sexRaw === "brown").length, 0);
      if (!n) continue;
      if (cut && new Date(isoFromKey(day) ?? day).getTime() < cut) continue;
      out.push({ file: `${day}/${f}`, docPath, doc, horses: n });
    }
  }
  return out;
}

async function main() {
  const affected = findAffected(DAYS);
  const total = affected.reduce((a, x) => a + x.horses, 0);
  console.log(`[scan] 受影响卡片 ${affected.length} 张 / ${total} 頭`);
  for (const x of affected) console.log(`  - ${x.file}（${x.horses} 頭）`);
  if (DRY || !affected.length) return;

  let fixed = 0, unfixed = 0, requests = 0;
  for (const { file, docPath, doc } of affected) {
    if (!doc.sourceUrl) { console.log(`[skip] ${file}: 无 sourceUrl`); continue; }
    let html;
    try {
      html = await fetchPage(doc.sourceUrl);
      requests++;
    } catch (e) {
      console.log(`[fail] ${file}: ${e.message}`);
      continue;
    }
    // 马名 → 描述（马名全大写存卡；页面内 horse-name 可能带产地后缀 "XAMI (NZ)"，
    // 且引号形态可能不同（&rsquo; vs '），比对前做归一化）
    const normName = (s) => String(s ?? "").toUpperCase().replace(/\s*\((?:NZ|AUS|GB|IRE|USA|FR|GER|JPN)\)\s*$/, "").replace(/[’'`]/g, "").replace(/\s+/g, " ").trim();
    const descByName = new Map();
    for (const m of html.matchAll(profRe)) {
      const name = normName(strip(m[2]));
      const plain = strip(m[3]);
      if (name && plain && !descByName.has(name)) descByName.set(name, plain);
    }
    let n = 0;
    for (const race of doc.races) {
      for (const h of race.runners) {
        if (h.sex != null || h.ra?.sexRaw !== "brown") continue;
        const plain = descByName.get(normName(h.horse.name));
        if (!plain) { unfixed++; continue; }
        const p = parseProfileDesc(plain);
        if (!p.sex) { unfixed++; continue; }
        h.sex = SEX_JP[p.sex.toLowerCase()] ?? p.sex;
        h.age = h.age ?? p.age ?? null;
        h.color = p.colour ? (COLOUR_JP[p.colour.split(" / ")[0].toLowerCase()] ?? h.color) : h.color;
        h.ra.sexRaw = p.sex;
        h.ra.colourRaw = p.colour;
        h.ra.foaled = h.ra.foaled ?? p.foaled ?? null;
        n++;
      }
    }
    fixed += n;
    console.log(`[ok] ${file}: 回填 ${n} 頭`);
    if (n) fs.writeFileSync(docPath, zlib.gzipSync(JSON.stringify(doc)));
    await sleep(2500);
  }
  console.log(`[done] 回填 ${fixed} 頭 / 仍缺 ${unfixed} 頭 / 请求 ${requests} 次`);
}

main().catch((e) => { console.error(e); process.exit(1); });
