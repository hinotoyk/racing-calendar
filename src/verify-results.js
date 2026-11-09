// 本地体检：扫描 data/results/ 全部已入库赛果，用与采集端完全相同的完整性规则复核
//   node src/verify-results.js            # 只报告
//   node src/verify-results.js --strict  # 发现不完整时退出码 1（CI 可选）
import fs from "node:fs";
import path from "node:path";
import { checkCompleteness, isAbnormalFinish } from "./lib/result-completeness.js";

const RESULTS_DIR = path.resolve("data", "results");
const STRICT = process.argv.includes("--strict");
const dates = fs.existsSync(RESULTS_DIR)
  ? fs.readdirSync(RESULTS_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort()
  : [];

let races = 0;
let runners = 0;
let abnormal = 0;
let popMissing = 0;
const issues = [];

for (const date of dates) {
  const dir = path.join(RESULTS_DIR, date);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch (e) {
      issues.push(`${date}/${f}: JSON 解析失败 ${e.message}`);
      continue;
    }
    for (const r of doc.races ?? []) {
      races++;
      const list = r.runners ?? [];
      runners += list.length;
      abnormal += list.filter((x) => isAbnormalFinish(x.finish)).length;
      popMissing += list.filter((x) => typeof x.finish === "number" && x.pop == null).length;
      const chk = checkCompleteness(list, r.heads ?? list.length);
      if (!chk.ok) issues.push(`${date}/${f} ${r.raceKey ?? ""} ${r.no}R: ${chk.reason}`);
    }
  }
}

console.log(`[verify] ${dates.length} 天 / ${races} 场 / ${runners} 行 | 异常态 ${abnormal} | 数字名次缺人气 ${popMissing} | 不完整 ${issues.length}`);
for (const s of issues.slice(0, 30)) console.log(`  INCOMPLETE ${s}`);
if (issues.length > 30) console.log(`  ... 其余 ${issues.length - 30} 条`);
if (STRICT && issues.length) process.exitCode = 1;
