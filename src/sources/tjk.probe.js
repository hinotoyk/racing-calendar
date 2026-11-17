// TJK 源探测：抓取 + 归一 + 与官方 CSV 对账（不落 data/，区别于正式采集）
//
// 用法：
//   node src/sources/tjk.probe.js                     # 今天（欧洲/伊斯坦布尔）
//   node src/sources/tjk.probe.js --date 2026-11-15   # 指定比赛日
//   node src/sources/tjk.probe.js --date 2026-11-15 --offline .tmp-tjk.html --city İstanbul,3
//                                                    # 用本地已存的城市页跑解析（不联网抓页面，仍会对一次 CSV）
import fs from "node:fs";
import { collect, fetchProgramCsv, parseProgramHtml, probe } from "./tjk.js";

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const TZ = "Europe/Istanbul";
const todayInTz = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const dateIso = argOf("--date") ?? todayInTz();
const offline = argOf("--offline");
const cityArg = argOf("--city"); // "İstanbul,3"

console.log(`== TJK probe  date=${dateIso} (${TZ})`);

// 1) 连通性 + robots
const p = await probe();
console.log(`[robots] www.tjk.org 通配Disallow-All=${p.robots?.disallowAll ?? "n/a"}`);
console.log(`[index] ok=${p.index.ok} 当日场地 ${p.index.cities} 个（本国 ${p.index.turkish}）`);

// 2) 解析（离线样本 or 联网）
let docs;
if (offline) {
  const city = cityArg?.split(",")[0] ?? "İstanbul";
  const sehirId = cityArg?.split(",")[1] ?? null;
  const doc = parseProgramHtml(fs.readFileSync(offline, "utf8"), { dateIso, sehirId, cityName: city });
  docs = [doc];
  console.log(`\n[city] ${city}(${sehirId ?? "?"}) ← offline ${offline}`);
  console.log(`   ${doc.races.length} R / ${doc.races.reduce((n, r) => n + r.heads, 0)} 頭 / going=${doc.going ?? "-"}`);
} else {
  const units = await collect({ dates: [dateIso], silk: false });
  docs = units.map((u) => u.doc); // collect 返回落盘单元 {date,file,doc}
  if (!docs.length) console.log("  当日无本国节目（或抓取失败）");
}

// 3) 与官方 CSV 对账：场次数 / 时刻 / 距离 / 比赛格码
for (const doc of docs) {
  const csv = await fetchProgramCsv(doc.date, doc.venue);
  if (!csv.races) {
    console.log(`\n[csv] ${doc.venue}: 无导出 → 跳过对账`);
    continue;
  }
  let bad = 0;
  for (const hr of doc.races) {
    const cr = csv.races.find((x) => x.no === hr.no);
    if (!cr) {
      bad++;
      console.log(`  [csv] ${doc.venue} R${hr.no} 导出缺失`);
      continue;
    }
    const diffs = [];
    if (cr.time !== hr.startTime) diffs.push(`time ${hr.startTime} vs ${cr.time}`);
    if (cr.distance !== hr.distance) diffs.push(`dist ${hr.distance} vs ${cr.distance}`);
    if ((cr.klassCode ?? "") !== (hr.raceClass ?? "")) diffs.push(`class "${hr.raceClass}" vs "${cr.klassCode}"`);
    if (diffs.length) {
      bad++;
      console.log(`  [csv] ${doc.venue} R${hr.no} 差异: ${diffs.join(" / ")}`);
    }
  }
  console.log(`[csv] ${doc.venue}: ${doc.races.length} R vs 导出 ${csv.races.length} R → ${bad ? bad + " 处差异" : "全部一致"}`);
}

// 4) 字段覆盖
const rs = docs.flatMap((d) => d.races.flatMap((r) => r.runners));
if (rs.length) {
  const cov = (f) => `${f} ${rs.filter((r) => (typeof f === "function" ? f(r) : r[f]) != null && (typeof f === "function" ? f(r) : r[f]) !== "").length}/${rs.length}`;
  console.log("\n== 覆盖 ==");
  console.log(
    [
      cov("num"), cov("sex"), cov("age"), cov("color"), cov("weight"), cov("jockey"), cov("trainer"),
      cov("owner"), cov((r) => r.horse?.id), cov((r) => r.sire?.name), cov((r) => r.dam?.name),
      cov((r) => r.bms?.name), cov("silk"), cov((r) => r.tjk?.odds), cov((r) => r.tjk?.agfRank), cov((r) => r.tjk?.rating),
    ].join("  ")
  );
}

// 5) 样例 + 落盘
const sample = docs.find((d) => d.races.length);
if (sample) {
  const r = sample.races.find((x) => x.gradeTag) ?? sample.races[0];
  console.log(`\n== 样例 ${sample.venue} R${r.no} ${r.startTime} ${r.name}（${r.klass}/${r.klassGroup}）==`);
  console.log(JSON.stringify({ ...r, runners: r.runners.slice(0, 1) }, null, 1));
}
fs.mkdirSync("test-logs", { recursive: true });
const outFile = `test-logs/tjk-probe-${dateIso}.json`;
fs.writeFileSync(outFile, JSON.stringify(docs, null, 1));
console.log(`\n→ ${outFile}（${docs.length} 城市）`);
