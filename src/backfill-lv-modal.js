// 回补历史 NZ 卡片的性别/年龄/母系缺失（loveracing resolveModal 放宽前的存量修复）
//
// ## 背景
// resolveModal 原目标条件 = 「缺骑师才抓」，且 results 阶段整场跳过（skipModal）——
// 但 results 阶段表格有骑师、却常无 性别/年龄/母系列（2026-11-18 SC 24 頭全缺实测）。
// 解析层已放宽目标条件；本脚本对存量卡片按 entryUrl 走模态富化回填。
//
// ## 用法
//   node src/backfill-lv-modal.js          # 扫 data/races 找 lv 卡并回补
//   node src/backfill-lv-modal.js --dry    # 只列出受影响卡片与马数，不发请求
//
// ## 请求量
//   只抓「缺性别/年龄/母系」的马（1 请求/匹，3.5s 间隔），马 id 缓存
//   （data/pedigree/lv-horse.json）跨日去重；已富化过的马 0 请求。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { resolveModal } from "./sources/loveracing.js";

const DATA_DIR = path.resolve("data", "races");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");

function findAffected() {
  const out = [];
  for (const day of fs.readdirSync(DATA_DIR)) {
    const dir = path.join(DATA_DIR, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("lv-") || !f.endsWith(".json.gz")) continue;
      const docPath = path.join(dir, f);
      const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(docPath)));
      let need = 0, heads = 0;
      for (const r of doc.races ?? [])
        for (const h of r.runners ?? []) {
          heads++;
          if (h.lv?.entryUrl && (h.sex == null || h.age == null || !h.dam?.name)) need++;
        }
      if (need) out.push({ file: `${day}/${f}`, docPath, doc, need, heads });
    }
  }
  return out;
}

async function main() {
  const affected = findAffected();
  const total = affected.reduce((a, x) => a + x.need, 0);
  console.log(`[scan] 受影响卡片 ${affected.length} 张 / 需富化 ${total} 頭`);
  for (const x of affected) console.log(`  - ${x.file}（${x.need}/${x.heads} 頭，阶段=${x.doc.loveracing?.stage}）`);
  if (DRY || !affected.length) return;

  for (const { file, docPath, doc } of affected) {
    const before = JSON.stringify(doc.races.map((r) => r.runners.map((h) => [h.sex, h.age, h.dam?.name])));
    const stat = await resolveModal([doc], { delayMs: 3500, log: console.log });
    const after = JSON.stringify(doc.races.map((r) => r.runners.map((h) => [h.sex, h.age, h.dam?.name])));
    let filled = 0, left = 0;
    for (const r of doc.races)
      for (const h of r.runners) {
        if (h.sex != null && h.age != null && h.dam?.name) filled++;
        else if (h.lv?.entryUrl) left++;
      }
    console.log(`[ok] ${file}: 富化 ${stat.filled} / 剩余 ${left}（本次请求 ${stat.queried}，缓存命中 ${stat.hit}）`);
    if (before !== after) fs.writeFileSync(docPath, zlib.gzipSync(JSON.stringify(doc)));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
