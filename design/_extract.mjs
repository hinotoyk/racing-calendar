// 设计稿样例数据提取：从 _site/derived 取 3 场真实比赛（JRA G1 / NAR 重赏 / 海外），内嵌进原型页
// 运行：node design/_extract.mjs  →  生成 design/sample-data.js
import fs from "node:fs";
import { unpackRows } from "../src/lib/rows-codec.mjs";

const load = (d) => unpackRows(JSON.parse(fs.readFileSync(`_site/derived/${d}.json`, "utf8")));

function raceOf(rows, venue, no) {
  const rs = rows.filter((r) => r.venue === venue && r.raceNo === no).sort((a, b) => (a.num ?? 99) - (b.num ?? 99));
  if (!rs.length) throw new Error(`no race ${venue} ${no}R`);
  const h = rs[0];
  const runners = rs.map((r) => {
    const { recent1, recent2, recent3, raceUrl, raceKey, horseId, ...rest } = r;
    return rest;
  });
  return {
    date: h.date, dateLabel: h.dateLabel, weekday: h.weekday, scope: h.scope, country: h.country,
    venue: h.venue, raceNo: h.raceNo, raceName: h.raceName, level: h.level, klass: h.klass,
    surface: h.surface, distance: h.distance, heads: h.heads,
    startTime: h.startTime, startTimeTz: h.startTimeTz, startTimeInstant: h.startTimeInstant,
    runners,
  };
}

const d25 = load("2026-10-25");
const d22 = load("2026-10-22");

// 海外场：Belmont Park 取头数最多的一场（演示跨时区 → 北京时间跨日）
const bel = d22.filter((r) => r.venue === "Belmont Park");
const byRace = new Map();
for (const r of bel) {
  const k = r.raceNo;
  if (!byRace.has(k)) byRace.set(k, []);
  byRace.get(k).push(r);
}
let belPick = null;
for (const [, list] of [...byRace.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (list.length >= 7) { belPick = list[0].raceNo; break; }
}

const races = [
  raceOf(d25, "京都", 11),                       // 菊花賞 G1
  raceOf(d25, "高知", 6),                        // ネクストスター高知 地方重赏（夜场）
  raceOf(d22, "Belmont Park", belPick),          // 海外：北京时间跨日
];

fs.writeFileSync("design/sample-data.js", `window.__SAMPLE__ = { picked: ${JSON.stringify({ belPick })}, races: ${JSON.stringify(races)} };\n`);
console.log("ok", races.map((r) => `${r.date} ${r.venue} ${r.raceNo}R ${r.raceName} ${r.level} ${r.runners.length}頭 startTime=${r.startTime} tz=${r.startTimeTz}`).join("\n"));
