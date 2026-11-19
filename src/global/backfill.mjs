// 全球重赏收集 · 全年回填编排（探索分支 feat/global-graded）
//
// 用法：
//   node src/global/backfill.mjs --year 2026 --region japan      # 日本自然年（JBIS 日历定位重赏日 → 只采有重赏的场）
//   node src/global/backfill.mjs --year 2026 --region overseas   # 海外（Racing Post 卡片+赛果，量大，数小时级）
//   node src/global/backfill.mjs --year 2026 --region all
//
// 思路：自然年 = 1/1-12/31 逐月拉 JBIS 赛历（每月 1 请求，赛历自带 gradeTag），
// 只对「当日含 G1-3/JG1-3/Jpn1-3」的赛日 × 赛场跑既有采集器（--no-silks 提速），
// 结果层用既有 collect-results / collect-results-rp。全程幂等可续跑（guardOverwrite）。
// 海外无「赛历带级别」的捷径（SL 日索引不带赛名级别），只能全量逐日，量大——按钮上如实标注。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchHtml } from "../lib/fetch.js";
import { parseCalendar } from "../lib/parse-race.js";
import { JP_GRADES } from "./config.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const argv = process.argv.slice(2);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const YEAR = parseInt(val("--year", String(new Date().getFullYear())), 10);
const REGION = val("--region", "japan"); // japan | overseas | all

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCollector(cmd, args) {
  console.log(`[backfill] $ node ${cmd} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [cmd, ...args], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) console.log(`[backfill] !! ${cmd} 退出码 ${r.status}（继续，幂等可续跑）`);
}

// ---------- 日本：JBIS 赛历定位重赏赛日 ----------
async function ensureCalendars(year) {
  const calDir = path.join(ROOT, "data", "races", "_calendar");
  fs.mkdirSync(calDir, { recursive: true });
  const nowYM = new Date();
  const lastMonth = nowYM.getFullYear() === year ? nowYM.getMonth() + 1 : 12;
  for (let m = 1; m <= lastMonth; m++) {
    const mm = String(m).padStart(2, "0");
    const file = path.join(calDir, `${year}-${mm}.json`);
    if (fs.existsSync(file)) continue;
    const url = `https://www.jbis.or.jp/race/calendar/?year=${year}&month=${m}`;
    console.log(`[backfill] 赛历 ${year}-${mm} …`);
    try {
      const html = await fetchHtml(url, { src: "jbis" });
      const entries = parseCalendar(html);
      fs.writeFileSync(file, JSON.stringify({
        schema: "jbis.race.calendar/v1",
        month: `${year}-${mm}`,
        capturedAt: new Date().toISOString(),
        url,
        entries,
      }));
    } catch (e) {
      console.log(`[backfill] !! 赛历 ${year}-${mm} 失败：${e.message}`);
    }
    await sleep(1200);
  }
}

function gradedDatesJapan(year) {
  const calDir = path.join(ROOT, "data", "races", "_calendar");
  const byDate = new Map(); // date → Set(track)
  for (const f of fs.readdirSync(calDir)) {
    if (!f.startsWith(`${year}-`)) continue;
    const cal = JSON.parse(fs.readFileSync(path.join(calDir, f), "utf8"));
    for (const e of cal.entries ?? []) {
      if (!JP_GRADES[e.gradeTag]) continue;
      if (!byDate.has(e.date)) byDate.set(e.date, new Set());
      byDate.get(e.date).add(e.track);
    }
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function yearDates(year) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    for (let d = 1; d <= last; d++) {
      const date = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (date > today) return out;
      out.push(date);
    }
  }
  return out;
}

async function backfillJapan(year) {
  await ensureCalendars(year);
  const graded = gradedDatesJapan(year);
  console.log(`[backfill] ${year} 日本重赏赛日：${graded.length} 天（${graded.reduce((n, [, s]) => n + s.size, 0)} 场·场组合）`);
  for (const [date, tracks] of graded) {
    const t = [...tracks].join(",");
    // 过往赛日走 JBIS 结果页路径（collect-races 内建），着顺/父母直印在卡片上，
    // 不再跑 netkeiba 结算层（collect-results）——省一半请求，名次不缺失。
    runCollector("src/collect-races.js", ["--dates", date, "--tracks", t, "--no-silks"]);
  }
}

async function backfillOverseas(year) {
  // ① SL 7 国（GB/IE/FR/HK/SA/AE/US）：日结果页 1 请求/天，赛名自级别，逐场取全序+血统
  runCollector("src/global/overseas-backfill.mjs", ["--year", String(year)]);
  // ② TR/AR×2：探针先找重赏日（1 请求/日或月），再只对重赏日跑既有采集器
  for (const src of ["tjk", "sanisidro", "laplata"]) {
    runCollector("src/global/country-probe.mjs", ["--source", src, "--year", String(year)]);
    runCollector("src/global/country-probe.mjs", ["--source", src, "--collect"]);
  }
}

async function main() {
  console.log(`[backfill] ===== ${YEAR} 年回填 start（region=${REGION}）`);
  if (REGION === "japan" || REGION === "all") await backfillJapan(YEAR);
  if (REGION === "overseas" || REGION === "all") await backfillOverseas(YEAR);
  runCollector("src/global/collect.mjs", []);
  console.log(`[backfill] ===== ${YEAR} 年回填 done`);
}

main().catch((e) => { console.error(e); process.exit(1); });
