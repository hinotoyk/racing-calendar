// 全球重赏收集 · 采集器（探索分支 feat/global-graded）
//
// 用法：
//   node src/global/collect.mjs               # 扫描现有 data/races → data/global-graded/graded.json
//   node src/global/collect.mjs --fetch       # 先跑既有采集器刷新原始数据（日本 + 海外各国），再扫描
//   node src/global/collect.mjs --region overseas
//   node src/global/collect.mjs --source tjk  # --fetch 时只刷指定海外源
//
// 复用既有 race.card/v2 数据（不重复造轮子）：日本 JBIS（collect-races.js）
// + 海外各国（collect-sources.js，见 src/sources/registry.js）。
// 本模块只做「级别过滤 + 归一 + Deep Impact 血统标注」。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COUNTRIES, countryOf } from "./config.mjs";
import { gradeOf, gradeRank } from "./grade.mjs";
import { diFlags } from "./pedigree.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT_DIR = path.join(ROOT, "data", "global-graded");
const OUT_FILE = path.join(OUT_DIR, "graded.json");
const RACES_DIR = path.join(ROOT, "data", "races");

// ---------- 原始数据刷新（复用既有采集器） ----------
const OVERSEAS_SOURCES = [
  "racingpost", "tjk", "sanisidro", "laplata", "turfeonline",
  "teletrak", "loveracing", "racingaustralia",
];

function runCollector(cmd, args) {
  const r = spawnSync(process.execPath, [cmd, ...args], {
    cwd: ROOT, stdio: "inherit",
  });
  return r.status === 0;
}

async function fetchRaw({ region, source } = {}) {
  const jobs = [];
  if (source) {
    jobs.push(["src/collect-sources.js", ["--source", source]]);
  } else {
    if (region !== "overseas") jobs.push(["src/collect-races.js", []]);
    if (region !== "japan") {
      for (const s of OVERSEAS_SOURCES) {
        jobs.push(["src/collect-sources.js", ["--source", s]]);
      }
    }
  }
  for (const [cmd, args] of jobs) {
    console.log(`[global] fetch ${cmd} ${args.join(" ")}`);
    runCollector(cmd, args);
  }
}

// ---------- 文档读取 ----------
function readDoc(fp) {
  const buf = fs.readFileSync(fp);
  const json = fp.endsWith(".gz")
    ? zlib.gunzipSync(buf).toString("utf8")
    : buf.toString("utf8");
  return JSON.parse(json);
}

// 地区 / 组织 / 国家归一
function regionOf(doc) {
  if (doc.scope === "central") return { region: "japan", org: "JRA", country: "JP" };
  if (doc.scope === "local") return { region: "japan", org: "NAR", country: "JP" };
  const c = countryOf(doc.country) ?? countryOf(doc.countryLong);
  if (c) return { region: "overseas", org: null, country: c.code };
  return { region: "overseas", org: null, country: null }; // 未知国家：收录但标「海外」
}

// ---------- 结果（着顺）join ----------
// data/results/<day>/ 的结果文档（*.race.result/v1）runners[].finish = 整数名次
// 或 非完走标记（取/除/中/降…）。结果文件名前缀 = 卡片源前缀（卡面 source → 前缀）：
// racingpost→rp、sanisidro→si、turfeonline→tol、teletrak→chs；tjk/日本（纯场码）同名。
const RESULT_PREFIX = {
  racingpost: "rp", tjk: "tjk", sanisidro: "si", turfeonline: "tol", teletrak: "chs",
};

// 索引：`${day}|${trackKey}` → Map(no → Map(num → finish 原值))
function buildResultsIndex() {
  const idx = new Map();
  const rdir = path.join(ROOT, "data", "results");
  if (!fs.existsSync(rdir)) return idx;
  for (const day of fs.readdirSync(rdir)) {
    const p = path.join(rdir, day);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (!/\.json(\.gz)?$/.test(f)) continue;
      let doc;
      try { doc = readDoc(p + path.sep + f); } catch { continue; }
      if (!doc || !Array.isArray(doc.races)) continue;
      const trackKey = doc.track ?? f.replace(/\.json(\.gz)?$/, "");
      for (const r of doc.races) {
        if (!r || typeof r.no !== "number") continue;
        const byNum = new Map();
        for (const u of r.runners ?? []) {
          if (u?.num == null) continue;
          byNum.set(u.num, u.finish ?? null);
        }
        const k = `${day}|${trackKey}|${r.no}`;
        idx.set(k, byNum);
        if (r.raceKey != null) idx.set(`rk|${r.raceKey}`, byNum);
      }
    }
  }
  return idx;
}

// 卡片 → 结果索引：优先 raceKey（rp/tjk 与结果同源同 id），回退 day|trackKey|no。
// 返回 Map(num → finish 原值) | null
function finishMapOf(cardDoc, race, day, idx) {
  if (race.raceKey != null) {
    const byKey = idx.get(`rk|${race.raceKey}`);
    if (byKey) return byKey;
  }
  const trackKey = cardDoc.source
    ? `${RESULT_PREFIX[cardDoc.source] ?? cardDoc.source}-${cardDoc.trackId ?? ""}`
    : String(cardDoc.track ?? "");
  return idx.get(`${day}|${trackKey}|${race.no}`) ?? null;
}

function runnerRow(runner, byNum = null) {
  const raw = byNum?.get(runner.num) ?? null;
  // 结果文档缺失时回退卡片自带 finish（JBIS 过往赛日结果页直印）
  const finish = raw ?? (runner.finish != null ? runner.finish : null);
  return {
    num: runner.num ?? null,
    frame: runner.frame ?? null,
    horse: runner.horse?.name ?? null,
    horseEn: runner.horse?.nameEn ?? null,
    sex: runner.sex ?? null,
    age: runner.age ?? null,
    jockey: runner.jockey?.name ?? null,
    trainer: runner.trainer?.name ?? null,
    sire: runner.sire?.name ?? null,
    sireSire: runner.sireSire?.name ?? null,
    bms: runner.bms?.name ?? null,
    rank: typeof finish === "number" ? finish : null,
    finishRaw: finish != null ? String(finish) : null,
    di: diFlags(runner),
  };
}

// ---------- SL 海外回填文档（global.sl.day/v1）合并 ----------
// overseas-backfill.mjs 产出 data/global-graded/sl/<date>.json；
// 与 data/races 的 rp 卡片可能重叠（同一 raceId）→ 按 raceId 去重，卡片行优先。
function slRunnerRow(u) {
  return {
    num: u.num ?? null,
    frame: u.draw ?? null,
    horse: u.horse ?? null,
    horseEn: null,
    sex: null,
    age: null,
    jockey: u.jockey ?? null,
    trainer: u.trainer ?? null,
    sire: u.sire ?? null,
    sireSire: null, // SL 相对马 id 数据缺陷，父父不可链查（宁缺勿错）
    bms: u.bms ?? null,
    rank: u.finish ?? null,
    finishRaw: u.status ?? (u.finish != null ? String(u.finish) : null),
    di: u.di ?? { line: false, broodmare: false, lineVia: null },
  };
}

function scanSlDays(races, seenRaceKeys) {
  const dir = path.join(ROOT, "data", "global-graded", "sl");
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (doc.schema !== "global.sl.day/v1") continue;
    for (const race of doc.races ?? []) {
      if (seenRaceKeys.has(race.raceId)) continue; // 卡片数据已覆盖
      // 级别扫描时重算（grade.mjs 单一事实源；Domestic Group 等在源头即被排除）
      const grade = gradeOf({ name: race.name, raceClass: null }, {});
      if (!grade) continue;
      const c = countryOf(race.country) ?? countryOf(String(race.country ?? "").toUpperCase());
      const runners = (race.runners ?? []).map(slRunnerRow);
      races.push({
        id: `${doc.date}:sl:${race.raceId}`,
        date: doc.date,
        year: doc.date.slice(0, 4),
        region: "overseas", org: null, country: c?.code ?? null,
        countryLabel: c?.label ?? "海外",
        venue: race.course ?? null,
        no: null,
        time: race.offTime ?? null,
        name: race.name ?? "",
        grade,
        surface: race.surface ?? null,
        distance: race.distance ?? null,
        heads: runners.length,
        status: race.stage ?? null,
        source: "sportinglife",
        sourceUrl: `${SL_DAY}/${doc.date}`,
        runners,
      });
    }
  }
}
const SL_DAY = "https://www.sportinglife.com/racing/results";

// ---------- 扫描 ----------
function scan(idx) {
  const races = [];
  const seenRaceKeys = new Set();
  const days = fs.readdirSync(RACES_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  for (const day of days) {
    const dir = path.join(RACES_DIR, day);
    for (const f of fs.readdirSync(dir).sort()) {
      if (!/\.json(\.gz)?$/.test(f)) continue;
      let doc;
      try { doc = readDoc(path.join(dir, f)); } catch (e) {
        console.warn(`[global] skip ${day}/${f}: ${e.message}`);
        continue;
      }
      const { region, org, country } = regionOf(doc);
      const cLabel = country
        ? COUNTRIES.find((c) => c.code === country)?.label ?? country
        : "海外";
      for (const race of doc.races ?? []) {
        const grade = gradeOf(race, doc);
        if (!grade) continue;
        if (race.raceKey != null) seenRaceKeys.add(String(race.raceKey));
        const byNum = finishMapOf(doc, race, day, idx);
        const runners = (race.runners ?? []).map((u) => runnerRow(u, byNum));
        races.push({
          id: `${day}:${doc.track}:${race.no}`,
          date: day,
          year: day.slice(0, 4),
          region, org, country, countryLabel: cLabel,
          venue: doc.venue ?? doc.track,
          no: race.no ?? null,
          time: race.startTimeLocal ?? race.startTime ?? null,
          name: race.name ?? "",
          grade,
          surface: race.surface ?? null,
          distance: race.distance ?? null,
          heads: runners.length,
          status: race.status ?? null,
          source: region === "japan" ? "jbis" : (doc.source ?? null),
          sourceUrl: typeof doc.source === "string" && doc.source.startsWith("http")
            ? doc.source : (doc.sourceUrl ?? null),
          runners,
        });
      }
    }
  }
  // SL 海外全年回填文档合并（去重：卡片 raceKey 已覆盖的跳过）
  scanSlDays(races, seenRaceKeys);
  races.sort((a, b) =>
    b.date.localeCompare(a.date) || gradeRank(a.grade) - gradeRank(b.grade)
    || (a.venue ?? "").localeCompare(b.venue ?? "") || (a.no ?? 0) - (b.no ?? 0));
  return races;
}

// ---------- 主流程 ----------
async function main() {
  const argv = process.argv.slice(2);
  // 布尔旗标（--fetch / --region/--source 带值）：后一个参数不存在或以 -- 开头视为纯旗标
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return null;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) return true;
    return next;
  };

  if (opt("fetch")) {
    await fetchRaw({
      region: opt("region"),
      source: opt("source") === true ? null : opt("source"),
    });
  }

  const t0 = Date.now();
  const idx = buildResultsIndex();
  const races = scan(idx);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 国家 chips 计数（比赛数）
  const countries = {};
  for (const r of races) {
    const k = r.country ?? "??";
    countries[k] = (countries[k] ?? 0) + 1;
  }
  // 自然年 chips 计数 + 名次覆盖率
  const years = {};
  for (const r of races) {
    const y = r.date.slice(0, 4);
    years[y] = (years[y] ?? 0) + 1;
  }
  const allRunners = races.reduce((n, r) => n + r.runners.length, 0);
  const rankKnown = races.reduce((n, r) => n + r.runners.filter((x) => x.rank != null || x.finishRaw).length, 0);

  const out = {
    schema: "global.graded/v1",
    generatedAt: new Date().toISOString(),
    dayRange: [races.at(-1)?.date ?? null, races[0]?.date ?? null],
    counts: {
      races: races.length,
      runners: allRunners,
      rankKnown,
      diLine: races.reduce((n, r) => n + r.runners.filter((x) => x.di.line).length, 0),
      diBms: races.reduce((n, r) => n + r.runners.filter((x) => x.di.broodmare).length, 0),
    },
    countries,
    countryMeta: Object.fromEntries(COUNTRIES.map((c) => [c.code, c.label])),
    years,
    races,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  // 页面静态兜底副本：无 API 服务（直接挂 9093 静态 / GH Pages）时也能加载
  const siteCopy = path.join(ROOT, "site", "global-graded-data.json");
  fs.copyFileSync(OUT_FILE, siteCopy);
  console.log(`[global] ${out.counts.races} races / ${out.counts.runners} runners` +
    ` (DI直系 ${out.counts.diLine}, DI母父 ${out.counts.diBms})` +
    ` → ${path.relative(ROOT, OUT_FILE)} (${Date.now() - t0}ms)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
