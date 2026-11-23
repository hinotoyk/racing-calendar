// 清理海外卡片里的伪「枠番」：枠（1~8 号、按枠色分组）是日本中央/地方赛马独有制度。
//
// 历史包袱：Racing Post 源早期把 stalls（闸位号 1~20）写进了 runner.frame，TurfeOnline 早期
// 把 mandil（马牌号）写进了 frame → 前端/分享卡一旦按 frame 上色，海外赛事就会被读成「分 8 组」，
// 是假信息。build.js 已在输出层对非日本行强制置空，本脚本把**原始卡片**也清干净，
// 让 Excel 导出、分享卡、第三方订阅看到的数据与事实一致。
//
// 用法：node src/strip-foreign-frame.js [--dry]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DRY = process.argv.includes("--dry");
const RACES = path.resolve("data", "races");

// 日本判定必须与 build.js 同口径：JBIS 卡片**没有 country 字段**（实测 undefined），
// 只靠 scope=central/local 兜底成 JPN。旧版只看 doc.country === "JPN" → 日本卡片全被
// 误判为海外，把 backfill-waku 补好的枠番整库清空（2026-11-23 查明的「枠番补采跑了却没枠番」根因）。
const countryOf = (doc) => doc.country ?? (doc.scope === "central" || doc.scope === "local" ? "JPN" : null);
const isJapan = (doc) => countryOf(doc) === "JPN" || /^jbis\.race\.card/.test(String(doc.schema ?? ""));

let files = 0;
let rows = 0;
for (const day of fs.readdirSync(RACES).sort()) {
  const dir = path.join(RACES, day);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json.gz")) continue;
    const file = path.join(dir, f);
    const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    if (isJapan(doc)) continue; // 日本以外没有枠
    let n = 0;
    for (const race of doc.races ?? []) {
      for (const r of race.runners ?? []) {
        if (r.frame != null) {
          r.frame = null;
          n++;
        }
      }
    }
    if (!n) continue;
    files++;
    rows += n;
    console.log(`${day}/${f}: 清 ${n} 行`);
    if (!DRY) fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 }));
  }
}
console.log(`\n[strip-foreign-frame] ${DRY ? "（dry-run）" : ""}${files} 文件 / ${rows} 行`);
