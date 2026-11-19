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

function runnerRow(runner) {
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
    di: diFlags(runner),
  };
}

// ---------- 扫描 ----------
function scan() {
  const races = [];
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
        const runners = (race.runners ?? []).map(runnerRow);
        races.push({
          id: `${day}:${doc.track}:${race.no}`,
          date: day,
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
  const races = scan();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 国家 chips 计数（比赛数）
  const countries = {};
  for (const r of races) {
    const k = r.country ?? "??";
    countries[k] = (countries[k] ?? 0) + 1;
  }

  const out = {
    schema: "global.graded/v1",
    generatedAt: new Date().toISOString(),
    dayRange: [races.at(-1)?.date ?? null, races[0]?.date ?? null],
    counts: {
      races: races.length,
      runners: races.reduce((n, r) => n + r.runners.length, 0),
      diLine: races.reduce((n, r) => n + r.runners.filter((x) => x.di.line).length, 0),
      diBms: races.reduce((n, r) => n + r.runners.filter((x) => x.di.broodmare).length, 0),
    },
    countries,
    countryMeta: Object.fromEntries(COUNTRIES.map((c) => [c.code, c.label])),
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
