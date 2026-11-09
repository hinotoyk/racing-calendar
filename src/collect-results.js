// 着顺（结果）采集：JBIS 出馬表 ↔ netkeiba 出馬表关联 → 赛后结果页 → 入库
// docs/RESULTS.md §4；链路：/race/list/ 枚举(1/日) → 地方构造 / 中央按 JBIS 当日页「回/日」构造
//                    → 出馬表对齐(1/场) → 结果页（中央 race.* 优先，db.* 回退）
// 用法：node src/collect-results.js --dates 2026-11-08 --tracks 210 --limit 3 --dry
//      node src/collect-results.js --days 2            # CI / 日常滚动回看
//      node src/collect-results.js --until 2026-11-08  # 回填该日（含）以前的全部 JRA/NAR
//      node src/collect-results.js --days 1 --settle-min 10  # 定时任务：今天+昨天已结束且未完整入库的场次
// 完整性：只放前三名 / 名次缺号 / 人气未齐 → 判 partial，不入库，下轮自动重试
// 可选代理：RC_NK_PROXY=http://127.0.0.1:10809（Node 22 内置 EnvHttpProxyAgent，零依赖）
if (process.env.RC_NK_PROXY) {
  process.env.NODE_USE_ENV_PROXY = "1";
  process.env.HTTPS_PROXY = process.env.RC_NK_PROXY;
  process.env.HTTP_PROXY = process.env.RC_NK_PROXY;
}
import fs from "node:fs";
import path from "node:path";
import { SITE } from "./config.js";
import { fetchHtml, fetchNkHtml } from "./lib/fetch.js";
import { readGz } from "./lib/bundle.js";
import { nkNameKey } from "./lib/parse-netkeiba.js";
import { parseNkResult, parseNkShutubaMap } from "./lib/parse-nk-result.js";
import { checkCompleteness } from "./lib/result-completeness.js";
import {
  raceListUrl, parseRaceList, listKeyOfRaceId, expectedListKey,
  raceIdOf, scopeOfRaceId, resultUrlOf, legacyResultUrlOf, shutubaUrlOf,
} from "./lib/nk-race-id.mjs";

const DATA_DIR = path.resolve("data", "races");
const RESULTS_DIR = path.resolve("data", "results");

// ---------- CLI ----------
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const DRY = has("--dry");
const FORCE = has("--force");
const NO_SHUTUBA = has("--no-shutuba");
const TODAY = has("--today");
const LIMIT = parseInt(val("--limit", "0"), 10);
const DAYS = parseInt(val("--days", "2"), 10);
const DELAY = parseInt(val("--delay", String(SITE.delayMs)), 10);
const SETTLE_MIN = parseInt(val("--settle-min", "5"), 10);      // 开赛后等待分钟数
const MIN_POP_RATIO = parseFloat(val("--min-pop-ratio", "0.8")); // 数字名次行的人气覆盖率下限
const SCOPE = val("--scope", "all"); // local | central | all
const TRACKS = val("--tracks", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const DATES = val("--dates", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");

function jstToday() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const UNTIL = val("--until");
const dates = DATES.length
  ? DATES
  : TODAY
    ? [jstToday()]
    : UNTIL
      ? fs.readdirSync(DATA_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && n <= UNTIL).sort()
      : Array.from({ length: Math.max(0, DAYS) + 1 }, (_, i) => addDays(jstToday(), -DAYS + i));

// 只处理已经开赛 + 等待 SETTLE_MIN 的场次（JBIS 的 status=result 中央滞后一周，不能当触发条件）
function raceStarted(date, startTime) {
  const t = /^\d{1,2}:\d{2}$/.test(startTime ?? "") ? startTime : "23:59";
  const ms = Date.parse(`${date}T${t}:00+09:00`);
  return Number.isFinite(ms) ? ms + SETTLE_MIN * 60 * 1000 < Date.now() : true;
}
const scopeOfDoc = (doc) => (Number(doc.track) < 200 ? "central" : "local");

function readJson(file) {
  try {
    return JSON.parse(file.endsWith(".gz") ? readGz(file) : fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function readDoc(date, track) {
  for (const f of [`${track}.json.gz`, `${track}.json`]) {
    const p = path.join(DATA_DIR, date, f);
    if (fs.existsSync(p)) return readJson(p);
  }
  return null;
}
function resultFile(date, track) {
  return path.join(RESULTS_DIR, date, `${track}.json`);
}
function readResult(date, track) {
  const p = resultFile(date, track);
  return fs.existsSync(p) ? readJson(p) : null;
}

// ---------- 关联：场次级 ----------
async function listMapOf(date) {
  try {
    const html = await fetchNkHtml(raceListUrl(date));
    await sleep(DELAY);
    const ids = parseRaceList(html ?? "");
    const map = new Map();
    for (const id of ids) map.set(listKeyOfRaceId(id), id);
    return map;
  } catch (e) {
    console.log(`[results] ${date} 枚举口失败: ${e.message} → 仅用构造兜底`);
    return new Map();
  }
}
// 中央 race_id 的「回 / 日」来自 JBIS 当日页 title：
//   「2026年11月8日(日) 5回 東京     2日｜JBISサーチ」→ { kaisai: 5, day: 2 }
// 枚举口 /race/list/{date}/ 不列当天中央，靠这里 0 请求构造（每天每场 1 请求取回日）。
const kdCache = new Map();
async function kaisaiDayOf(date, track) {
  const key = `${date}/${track}`;
  if (kdCache.has(key)) return kdCache.get(key);
  let kd = null;
  try {
    const html = await fetchHtml(`https://www.jbis.or.jp/race/calendar/${date.replace(/-/g, "")}/${track}/`);
    stats.requests++;
    await sleep(DELAY);
    const title = (html.match(/<title>([\s\S]*?)<\/title>/) ?? [, ""])[1].replace(/\s+/g, " ");
    const m = title.match(/(\d+)回\s*\S+?\s*(\d+)日/);
    if (m) kd = { kaisai: Number(m[1]), day: Number(m[2]) };
    if (!kd) console.log(`[results] ${key} 页眉未解析到回/日: ${title.slice(0, 60)}`);
  } catch (e) {
    console.log(`[results] ${key} 当日页失败: ${e.message}`);
  }
  kdCache.set(key, kd);
  return kd;
}
function anchorOf(date, track, no, listMap, kd) {
  const key = expectedListKey(track, no);
  const id = key ? listMap.get(key) : null;
  if (id) return { id, via: "list" };
  const built = raceIdOf(date, track, no, kd ?? {}); // 地方直接构；中央用回/日
  return built ? { id: built, via: kd ? "built+kaisai" : "built" } : null;
}

// ---------- 关联：马级 ----------
function joinRunners(race, parsed, linkMap) {
  const byNum = new Map(parsed.runners.filter((r) => r.num != null).map((r) => [r.num, r]));
  const byName = new Map(parsed.runners.filter((r) => r.name).map((r) => [nkNameKey(r.name), r]));
  const runners = [];
  let byNumHit = 0;
  let byNameHit = 0;
  let linked = 0;
  for (const jr of race.runners ?? []) {
    let rr = jr.num != null ? byNum.get(jr.num) : null;
    if (rr) byNumHit++;
    if (!rr && jr.horse?.name) {
      rr = byName.get(nkNameKey(jr.horse.name));
      if (rr) byNameHit++;
    }
    if (!rr) continue;
    const h = jr.horse ?? {};
    const nkId = rr.nkId ?? linkMap?.get(nkNameKey(h.name ?? rr.name)) ?? null;
    if (nkId) linked++;
    runners.push({
      num: jr.num ?? rr.num,
      frame: jr.frame ?? rr.frame,
      horse: { id: h.id ?? null, name: h.name ?? rr.name ?? null, nkId },
      finish: rr.finish,
      abnormal: rr.abnormal,
      time: rr.time,
      margin: rr.margin,
      passing: rr.passing,
      last3f: rr.last3f,
      pop: rr.pop,
      winOdds: rr.winOdds,
      bodyWeight: rr.bodyWeight,
      bodyDelta: rr.bodyDelta,
    });
  }
  // 结果页里有、JBIS 出馬表里没有的马也保留，避免丢着顺
  for (const rr of parsed.runners) {
    if (rr.num == null || runners.some((x) => x.num === rr.num)) continue;
    runners.push({
      num: rr.num, frame: rr.frame, horse: { id: null, name: rr.name, nkId: rr.nkId },
      finish: rr.finish, abnormal: rr.abnormal, time: rr.time, margin: rr.margin,
      passing: rr.passing, last3f: rr.last3f, pop: rr.pop, winOdds: rr.winOdds,
      bodyWeight: rr.bodyWeight, bodyDelta: rr.bodyDelta,
    });
  }
  runners.sort((a, b) => (a.num ?? 99) - (b.num ?? 99));
  return { runners, byNumHit, byNameHit, linked };
}

// ---------- 主流程 ----------
const stats = { ok: 0, soft: 0, partial: 0, noid: 0, error: 0, skipped: 0, fallback: 0, linked: 0, runners: 0, requests: 0 };
let budget = LIMIT > 0 ? LIMIT : Infinity;

for (const date of dates) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d{3}\.json(\.gz)?$/.test(f))
    .map((f) => f.replace(/\.json(\.gz)?$/, ""))
    .filter((t) => !TRACKS.length || TRACKS.includes(t))
    .sort();
  if (!files.length || budget <= 0) continue;
  const listMap = await listMapOf(date);
  stats.requests++;

  for (const track of files) {
    if (budget <= 0) break;
    const doc = readDoc(date, track);
    if (!doc?.races?.length) continue;
    const scope = scopeOfDoc(doc);
    if (SCOPE !== "all" && SCOPE !== scope) continue;
    const kd = scope === "central" ? await kaisaiDayOf(date, track) : null;
    if (kd) console.log(`[results] ${date} ${track} 页眉 ${kd.kaisai}回${kd.day}日 → 构造中央 race_id`);
    const prev = readResult(date, track);
    const prevByKey = new Map((prev?.races ?? []).map((r) => [r.raceKey, r]));
    const targets = doc.races.filter((r) => r.runners?.length && raceStarted(date, r.startTime));
    console.log(`[results] ${date} ${track} ${doc.venue} (${scope}) 目标 ${targets.length} 场 / 已入库 ${prevByKey.size}`);
    const out = [];

    for (const race of targets) {
      if (budget <= 0) break;
      const cached = prevByKey.get(race.raceKey);
      const cachedOk = !FORCE && cached?.status === "result"
        && checkCompleteness(cached.runners, race.heads, { minPopRatio: MIN_POP_RATIO }).ok;
      if (cachedOk) {
        out.push(cached);
        stats.skipped++;
        continue;
      }
      budget--;
      const anchor = anchorOf(date, track, race.no, listMap, kd);
      if (!anchor) {
        stats.noid++;
        console.log(`  [noid ] ${pad2(race.no)}R ${race.raceKey} 枚举口/构造均无 race_id`);
        continue;
      }
      const { id, via } = anchor;
      const rscope = scopeOfRaceId(id);
      let linkMap = null;
      let linkCount = 0;
      try {
        if (!NO_SHUTUBA) {
          const shutuba = await fetchNkHtml(shutubaUrlOf(id));
          stats.requests++;
          await sleep(DELAY);
          if (shutuba) {
            linkMap = parseNkShutubaMap(shutuba);
            linkCount = linkMap.size;
          }
        }
      } catch (e) {
        // 出馬表失败不阻断：结果页本身带 nkId 与馬番
        console.log(`  [warn ] ${pad2(race.no)}R 出馬表关联失败: ${e.message}`);
      }

      let usedUrl = resultUrlOf(id);
      let html = null;
      try {
        html = await fetchNkHtml(usedUrl);
        stats.requests++;
        await sleep(DELAY);
      } catch (e) {
        stats.error++;
        console.log(`  [error] ${pad2(race.no)}R ${id}: ${e.message}`);
        continue;
      }
      let parsed = html ? parseNkResult(html, rscope) : null;
      // 中央：race.* 若仍是赛前页/无结果表，回退 db.* /race/{id}/（25 列 race_table_01）
      if (!parsed && rscope === "central") {
        const legacy = legacyResultUrlOf(id);
        try {
          const h2 = await fetchNkHtml(legacy);
          stats.requests++;
          await sleep(DELAY);
          if (h2) {
            const p2 = parseNkResult(h2, rscope);
            if (p2) { parsed = p2; usedUrl = legacy; stats.fallback++; }
          }
        } catch (e) {
          console.log(`  [warn ] ${pad2(race.no)}R db 回退失败: ${e.message}`);
        }
      }
      if (!parsed) {
        stats.soft++;
        console.log(`  [soft ] ${pad2(race.no)}R ${id} 无结果表（未生成 / 软空 / 模板不识别）`);
        continue;
      }
      // 完整性校验：只放前三名 / 名次缺号 / 人气未回填齐 → 不入库，留待下一轮重抓
      const chk = checkCompleteness(parsed.runners, race.heads, { minPopRatio: MIN_POP_RATIO });
      if (!chk.ok) {
        stats.partial++;
        console.log(`  [parti] ${pad2(race.no)}R ${id} 未入库：${chk.reason} | ${JSON.stringify(chk.stats)}`);
        continue;
      }
      const joined = joinRunners(race, parsed, linkMap);
      const rec = {
        no: race.no,
        raceKey: race.raceKey,
        nkRaceId: id,
        idVia: via,
        status: "result",
        heads: race.heads ?? race.runners.length,
        resultHeads: parsed.runners.length,
        joined: joined.runners.length,
        linked: joined.linked,
        byNumHit: joined.byNumHit,
        byNameHit: joined.byNameHit,
        shutubaNames: linkCount,
        startTime: race.startTime,
        sourceUrl: usedUrl,
        template: parsed.template,
        completeness: chk.stats,
        runners: joined.runners,
      };
      out.push(rec);
      stats.ok++;
      stats.linked += joined.linked;
      stats.runners += joined.runners.length;
      const win = [...joined.runners].sort((a, b) =>
        typeof a.finish === "number" && typeof b.finish === "number" ? a.finish - b.finish : 0)[0];
      console.log(`  [  ok ] ${pad2(race.no)}R ${id} via=${via} 着顺 ${rec.joined}/${race.heads} 頭 ` +
        `馬番命中=${joined.byNumHit} 名兜底=${joined.byNameHit} nkId=${joined.linked} ` +
        `1着 ${win?.horse?.name ?? "?"} ${win?.time ?? ""}`);
    }

    if (!DRY && out.length) {
      const file = resultFile(date, track);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body = {
        schema: "jbis.race.result/v1",
        date, track, venue: doc.venue, scope,
        source: "netkeiba",
        updatedAt: new Date().toISOString(),
        races: out.sort((a, b) => a.no - b.no),
      };
      fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
      console.log(`[results] 落盘 ${path.relative(process.cwd(), file)} (${out.length} 场)${DRY ? " [DRY 未写]" : ""}`);
    } else if (DRY && out.length) {
      console.log(`[results] ${date} ${track} ${out.length} 场 [DRY 未写盘]`);
    }
  }
}

console.log(`\n[results] 汇总 ok=${stats.ok} soft=${stats.soft} partial=${stats.partial} noid=${stats.noid} error=${stats.error} ` +
  `skipped=${stats.skipped} db回退=${stats.fallback} 关联马匹=${stats.linked} 落库行=${stats.runners} 请求≈${stats.requests}${DRY ? " [DRY]" : ""}`);
// 定时任务/外部脚本据此判断是否需要重建站点：有新入库才写标记
if (!DRY && stats.ok > 0) {
  const markDir = path.resolve(".workbuddy", "imports");
  try {
    fs.mkdirSync(markDir, { recursive: true });
    fs.writeFileSync(path.join(markDir, ".results-dirty"), new Date().toISOString());
  } catch {}
}
