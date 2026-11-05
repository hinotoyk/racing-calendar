// 马名权威化回填（2026-11-04）
//
// 目标：把已采集文档里的 runner.horse.name（出馬表显示名，可能带「 B」装备标记 / 国名括注）
//       全部替换为 JBIS 马页的登录名，并补 nameJp / nameEn / country / foaled 四个字段。
//
// 机制：按 JBIS id 读 /horse/{10位id}/ → h1（日文名）+ hdg1-search__sub（英文名(国籍)）+ 生年月日，
//       缓存 data/pedigree/jbis-name.json，重跑 0 网络。
//
// 用法：node src/backfill-names.js [--dates 2026-11-01,...] [--tracks 236,105]
//                                 [--name-conc 3] [--name-delay 300] [--limit-docs N] [--dry]
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { attachJbisNames, saveJbisNames, jbisNameStats } from "./lib/jbis-name.js";
import { reqStats } from "./lib/reqlog.js";

const DATA_DIR = path.resolve("data", "races");
const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const DATES = argOf("--dates")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const TRACKS = argOf("--tracks")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const CONC = parseInt(argOf("--name-conc") ?? "1", 10);
const DELAY = parseInt(argOf("--name-delay") ?? "1200", 10);
const LIMIT_DOCS = parseInt(argOf("--limit-docs") ?? "0", 10);
const DRY = argv.includes("--dry");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 开跑预检：JBIS WAF 封禁期整站 403，等在门口比硬撞划算（每 5 分钟探一次，最多 60 分钟）
async function probeJbis() {
  const { fetchHtmlSoft } = await import("./lib/fetch.js");
  const h = await fetchHtmlSoft("https://www.jbis.or.jp/horse/0001219241/", {
    src: "jbis-probe",
    retries: 0,
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    headers: {
      "Accept-Language": "ja,en-US;q=0.8,en;q=0.7",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  }).catch(() => null);
  return typeof h === "string" && h.length > 500;
}

if (!argv.includes("--skip-preflight")) {
  let ok = await probeJbis();
  for (let i = 0; !ok && i < 12; i++) {
    console.log(`[wait] JBIS 403 封禁中，5 分钟后重试（${i + 1}/12）`);
    await sleep(5 * 60 * 1000);
    ok = await probeJbis();
  }
  if (!ok) {
    console.log("[abort] JBIS 持续 403，未开始回填（缓存未变，稍后重跑即可）");
    process.exit(2);
  }
  console.log("[wait] JBIS 可访问，开始回填");
}

const dates = (
  DATES ??
  fs
    .readdirSync(DATA_DIR)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
).sort().reverse(); // 新的日期优先（先修最近要展示的比赛）

let docs = 0;
let changedDocs = 0;
let runners = 0;
let renamed = 0;
let withEn = 0;
const samples = [];
const t0 = Date.now();

for (const date of dates) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json.gz")).sort()) {
    if (f.startsWith("rp-")) continue; // 海外源无 JBIS id
    if (TRACKS && !TRACKS.includes(f.replace(".json.gz", ""))) continue;
    if (LIMIT_DOCS && docs >= LIMIT_DOCS) break;

    const file = path.join(dir, f);
    let doc;
    try {
      doc = JSON.parse(readGz(file));
    } catch (e) {
      console.log(`[err] ${date}/${f}: ${e.message}`);
      continue;
    }
    docs++;
    const before = JSON.stringify(doc);

    const rs = doc.races.flatMap((r) => r.runners ?? []);
    runners += rs.length;
    const oldNames = new Map(rs.map((r) => [r.horse?.id, r.horse?.name]));

    const st = await attachJbisNames(rs, {
      conc: CONC,
      delayMs: DELAY,
      log: (m) => console.log(m),
    });

    for (const r of rs) {
      const old = oldNames.get(r.horse?.id);
      if (old && r.horse?.name && old !== r.horse.name) {
        renamed++;
        if (samples.length < 15) samples.push(`${old} → ${r.horse.name}${r.horse.nameEn ? ` / ${r.horse.nameEn}` : ""}`);
      }
      if (r.horse?.nameEn) withEn++;
    }

    const after = JSON.stringify(doc);
    if (after !== before) {
      if (!DRY) writeGz(file, after);
      changedDocs++;
    }
    console.log(`[doc] ${date}/${f.replace(".json.gz", "")}: 馬${rs.length} 新抓${st.fetched} 改${after === before ? 0 : 1}`);
    if (LIMIT_DOCS && docs >= LIMIT_DOCS) break;
    await sleep(20);
  }
}

saveJbisNames();
const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(
  `done: docs=${docs} 改=${changedDocs} 馬次=${runners} 改名=${renamed} 有英文名=${withEn} 缓存=${jbisNameStats().cached} 请求=${reqStats().total} 耗时=${mins}min${DRY ? "（dry-run 未写盘）" : ""}`
);
if (samples.length) console.log("样例：\n  " + samples.join("\n  "));
