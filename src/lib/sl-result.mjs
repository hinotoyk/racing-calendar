// Sporting Life 结果页解析（欧美源，纯函数）
// 与日本源不同：SL 是 Next.js __NEXT_DATA__（UTF-8 JSON），无 HTML 模板、无 EUC-JP、无代理；
// 结果页 rides[] 自带 cloth_number + finish_position + 最终赔率 → 不需要额外出馬表做马级关联。
import { nextData } from "../sources/http.js";

export const SL = "https://www.sportinglife.com";
export const slugify = (s) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const dayUrl = (date) => `${SL}/racing/results/${date}`;
// 四段 URL，末段任意 slug（实测 `x` 可用）；省略或写 racecard 会 404
export const resultUrl = (date, course, raceId) =>
  `${SL}/racing/results/${date}/${slugify(course)}/${raceId}/x`;

export const FINISHED_STAGES = new Set(["WEIGHEDIN", "RESULT"]);

// ---------- 日级枚举：1 请求/天，raceId 与本地 rp 卡片的 raceKey 是同一套 id ----------
export function parseSlDay(html) {
  const j = nextData(html);
  const meetings = j?.props?.pageProps?.meetings ?? [];
  const map = new Map();
  for (const m of meetings) {
    const course = m?.meeting_summary?.course ?? {};
    for (const r of m?.races ?? []) {
      const id = String(r?.race_summary_reference?.id ?? "");
      if (!/^\d+$/.test(id)) continue;
      map.set(id, {
        raceId: id,
        stage: r.race_stage ?? null,
        course: r.course_name ?? course.name ?? null,
        country: r.country_short_name ?? course.country?.short_name ?? null,
        trackId: course.course_reference?.id ?? null,
        winningTime: r.winning_time ?? null,
        offTime: r.off_time ?? null,
        topHorses: r.top_horses ?? [],
      });
    }
  }
  return map;
}

// ---------- 分数赔率 → 小数（英国式 a/b：押 b 赢 a；+1 为总回报，不影响排序） ----------
export function oddsToDecimal(s) {
  const t = String(s ?? "").trim();
  if (!t || /^no forecast/i.test(t)) return null;
  if (/^evs|^even/i.test(t)) return 2;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const d = Number(m[2]);
    return d ? 1 + Number(m[1]) / d : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? 1 + n : null;
}

// 人气：按最终赔率升序；同赔率并列并跳号（与日本源「同着」游标规则一致）
export function popularityOf(rides) {
  const withOdds = rides
    .filter((r) => r.decimalOdds != null && r.rideStatus !== "NONRUNNER")
    .map((r) => ({ cloth: r.cloth, d: r.decimalOdds }));
  withOdds.sort((a, b) => a.d - b.d || String(a.cloth ?? "").localeCompare(String(b.cloth ?? "")));
  const map = new Map();
  let rank = 1;
  let i = 0;
  while (i < withOdds.length) {
    let j = i + 1;
    while (j < withOdds.length && Math.abs(withOdds[j].d - withOdds[i].d) < 1e-9) j++;
    for (let k = i; k < j; k++) map.set(withOdds[k].cloth, rank);
    rank += j - i;
    i = j;
  }
  return map;
}

// 异常态 → 与日本源一致的单字（中/失/落/除/取/止/未，见 lib/abnormal-finish.js）。
// 判定严格分层：源站明确 reason 优先，其次用 ride_description 关键词，
// 两者都无 → 「未」（未完赛、原因未公布），绝不臆断为中止或失格。
const CASUALTY = {
  PulledUp: "中",
  Disqualified: "失",
  Fell: "落", UnseatedRider: "落", BroughtDown: "落", SlippedUp: "落",
  Refused: "止", RefusedToRace: "止", RanOut: "止",
};
const DESC_RULE = [
  [/withdraw|non[- ]?runner/i, "取"],
  [/disqualif|\bDQ\b/i, "失"],
  [/pulled up|\bPU\b/i, "中"],
  [/\bfell\b|unseat|brought down|slipped/i, "落"],
  [/refus|ran out/i, "止"],
];
export function abnormalOf(ride) {
  if (ride.rideStatus === "NONRUNNER") return "除";
  if (ride.casualty && CASUALTY[ride.casualty]) return CASUALTY[ride.casualty];
  const desc = String(ride.comment ?? "");
  for (const [re, code] of DESC_RULE) if (re.test(desc)) return code;
  return "未";
}

// 判定依据写入结果文件，供前端 tooltip 解释「为什么是中止/失格/未完赛」
export function abnormalReasonOf(ride) {
  if (ride.rideStatus === "NONRUNNER") return "ride_status=NONRUNNER";
  if (ride.casualty) return `casualty.reason=${ride.casualty}`;
  const desc = String(ride.comment ?? "").trim();
  if (!desc) return "Sporting Life 未公布原因";
  return `ride_description: ${desc.slice(0, 160)}`;
}

// ---------- 单场：1 请求/场，全序着顺 + 异常态 + 最终赔率 ----------
export function parseSlResult(html) {
  const j = nextData(html);
  const race = j?.props?.pageProps?.race;
  if (!race?.rides) return null;
  const summary = race.race_summary ?? {};
  const forecast = String(race.betting_forecast ?? "");
  const rides = race.rides.map((r) => {
    const betting = r.betting ?? {};
    const odds = betting.current_odds ?? null;
    return {
      cloth: r.cloth_number ?? null,
      draw: r.draw_number ?? null,
      finish: typeof r.finish_position === "number" && r.finish_position > 0 ? r.finish_position : 0,
      rideStatus: r.ride_status ?? null,
      horseId: r.horse?.horse_reference?.id ?? null,
      name: r.horse?.name ?? null,
      odds,
      decimalOdds: oddsToDecimal(odds),
      favourite: betting.favourite?.betting_favourite === "f",
      casualty: r.casualty?.reason ?? null,
      comment: r.ride_description ?? r.commentary ?? null,
    };
  });
  const pop = popularityOf(rides);
  return {
    raceId: String(summary.race_summary_reference?.id ?? ""),
    stage: summary.race_stage ?? null,
    course: summary.course_name ?? null,
    date: summary.date ?? null,
    winningTime: summary.winning_time ?? null,
    bettingForecast: forecast,
    // 中国香港等场次明确 "No Forecast Available." 且无 current_odds → 人气不可推算，但着顺仍可入库
    hasOdds: !/^no forecast/i.test(forecast) && rides.some((r) => r.decimalOdds != null),
    favouriteCloth: rides.find((r) => r.favourite)?.cloth ?? null,
    rides: rides.map((r) => ({ ...r, pop: pop.get(r.cloth) ?? null })),
  };
}
