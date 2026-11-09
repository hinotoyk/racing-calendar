// 欧美源（Sporting Life）赛果增量采集：日级枚举 → 单场全序 → 人气换算 → 落盘
// 比日本源更短：结果页 rides[] 自带 cloth_number + finish_position + 最终赔率，
//   ① 不需要额外抓出馬表做马级关联（每场 1 请求，日本源 2 请求）
//   ② 本地 raceKey 就是 SL race id，无需构造 race_id / 解析「回 · 日」/ 双模板 / EUC-JP / 代理
// 用法：node src/collect-results-rp.js --dates 2026-11-08 --tracks 176 --limit 3 --dry
//      node src/collect-results-rp.js --days 1 --settle-min 10  # 定时任务：今天+昨天未完整入库的场次
//      node src/collect-results-rp.js --until 2026-11-08     # 回填
//      node src/collect-results-rp.js --today --no-index     # 更省：跳过日级列表，纯本地卡片驱动
//      node src/collect-results-rp.js --until 2026-11-09 --recheck-abnormal
//           # 只重抓「已落盘且含异常态」的场次，用于异常态分类升级后的历史回填
import fs from "node:fs";
import path from "node:path";
import { SITE } from "./config.js";
import { get } from "./sources/http.js";
import { readGz } from "./lib/bundle.js";
import { checkCompleteness } from "./lib/result-completeness.js";
import {
  dayUrl, resultUrl, parseSlDay, parseSlResult, abnormalOf, abnormalReasonOf, FINISHED_STAGES,
} from "./lib/sl-result.mjs";

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
const RECHECK_ABNORMAL = has("--recheck-abnormal");
const TODAY = has("--today");
const NO_INDEX = has("--no-index");
const LIMIT = parseInt(val("--limit", "0"), 10);
const DAYS = parseInt(val("--days", "2"), 10);
const DELAY = parseInt(val("--delay", String(SITE.delayMs)), 10);
const SETTLE_MIN = parseInt(val("--settle-min", "10"), 10);
const UNTIL = val("--until");
const DATES = val("--dates", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const TRACKS = val("--tracks", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

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
const dates = DATES.length
  ? DATES
  : TODAY
    ? [jstToday()]
    : UNTIL
      ? fs.readdirSync(DATA_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && n <= UNTIL).sort()
      : Array.from({ length: Math.max(0, DAYS) + 1 }, (_, i) => addDays(jstToday(), -DAYS + i));

function raceStarted(race) {
  const ms = race.startTimeInstant ? Date.parse(race.startTimeInstant) : NaN;
  if (!Number.isFinite(ms)) return true; // 无绝对时刻时交给日级 stage 判定
  return ms + SETTLE_MIN * 60 * 1000 < Date.now();
}

function readJson(file) {
  try {
    return JSON.parse(file.endsWith(".gz") ? readGz(file) : fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function readDoc(date, file) {
  return readJson(path.join(DATA_DIR, date, file));
}
const resultFile = (date, trackId) => path.join(RESULTS_DIR, date, `rp-${trackId}.json`);

async function fetchPage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await get(url);
      if (res.status >= 200 && res.status < 300 && res.text?.length > 500) return res.text;
      if (res.status === 404) return null;
    } catch {
      /* 退避后重试 */
    }
    await sleep(1000 * 2 ** attempt);
  }
  return null;
}

// ---------- 结果页 → 与本地卡片按 cloth_number 对齐 ----------
function buildRunners(parsed, race) {
  const localByNum = new Map(
    (race.runners ?? []).filter((r) => r.num != null).map((r) => [Number(r.num), r])
  );
  const runners = [];
  const nonRunners = [];
  let linked = 0;
  for (const ride of parsed.rides) {
    if (ride.rideStatus === "NONRUNNER") {
      nonRunners.push({ num: ride.cloth, name: ride.name });
      continue;
    }
    const local = localByNum.get(Number(ride.cloth));
    if (local) linked++;
    const finish = ride.finish > 0 ? ride.finish : abnormalOf(ride);
    runners.push({
      num: ride.cloth,
      frame: local?.frame ?? null,
      horse: {
        id: local?.horse?.id ?? (ride.horseId ? `rp:${ride.horseId}` : null),
        name: local?.horse?.name ?? ride.name ?? null,
      },
      finish,
      abnormal: typeof finish === "string" ? finish : null,
      abnormalReason: typeof finish === "string" ? abnormalReasonOf(ride) : null,
      pop: ride.pop ?? null,
      winOdds: ride.odds ?? null, // 英式分数赔率，保留源原样
      time: finish === 1 ? parsed.winningTime : null, // SL 只有整场冠军用时，无逐匹完走时间
      margin: null, passing: null, last3f: null, bodyWeight: null, bodyDelta: null,
      favourite: ride.favourite,
      comment: ride.comment ?? null,
    });
  }
  runners.sort((a, b) => (a.num ?? 99) - (b.num ?? 99));
  return { runners, nonRunners, heads: runners.length, linked };
}

// ---------- 主流程 ----------
const stats = {
  ok: 0, soft: 0, partial: 0, pending: 0, error: 0, skipped: 0, kept: 0,
  linked: 0, runners: 0, requests: 0,
};
let budget = LIMIT > 0 ? LIMIT : Infinity;

for (const date of dates) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir) || budget <= 0) continue;
  const files = fs.readdirSync(dir)
    .filter((f) => /^rp-\d+\.json(\.gz)?$/.test(f))
    .filter((f) => !TRACKS.length || TRACKS.some((t) => f.startsWith(`rp-${t}.`)))
    .sort();
  if (!files.length) continue;

  let dayMap = null;
  if (!NO_INDEX) {
    const html = await fetchPage(dayUrl(date));
    stats.requests++;
    await sleep(DELAY);
    dayMap = html ? parseSlDay(html) : new Map();
    if (!html) console.log(`[rp] ${date} 日级列表失败 → 退化为本地卡片 + 开赛时间判定`);
    else console.log(`[rp] ${date} 日级枚举 ${dayMap.size} 场`);
  }

  for (const file of files) {
    if (budget <= 0) break;
    const doc = readDoc(date, file);
    if (!doc?.races?.length) continue;
    const trackId = String(doc.trackId ?? file.replace(/^rp-|\.json(\.gz)?$/g, ""));
    const prev = readJson(resultFile(date, trackId));
    const prevByKey = new Map((prev?.races ?? []).map((r) => [String(r.raceKey), r]));
    const out = [];
    console.log(`[rp] ${date} rp-${trackId} ${doc.venue} (${doc.country}) 卡片 ${doc.races.length} 场 / 已入库 ${prevByKey.size}`);

    for (const race of doc.races) {
      const raceKey = String(race.raceKey ?? "");
      if (!/^\d+$/.test(raceKey)) continue;
      const meta = dayMap?.get(raceKey);
      // 日级列表并非完备枚举（实测 Del Mar 947961 已 WEIGHEDIN 却不在任一天的日级列表里），
      // 所以对「日级未列但卡片已开赛」的场次仍抓一次单场页，由结果页自身的 stage 判定。
      const ready = NO_INDEX || !dayMap
        ? raceStarted(race)
        : (!!meta && FINISHED_STAGES.has(String(meta.stage ?? "").toUpperCase()))
          || (!meta && raceStarted(race));
      if (!ready) {
        stats.pending++;
        continue;
      }

      const cached = prevByKey.get(raceKey);
      // 异常态分类升级后，只重抓历史上带异常态的场次（其余仍幂等跳过，避免全量请求）
      const legacyAbnormal = RECHECK_ABNORMAL
        && (cached?.runners ?? []).some((x) => typeof x.finish === "string");
      const cachedOk = !FORCE && !legacyAbnormal && cached?.status === "result" && checkCompleteness(
        cached.runners, cached.heads ?? cached.runners?.length ?? 0,
        { requirePop: cached.hasOdds !== false }
      ).ok;
      if (cachedOk) {
        out.push(cached);
        stats.skipped++;
        continue;
      }
      if (budget <= 0) break;
      budget--;

      // 重抓失败（soft/partial/error）时保留旧记录：否则 --force / --recheck-abnormal
      // 遇到源站临时 hasError 会把已入库结果直接冲掉（2026-11-09 实测丢过 3 场）。
      const keepCached = (tag) => {
        if (!cached) return;
        out.push(cached);
        stats.kept++;
        console.log(`  [keep ] ${pad2(race.no)}R ${raceKey} ${tag}：沿用已入库结果`);
      };

      const url = resultUrl(date, meta?.course ?? doc.venue, raceKey);
      let html = null;
      try {
        html = await fetchPage(url);
        stats.requests++;
        await sleep(DELAY);
      } catch (e) {
        stats.error++;
        console.log(`  [error] ${pad2(race.no)}R ${raceKey}: ${e.message}`);
        keepCached("抓取异常");
        continue;
      }
      const parsed = html ? parseSlResult(html) : null;
      const stage = String(parsed?.stage ?? meta?.stage ?? "").toUpperCase();
      // 单场页偶尔不带 race_stage；有全序着顺即视为结果已定稿（赛前页 finish 全为 0）
      const hasResultTable = !!parsed && parsed.rides.some((r) => r.finish > 0);
      if (!parsed || (!FINISHED_STAGES.has(stage) && !hasResultTable)) {
        stats.soft++;
        console.log(`  [soft ] ${pad2(race.no)}R ${raceKey} 无结果表 / 未完赛 (${stage || "?"})`);
        keepCached("软空");
        continue;
      }

      const joined = buildRunners(parsed, race);
      // SL 的 WEIGHEDIN 是终态：finish_position=0 是合法异常态（法国 trot 大量失格也是 0），
      // 不是 netkeiba 那种「先放前三名」的渐进状态。判半截结果改用「结果表行数 vs 卡片马数」。
      const cardHeads = race.runners?.length ?? 0;
      if (cardHeads && parsed.rides.length < cardHeads - 2) {
        stats.partial++;
        console.log(`  [parti] ${pad2(race.no)}R ${raceKey} 未入库：结果页仅列出 ${parsed.rides.length}/${cardHeads} 匹（疑似只放出前几名）`);
        keepCached("疑似半截结果");
        continue;
      }
      const chk = checkCompleteness(joined.runners, joined.heads, {
        requirePop: parsed.hasOdds,
      });
      if (!chk.ok) {
        stats.partial++;
        console.log(`  [parti] ${pad2(race.no)}R ${raceKey} 未入库：${chk.reason} | ${JSON.stringify(chk.stats)}`);
        keepCached("完整性未通过");
        continue;
      }
      // 1 番人气与 SL 的 favourite 标记交叉校验（只告警，不拦）
      const pop1 = joined.runners.filter((r) => r.pop === 1).map((r) => r.num);
      if (parsed.hasOdds && parsed.favouriteCloth != null && !pop1.includes(parsed.favouriteCloth)) {
        console.log(`  [warn ] ${pad2(race.no)}R favourite 马号 ${parsed.favouriteCloth} 与赔率最低者 ${pop1.join(",")} 不一致`);
      }

      const rec = {
        no: race.no,
        raceKey,
        status: "result",
        heads: joined.heads,
        resultHeads: parsed.rides.length,
        joined: joined.runners.length,
        linked: joined.linked,
        hasOdds: parsed.hasOdds,
        favouriteCloth: parsed.favouriteCloth,
        stage,
        winningTime: parsed.winningTime,
        nonRunners: joined.nonRunners,
        completeness: chk.stats,
        startTime: race.startTime ?? null,
        sourceUrl: url,
        runners: joined.runners,
      };
      out.push(rec);
      stats.ok++;
      stats.linked += joined.linked;
      stats.runners += joined.runners.length;
      const win = joined.runners.find((r) => r.finish === 1);
      console.log(`  [  ok ] ${pad2(race.no)}R ${raceKey} 着顺 ${joined.runners.length} 頭 ` +
        `关联=${joined.linked} 人气=${parsed.hasOdds ? "有" : "无赔率"} 1着 ${win?.horse?.name ?? "?"} ${win?.time ?? ""}`);
    }

    if (!DRY && out.length) {
      const file = resultFile(date, trackId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        schema: "rp.race.result/v1",
        date,
        track: `rp-${trackId}`,
        trackId,
        venue: doc.venue,
        country: doc.country ?? null,
        source: "sportinglife",
        updatedAt: new Date().toISOString(),
        races: out.sort((a, b) => a.no - b.no),
      }, null, 2) + "\n");
      console.log(`[rp] 落盘 ${path.relative(process.cwd(), file)} (${out.length} 场)`);
    } else if (DRY && out.length) {
      console.log(`[rp] ${date} rp-${trackId} ${out.length} 场 [DRY 未写盘]`);
    }
  }
}

if (!DRY && stats.ok > 0) {
  const markDir = path.resolve(".workbuddy", "imports");
  try {
    fs.mkdirSync(markDir, { recursive: true });
    fs.writeFileSync(path.join(markDir, ".results-dirty"), new Date().toISOString());
  } catch {}
}

console.log(`\n[rp] 汇总 ok=${stats.ok} soft=${stats.soft} partial=${stats.partial} pending=${stats.pending} ` +
  `error=${stats.error} skipped=${stats.skipped} kept=${stats.kept} 关联马匹=${stats.linked} 落库行=${stats.runners} ` +
  `请求≈${stats.requests}${DRY ? " [DRY]" : ""}`);
