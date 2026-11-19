// ============================================================
// 全球重赏收集 · 各国重赏日探针（探索分支 feat/global-graded）
// ============================================================
//
// 思路：其余 6 国没有 SL 那种「1 请求/天带级别」的捷径，但都有便宜的
// 「日/月级节目索引」——先用索引探出全年哪些日子有 G1-3（探针不补血统、
// 不落卡片），再只对重赏日跑既有采集器（collect-sources --dates）。
//
// 覆盖：tjk(土耳其) sanisidro(阿根廷·圣伊西德罗) laplata(阿根廷·拉普拉塔)
// 下一阶段：turfeonline(巴西·索引分页即可全扫) / loveracing(新西兰·月历)
//           / teletrak(智利·PDF) / racingaustralia(澳大利亚·5s/页太重)
//
// 用法：
//   node src/global/country-probe.mjs --source tjk --year 2026        # 探测
//   node src/global/country-probe.mjs --source tjk --collect          # 按探测结果跑采集器
//   node src/global/country-probe.mjs --source all --year 2026
//   node src/global/country-probe.mjs --list                          # 各源探测结果汇总
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";
import { fetchHtml } from "../lib/fetch.js";
import { gradeOf } from "./grade.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROBE_DIR = path.join(ROOT, "data", "global-graded", "probe");

const argv = process.argv.slice(2);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const YEAR = parseInt(val("--year", String(new Date().getFullYear())), 10);
const DELAY = parseInt(val("--delay", "800"), 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pad2 = (n) => String(n).padStart(2, "0");
function datesOf(year) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    for (let d = 1; d <= last; d++) {
      const date = `${year}-${pad2(m)}-${pad2(d)}`;
      if (date > today) return out;
      out.push(date);
    }
  }
  return out;
}

const probeFile = (src) => path.join(PROBE_DIR, `${src}.json`);
function saveProbe(src, days) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(probeFile(src), JSON.stringify({
    schema: "global.probe/v1", source: src, year: YEAR,
    capturedAt: new Date().toISOString(), days,
  }));
  const graded = days.filter((d) => d.races.length);
  console.log(`[probe:${src}] ${graded.length}/${days.length} 天有重赏，共 ${graded.reduce((n, d) => n + d.races.length, 0)} 场`);
}
function loadProbe(src) {
  return JSON.parse(fs.readFileSync(probeFile(src), "utf8"));
}

// ---------- 土耳其 TJK：日索引(1) + 每城市节目 HTML(n≈2) ----------
// 级别在 raceClass（"G 2/ULS"）里，与 collect.mjs 的 gradeOf 同一判定
async function probeTjk(dates, log = console.log) {
  const { parseIndexCities, parseProgramHtml } = await import("../sources/tjk.js");
  const days = [];
  for (const date of dates) {
    const [y, m, d] = date.split("-");
    const trDate = `${d}%2F${m}%2F${y}`;
    const races = [];
    try {
      const idx = await fetchHtmlSoft(`https://www.tjk.org/EN/YarisSever/Info/Page/GunlukYarisProgrami?QueryParameter_Tarih=${trDate}`, { src: "tjk-idx", ua: BROWSER_UA, retries: 1 });
      const cities = parseIndexCities(idx).filter((c) => !c.foreign && !c.karma);
      await sleep(DELAY);
      for (const c of cities) {
        const html = await fetchHtmlSoft(`https://www.tjk.org/EN/YarisSever/Info/Sehir/GunlukYarisProgrami?SehirId=${c.id}&QueryParameter_Tarih=${trDate}&SehirAdi=${encodeURIComponent(c.name)}`, { src: "tjk-probe", ua: BROWSER_UA, retries: 1 }).catch(() => null);
        await sleep(DELAY);
        if (!html) continue;
        const doc = parseProgramHtml(html, { dateIso: date, sehirId: c.id, cityName: c.name });
        for (const r of doc.races) {
          const g = gradeOf({ name: r.name, raceClass: r.raceClass }, { scope: "overseas" });
          if (g) races.push({ name: r.name ?? "", grade: g });
        }
      }
    } catch (e) {
      log(`[probe:tjk] !! ${date}: ${e.message}`);
    }
    days.push({ date, races });
    if (races.length) log(`[probe:tjk] ${date}: ${races.map((r) => r.grade).join(",")}`);
  }
  return days;
}

// ---------- 阿根廷 · 圣伊西德罗：节目页(1/日)，premios 赛名带 G1 ----------
async function probeSanisidro(dates, log = console.log) {
  const { appData } = await import("../sources/sanisidro.js");
  const days = [];
  for (const date of dates) {
    let races = [];
    try {
      const r = await fetchHtmlSoft(`https://hipodromosanisidro.com/programacion/programa-oficial/${date}`, { src: "si-probe", retries: 1 });
      const reunion = appData(r)?.props?.reunion;
      races = (reunion?.premios ?? [])
        .map((p) => {
          const g = gradeOf({ name: `${p.nombre ?? ""} ${p.nombre_largo ?? ""}` }, {});
          return g ? { name: `${p.nombre ?? p.nombre_largo}`, grade: g } : null;
        })
        .filter(Boolean);
    } catch (e) {
      // 404 = 当日无节目（常态），不算失败
      if (!/404/.test(String(e.status ?? e.message))) log(`[probe:si] !! ${date}: ${e.message}`);
    }
    days.push({ date, races });
    if (races.length) log(`[probe:si] ${date}: ${races.map((x) => x.grade).join(",")}`);
    await sleep(DELAY);
  }
  return days;
}

// ---------- 阿根廷 · 拉普拉塔：月历(1/月) + 每赛马日节目页 ----------
async function probeLaplata(dates, log = console.log) {
  const { parseCalendar, parseReunionHtml } = await import("../sources/laplata.js");
  const want = new Set(dates);
  const dayMap = new Map(dates.map((d) => [d, []]));
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    let reunions = [];
    try {
      const html = await fetchHtml(`https://www.hipodromolaplata.gba.gov.ar/h/index.php?mes=${m}&ano=${y}`);
      reunions = parseCalendar(html).filter((x) => want.has(x.date));
    } catch (e) {
      log(`[probe:lp] !! ${ym}: ${e.message}`);
    }
    await sleep(DELAY);
    for (const reu of reunions) {
      try {
        const [y, m, dd] = reu.date.split("-");
        const html = await fetchHtml(`https://www.hipodromolaplata.gba.gov.ar/h/wsAdmin/programaOficial/verTelas.php?numReu=${reu.numReu}&ano=${y}&fecha=${dd}-${m}-${y}`);
        const races = parseReunionHtml(html)
          .map((r) => {
            const g = gradeOf({ name: `${r.name ?? ""} ${r.condicion ?? ""}` }, {});
            return g ? { name: r.name ?? "", grade: g } : null;
          })
          .filter(Boolean);
        if (races.length) {
          dayMap.get(reu.date).push(...races);
          log(`[probe:lp] ${reu.date}: ${races.map((x) => x.grade).join(",")}`);
        }
      } catch (e) {
        log(`[probe:lp] !! ${reu.date}: ${e.message}`);
      }
      await sleep(DELAY);
    }
  }
  return [...dayMap.entries()].map(([date, races]) => ({ date, races }));
}

// ---------- 采集（按探测结果跑既有采集器） ----------
function collectSource(src, days) {
  const dates = days.filter((d) => d.races.length).map((d) => d.date);
  if (!dates.length) {
    console.log(`[collect:${src}] 无重赏日，跳过`);
    return;
  }
  console.log(`[collect:${src}] ${dates.length} 个重赏日 → collect-sources --source ${src}`);
  const r = spawnSync(process.execPath, ["src/collect-sources.js", "--source", src, "--dates", dates.join(",")], {
    cwd: ROOT, stdio: "inherit",
  });
  console.log(`[collect:${src}] 退出码 ${r.status}`);
}

// ---------- 主流程 ----------
const SOURCES = {
  tjk: probeTjk,
  sanisidro: probeSanisidro,
  laplata: probeLaplata,
};

async function main() {
  const which = val("--source", val("--src", null));
  if (argv.includes("--list")) {
    for (const src of fs.existsSync(PROBE_DIR) ? fs.readdirSync(PROBE_DIR) : []) {
      if (!src.endsWith(".json")) continue;
      const p = JSON.parse(fs.readFileSync(path.join(PROBE_DIR, src), "utf8"));
      const graded = p.days.filter((d) => d.races.length);
      console.log(`${p.source}: ${graded.length} 天 / ${graded.reduce((n, d) => n + d.races.length, 0)} 场（${p.capturedAt}）`);
    }
    return;
  }
  if (!which || !SOURCES[which]) {
    console.error("用法：--source tjk|sanisidro|laplata [--year 2026] [--collect] [--list]");
    process.exit(1);
  }
  if (argv.includes("--collect")) {
    const p = loadProbe(which);
    collectSource(which, p.days);
    return;
  }
  const dates = datesOf(YEAR);
  console.log(`[probe:${which}] ${YEAR} 年 ${dates.length} 天探测开始`);
  const days = await SOURCES[which](dates);
  saveProbe(which, days);
}

main().catch((e) => { console.error(e); process.exit(1); });
