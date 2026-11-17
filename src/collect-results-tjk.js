// 土耳其源（TJK）赛果增量采集：官方 CSV 一城市一次请求 → 按场次号对齐本地卡片 → 按马名+闸位关联 → 落 tjk-*.json
//
// 与另两个源的差别：
//   · 日本源：1 场 2 请求（结果页 + 出馬表回填马名）；欧美源：1 场 1 请求；
//     **TJK：1 城市 1 请求**（官方 GunlukYarisSonuclari CSV 一次含全天所有场次全序着顺），最省。
//   · CSV 首列是**着顺不是马号**（源按名次排列，退出马占末位序号），且不带宽距/通过顺，
//     因此对齐只能靠马名（CSV 马名带装备码 `B H TT E` → 逐级剥离匹配本地纯马名）+ 闸位消歧。
//   · 走 CDN 官方导出（medya-cdn.tjk.org，无 robots 限制），不碰 tjk.org 的比赛页。
//
// 用法：
//   node src/collect-results-tjk.js --dates 2026-11-15 --tracks 3 --dry   # 试跑不写盘
//   node src/collect-results-tjk.js --days 1 --settle-min 10              # 定时任务：今天+昨天
//   node src/collect-results-tjk.js --until 2026-11-15                    # 回填到某日
// 发送前预过滤：先只读 data/races + data/results 算「已开赛且未完整入库」的场次，
//   整个城市都没有待抓时连 CSV 都不发 → 0 请求（日志打 [prefilter]）。
import fs from "node:fs";
import path from "node:path";
import { readGz } from "./lib/bundle.js";
import { checkCompleteness } from "./lib/result-completeness.js";
import { fetchResultCsv } from "./sources/tjk.js";

const DATA_DIR = path.resolve("data", "races");
const RESULTS_DIR = path.resolve("data", "results");
const TZ = "Europe/Istanbul";

// ---------- CLI ----------
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const DRY = has("--dry");
const FORCE = has("--force");
const TODAY = has("--today");
const LIMIT = parseInt(val("--limit", "0"), 10);
const DAYS = parseInt(val("--days", "2"), 10);
const DELAY = parseInt(val("--delay", "800"), 10);
const SETTLE_MIN = parseInt(val("--settle-min", "10"), 10);
const UNTIL = val("--until");
const DATES = (val("--dates", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const TRACKS = (val("--tracks", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

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
const dates = DATES.length
  ? DATES
  : TODAY
    ? [todayInTz()]
    : UNTIL
      ? fs.readdirSync(DATA_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && n <= UNTIL).sort()
      : Array.from({ length: Math.max(0, DAYS) + 1 }, (_, i) => addDays(todayInTz(), -DAYS + i));

function raceStarted(race) {
  const ms = race.startTimeInstant ? Date.parse(race.startTimeInstant) : NaN;
  if (!Number.isFinite(ms)) return true; // 无绝对时刻 → 交给完整性校验兜底
  return ms + SETTLE_MIN * 60 * 1000 < Date.now();
}

function readJson(file) {
  try {
    return JSON.parse(file.endsWith(".gz") ? readGz(file) : fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const readDoc = (date, file) => readJson(path.join(DATA_DIR, date, file));
const resultFile = (date, trackId) => path.join(RESULTS_DIR, date, `tjk-${trackId}.json`);

// ---------- 马名匹配：CSV 名带装备码（B / H / TT / E / CP / SGKR …），本地是纯马名 ----------
// 两侧还要剥掉命名上的一处差异：出馬表马名带产地括注（AYTOR (IRE)），赛果 CSV 不带。
// 从尾部逐级剥离（最多 4 层）直到命中本地名字；同名多匹时用闸位消歧。
const normName = (s) =>
  String(s ?? "").trim().replace(/\s+/g, " ").replace(/\s*\([A-Z]{2,4}\)$/, "").trim();
function sameName(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  return x === y || x.toUpperCase() === y.toUpperCase();
}

function matchRunner(row, localRunners, used) {
  const toks = normName(row.nameRaw).split(" ");
  const maxCut = Math.min(4, toks.length - 1);
  for (let cut = 0; cut <= maxCut; cut++) {
    const name = toks.slice(0, toks.length - cut).join(" ");
    const hits = localRunners.filter((r) => !used.has(r.num) && sameName(r.horse?.name, name));
    if (!hits.length) continue;
    if (hits.length === 1) return { runner: hits[0], cut };
    const byGate = hits.find((r) => r.tjk?.gate != null && r.tjk.gate === row.gate);
    return { runner: byGate ?? hits[0], cut, ambiguous: hits.length };
  }
  return null;
}

function joinRunners(csvRace, race) {
  const localRunners = race.runners ?? [];
  const used = new Set();
  const runners = [];
  const unmatched = [];
  let gearStripped = 0;
  let ambiguous = 0;

  for (const row of csvRace.rows) {
    const hit = matchRunner(row, localRunners, used);
    if (!hit) {
      unmatched.push({ finish: row.finish, name: row.nameRaw, gate: row.gate });
      continue;
    }
    if (hit.cut > 0) gearStripped++;
    if (hit.ambiguous > 1) ambiguous++;
    used.add(hit.runner.num);
    const local = hit.runner;
    runners.push({
      num: local.num,
      frame: local.frame ?? null,
      horse: { id: local.horse?.id ?? null, name: local.horse?.name ?? null },
      finish: row.finish,
      abnormal: typeof row.finish === "string" ? row.finish : null,
      abnormalReason: typeof row.finish === "string" ? "官方 CSV 标注 Withdrawn（未出赛）" : null,
      pop: row.agfRank, // 人气 = AGF 排名（与日本源 pop 同义）
      winOdds: row.winOdds,
      time: row.time,
      margin: row.margin,
      passing: null, // TJK 不公布通过顺
      last3f: null, // 无上がり3F
      bodyWeight: null, // 无马体重
      bodyDelta: null,
      weight: row.weight, // 负重（与出馬表同口径）
      weightOver: row.weightOver,
      rating: row.rating, // RT 让赛评分
      gate: row.gate, // 闸位（含 DS 改外枠）
      outerStart: row.outerStart,
      favourite: row.agfRank === 1 ? true : null,
      comment: null,
      finishRank: row.finishRank, // 源里的行序号（含退出马占位），供排查
    });
  }

  // 结果表没列出的本地马（正常不应出现）→ 记下来，供 --debug 排查
  const missing = localRunners.filter((r) => r.num != null && !used.has(r.num)).map((r) => r.num);
  runners.sort((a, b) => (a.num ?? 99) - (b.num ?? 99));
  return { runners, unmatched, missing, gearStripped, ambiguous, heads: runners.length };
}

// ---------- 主流程 ----------
const stats = {
  ok: 0, soft: 0, partial: 0, pending: 0, error: 0, skipped: 0, kept: 0,
  cities: 0, requests: 0, linked: 0, runners: 0, unmatched: 0,
};
let budget = LIMIT > 0 ? LIMIT : Infinity;

for (const date of dates) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir) || budget <= 0) continue;
  const files = fs.readdirSync(dir)
    .filter((f) => /^tjk-[\w-]+\.json(\.gz)?$/.test(f))
    .filter((f) => !TRACKS.length || TRACKS.some((t) => f.startsWith(`tjk-${t}.`)))
    .sort();
  if (!files.length) continue;

  // ① 本地预过滤（0 请求）
  const plans = [];
  for (const file of files) {
    const doc = readDoc(date, file);
    if (!doc?.races?.length) continue;
    const trackId = String(doc.trackId ?? file.replace(/^tjk-|\.json(\.gz)?$/g, ""));
    const prev = readJson(resultFile(date, trackId));
    const prevByKey = new Map((prev?.races ?? []).map((r) => [String(r.raceKey), r]));
    const todo = doc.races.filter((r) => {
      if (!/^\d+$/.test(String(r.raceKey ?? ""))) return false;
      if (!raceStarted(r)) return false;
      const cached = prevByKey.get(String(r.raceKey));
      return FORCE || !(cached?.status === "result" && checkCompleteness(
        cached.runners, cached.heads ?? cached.runners?.length ?? 0,
        { requirePop: cached.hasOdds !== false }
      ).ok);
    });
    plans.push({ doc, trackId, prevByKey, todo });
  }
  const needTotal = plans.reduce((n, p) => n + p.todo.length, 0);
  const raceTotal = plans.reduce((n, p) => n + p.doc.races.length, 0);
  // 未开赛的场次：只在日志里报个数，不算待抓
  const notStarted = plans.reduce((n, p) => n + p.doc.races.filter((r) => !raceStarted(r)).length, 0);
  if (!needTotal) {
    if (plans.length) {
      console.log(`[prefilter] ${date} 卡片 ${raceTotal} 场（${notStarted} 场未开赛），无待抓 → 0 请求`);
    }
    continue;
  }
  console.log(`[prefilter] ${date} 待抓 ${needTotal} 场 / 卡片 ${raceTotal} 场（${notStarted} 场未开赛）`);

  for (const plan of plans) {
    if (budget <= 0) break;
    const { doc, trackId, prevByKey, todo } = plan;
    if (!todo.length) continue;
    budget--;

    const todoKeys = new Set(todo.map((r) => String(r.raceKey)));
    // 城市级：已入库且完整的场次原样保留，只补缺的
    const out = doc.races
      .filter((r) => !todoKeys.has(String(r.raceKey)))
      .map((r) => prevByKey.get(String(r.raceKey)))
      .filter((x) => x?.status === "result");
    console.log(`[tjk] ${date} tjk-${trackId} ${doc.venue} (${doc.country}) 待抓 ${todo.length} 场 / 已入库 ${prevByKey.size}`);

    let got = null;
    try {
      got = await fetchResultCsv(date, doc.venue);
      stats.requests++;
      stats.cities++;
      await sleep(DELAY);
    } catch (e) {
      stats.error++;
      console.log(`  [error] ${date} ${doc.venue}: ${e.message}`);
      keepPrev(prevByKey, out, todoKeys, "抓取异常");
      continue;
    }
    if (!got?.races?.length) {
      stats.soft++;
      console.log(`  [soft ] ${date} ${doc.venue} 赛果 CSV 不存在 / 为空（可能当天未跑完或城市名不对）`);
      keepPrev(prevByKey, out, todoKeys, "软空");
      continue;
    }
    console.log(`[tjk] ${date} ${doc.venue} CSV ${got.races.length} 场`);

    const csvByNo = new Map(got.races.map((r) => [r.no, r]));
    let wrote = 0;
    for (const race of doc.races) {
      const raceKey = String(race.raceKey ?? "");
      if (!/^\d+$/.test(raceKey)) continue;
      const csvRace = csvByNo.get(race.no);
      const prevRec = prevByKey.get(raceKey);

      if (!todoKeys.has(raceKey)) {
        if (prevRec?.status === "result") out.push(prevRec);
        continue;
      }
      if (!csvRace) {
        stats.pending++;
        console.log(`  [wait ] ${pad2(race.no)}R ${raceKey} CSV 无该场次 → 下轮重抓`);
        if (prevRec?.status === "result") out.push(prevRec);
        continue;
      }

      const joined = joinRunners(csvRace, race);
      const numeric = joined.runners.filter((r) => typeof r.finish === "number").length;
      const popCovered = joined.runners.filter((r) => typeof r.finish === "number" && r.pop != null).length;
      const hasOdds = joined.runners.length > 0 && popCovered / Math.max(1, numeric) >= 0.8;

      const cardHeads = race.heads ?? race.runners?.length ?? 0;
      // 半截结果：CSV 只写了前几名（源头边跑边刷）→ 不入库
      if (cardHeads && joined.runners.length < cardHeads - 2) {
        stats.partial++;
        console.log(`  [parti] ${pad2(race.no)}R ${raceKey} 未入库：CSV 仅 ${joined.runners.length}/${cardHeads} 頭`);
        if (prevRec?.status === "result") out.push(prevRec);
        continue;
      }
      const chk = checkCompleteness(joined.runners, cardHeads, { requirePop: hasOdds });
      if (!chk.ok) {
        stats.partial++;
        console.log(`  [parti] ${pad2(race.no)}R ${raceKey} 未入库：${chk.reason} | ${JSON.stringify(chk.stats)}`);
        if (prevRec?.status === "result") out.push(prevRec);
        continue;
      }

      out.push({
        no: race.no,
        raceKey,
        status: "result",
        heads: cardHeads,
        resultHeads: csvRace.rows.length,
        joined: joined.runners.length,
        linked: joined.runners.length - joined.missing.length,
        hasOdds,
        stage: "FINAL", // 官方 CSV 只在定稿后生成
        winningTime: csvRace.winningTime,
        distance: csvRace.distance,
        surface: csvRace.surface,
        klassCode: csvRace.klassCode,
        startTime: race.startTime ?? csvRace.startTime ?? null,
        unmatched: joined.unmatched,
        missing: joined.missing,
        gearStripped: joined.gearStripped,
        ambiguous: joined.ambiguous,
        completeness: chk.stats,
        sourceUrl: got.url,
        runners: joined.runners,
      });
      wrote++;
      stats.ok++;
      stats.runners += joined.runners.length;
      stats.linked += joined.runners.length - joined.missing.length;
      stats.unmatched += joined.unmatched.length;
      const win = joined.runners.find((r) => r.finish === 1);
      console.log(`  [  ok ] ${pad2(race.no)}R ${raceKey} 着顺 ${joined.runners.length} 頭 ` +
        `${hasOdds ? "人气✓" : "无人气"} 1着 ${win?.horse?.name ?? "?"} ${win?.time ?? ""}` +
        (joined.unmatched.length ? ` ⚠未匹配 ${joined.unmatched.map((x) => x.name).join(",")}` : "") +
        (joined.missing.length ? ` ⚠缺 ${joined.missing.join(",")}` : ""));
    }

    if (!out.length) continue;
    const rec = {
      schema: "tjk.race.result/v1",
      date,
      track: `tjk-${trackId}`,
      trackId,
      venue: doc.venue,
      country: doc.country ?? "TUR",
      source: "tjk",
      updatedAt: new Date().toISOString(),
      races: out.sort((a, b) => a.no - b.no),
    };
    if (DRY) {
      console.log(`[tjk] ${date} tjk-${trackId} ${out.length} 场 [DRY 未写盘]`);
    } else {
      const file = resultFile(date, trackId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
      console.log(`[tjk] 落盘 ${path.relative(process.cwd(), file)}（${out.length} 场 / 本轮新入库 ${wrote} 场）`);
    }
  }
}

// 重抓失败时沿用已入库记录（否则 --force 一次软空就会把已入库结果冲成空）
function keepPrev(prevByKey, out, todoKeys, tag) {
  for (const [key, rec] of prevByKey) {
    if (!todoKeys.has(key)) continue;
    if (rec?.status !== "result") continue;
    out.push(rec);
    stats.kept++;
    console.log(`  [keep ] ${key} ${tag}：沿用已入库结果`);
  }
}

if (!DRY && stats.ok > 0) {
  const markDir = path.resolve(".workbuddy", "imports");
  try {
    fs.mkdirSync(markDir, { recursive: true });
    fs.writeFileSync(path.join(markDir, ".results-dirty"), new Date().toISOString());
  } catch {}
}

console.log(`\n[tjk] 汇总 ok=${stats.ok} soft=${stats.soft} partial=${stats.partial} pending=${stats.pending} ` +
  `error=${stats.error} kept=${stats.kept} 城市=${stats.cities} 关联马匹=${stats.linked} 落库行=${stats.runners} ` +
  `未匹配=${stats.unmatched} 请求≈${stats.requests}${DRY ? " [DRY]" : ""}`);
