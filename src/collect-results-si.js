// San Isidro 赛果采集（阿根廷）：官方节目页在赛后仍挂着名次 → data/results/{date}/si-1.json
//
// ## 关键发现（2026-11-17 实测）
// `/programacion/programa-oficial/{YYYY-MM-DD}` 的 Inertia JSON 里，`props.reunion.estado`
// 赛后变成 `RESULTADOS`，且每匹 `inscripciones[]` 都带：
//   puesto（名次）/ distancia（落后距离，如 "1 1/2 cpos"）/ pagaria（独赢赔率）/ tiempo_oficial（场次用时）
// 也就是说**出馬表接口本身就带着顺**，之前只是因为默认窗口只看「今天+明天」（未开赛 → 无名次）而丢掉。
//
// 好处：不需要第二个站点、不需要按马名关联 —— 同一份 JSON 里 `premio.id` 就是卡片 raceKey，
//       `inscripcion.orden` 就是卡片马号，join 零歧义。
// 局限：`puesto` 只对「已完赛且源站已录入」的场次有值；退马（inscripciones_retiradas）单列，不入着顺。
//
// ## 用法
//   node src/collect-results-si.js --days 7                 # 回补过去一周
//   node src/collect-results-si.js --dates 2026-11-15       # 指定日
//   node src/collect-results-si.js --dry
import fs from "node:fs";
import path from "node:path";
import { fetchHtmlSoft, BROWSER_UA } from "./lib/fetch.js";
import { appData } from "./sources/sanisidro.js";

export const id = "sanisidro-results";

const BASE = "https://hipodromosanisidro.com";
const TZ = "America/Argentina/Buenos_Aires";
const RESULTS_DIR = path.resolve("data", "results");
const DATA_DIR = path.resolve("data", "races");

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DRY = has("--dry");
const FORCE = has("--force");
const DAYS = parseInt(val("--days", "7"), 10);
const DELAY = parseInt(val("--delay", "1500"), 10);
const DATES = (val("--dates", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");

function todayInTz() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const targets = DATES.length
  ? DATES
  : Array.from({ length: DAYS }, (_, i) => addDays(todayInTz(), -i)).reverse();

const numOf = (v) => {
  const n = String(v ?? "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return n ? Number(n[0]) : null;
};

/** props.reunion → race.result/v1 的 races[]（只留有名次的场次） */
export function resultsOfReunion(reunion, dateIso) {
  const races = [];
  for (const p of reunion?.premios ?? []) {
    const ins = p.inscripciones ?? [];
    const retired = new Set((p.inscripciones_retiradas ?? []).map((x) => String(x.orden ?? x.mandil ?? "")));
    const runners = [];
    for (const x of ins) {
      const num = numOf(x.orden);
      const finish = numOf(x.puesto);
      if (num == null || finish == null) continue;
      runners.push({
        num,
        finish,
        horse: { name: x.ejemplar_nombre ?? null },
        time: finish === 1 ? (p.tiempo_oficial ?? null) : null,
        margin: x.distancia ?? null,          // "1 1/2 cpos"（落后距离，冠军为 null）
        winOdds: numOf(x.pagaria),
        pop: null,
        last3f: null,
        bodyWeight: numOf(x.ejemplar_peso),
        jockey: x.jockey ?? null,
        trainer: x.cuidador ?? null,
      });
    }
    if (!runners.length) continue;
    runners.sort((a, b) => a.finish - b.finish);
    races.push({
      no: numOf(p.numero ?? p.orden),
      raceKey: p.id != null ? String(p.id) : null,
      status: "result",
      resultHeads: runners.filter((r) => r.finish).length,
      joined: runners.length,
      linked: runners.length,
      startTime: p.hora ?? null,
      timeOfficial: p.tiempo_oficial ?? null,
      sourceUrl: `${BASE}/programacion/programa-oficial/${dateIso}`,
      nonRunners: retired.size ? [...retired] : undefined,
      runners,
    });
  }
  return races;
}

async function main() {
  let written = 0;
  for (const date of targets) {
    const url = `${BASE}/programacion/programa-oficial/${date}`;
    const html = await fetchHtmlSoft(url, { src: "si-res", ua: BROWSER_UA, retries: 1 }).catch(() => null);
    await sleep(DELAY);
    if (!html) {
      console.log(`[skip] ${date} 节目页抓取失败`);
      continue;
    }
    const data = appData(html);
    const reunion = data?.props?.reunion;
    if (!reunion?.premios?.length) {
      console.log(`[skip] ${date} 无节目（非赛日）`);
      continue;
    }
    if (String(reunion.estado ?? "").toUpperCase() !== "RESULTADOS") {
      console.log(`[skip] ${date} 状态=${reunion.estado ?? "-"}（未出赛果）`);
      continue;
    }
    const races = resultsOfReunion(reunion, date);
    if (!races.length) {
      console.log(`[skip] ${date} 无带名次的场次`);
      continue;
    }
    const rows = races.reduce((n, r) => n + r.runners.length, 0);
    const doc = {
      schema: "jbis.race.result/v1",
      date,
      track: "1",
      venue: "San Isidro",
      scope: "overseas",
      source: "sanisidro",
      sourceUrl: url,
      updatedAt: new Date().toISOString(),
      races,
    };
    const outFile = path.join(RESULTS_DIR, date, "si-1.json");
    // 没有对应卡片就不落：结果层是按 raceKey|马号 join 的，没卡片等于死数据
    if (!fs.existsSync(path.join(DATA_DIR, date, "si-1.json.gz")) && !fs.existsSync(path.join(DATA_DIR, date, "si-1.json"))) {
      console.log(`[skip] ${date} 无本地出馬表卡片`);
      continue;
    }
    if (DRY) {
      console.log(`[dry] ${date} → ${races.length} 场 / 着顺 ${rows} 行`);
      continue;
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
    if (prev && !FORCE) {
      const before = prev.races?.reduce((n, r) => n + (r.runners?.length ?? 0), 0) ?? 0;
      if (before >= rows) {
        console.log(`[same] ${date} 已有 ${before} 行 ≥ 本次 ${rows} → 跳过`);
        continue;
      }
    }
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 1));
    console.log(`[ok]   ${date} San Isidro → results/si-1.json（${races.length} 场 / 着顺 ${rows} 行）`);
    written++;
  }
  console.log(`== 完成：写入 ${written} 篇（目标日 ${targets.join(",")}）`);
}

// 允许作为库 import（测试用），直接执行才跑主流程
if (!process.env.SA_LIB_ONLY) main().catch((e) => { console.error(e); process.exit(1); });
