// Racing Post 比赛源适配器（docs/DESIGN.md §8）
//
// ## 为什么抓取层是 sportinglife.com
// racingpost.com 的 WAF 对一切非浏览器客户端返回 406（页面与 /api/* 同样拦截，
// 无头浏览器以外无法直连）。racingpost.com/racecards 的同源数据（RP 集团官方）
// 在 Sporting Life（sportinglife.com，RP 旗下）完全开放，且 robots.txt 无任何
// Disallow。本适配器因此以 SL 为抓取层、按 RP 口径映射；RP 直连探测保留在
// probe() 里，若日后解封可直接切换。
//
// ## 数据窗口
// SL 的 racecards 页只提供「英国当天」的卡片（日期 URL 307 回当日页）；
// 夜场（美国等）的 race.date 标签可能是场地当地的次日，按标签落盘。
//
// ## 时区（见 normalize.js 头注）
// time = 英国当地时间；date = 场地当地比赛日；两者口径都写进卡片。
import { get, nextData } from "./http.js";
import { pedCache } from "../lib/ped-cache.js";
import {
  courseTzOf,
  colourOf,
  isoInZone,
  klassOfRP,
  raceInstant,
  runTypeOf,
  sexOf,
  stonesToKg,
  surfaceOf,
  ukDistanceToMeters,
  zonedDate,
} from "./normalize.js";

const SL = "https://www.sportinglife.com";
const INDEX_URL = `${SL}/racing/racecards`;
const DISPLAY_TZ = "Europe/London"; // SL 页面显示口径

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// 国家组 → SL country.short_name
const COUNTRY_GROUP = {
  GB: ["ENG", "Wale", "SCO"],
  IRE: ["Eire"],
  FR: ["FR"],
  UAE: ["UAE"],
  SAF: ["SAF"],
  USA: ["USA"],
  CAN: ["CAN"],
};

function racePageUrl(race, courseId, courseName, hrefMap) {
  if (hrefMap.has(race.race_summary_reference?.id)) return SL + hrefMap.get(race.race_summary_reference.id);
  return `${SL}/racing/racecards/${race.date}/${slugify(courseName)}/racecard/${race.race_summary_reference?.id}/${slugify(race.name)}`;
}

// ---------- 血统缓存（单文件包 data/pedigree/rp-horse.json，入库供 CI 增量复用） ----------
async function pedigreeOf(horseId, { store, delayMs, useCache = true, log = () => {} }) {
  if (!horseId) return null;
  if (useCache) {
    const cached = store.get(horseId);
    if (cached && "sire" in cached) return cached;
  }
  const r = await get(`${SL}/racing/profiles/horse/${horseId}`).catch(() => null);
  await sleep(delayMs);
  const j = r && r.status === 200 ? nextData(r.text) : null;
  const prof = j?.props?.pageProps?.profile;
  if (!prof) return null;
  // SL 的相对马匹 horse_reference.id 恒等于页面自身 id（数据缺陷），
  // 父/母/母父只取名字，不落 id；父父因此无法链查（记 null）。
  const rec = {
    schema: "rp.pedigree.horse/v1",
    id: horseId,
    name: prof.name,
    sire: prof.sire?.name ?? null,
    dam: prof.dam?.name ?? null,
    damsire: prof.damsire?.name ?? null,
    colour: prof.colour ?? null,
    sex: prof.sex?.type ?? null,
    foaled: prof.foaled ?? null,
    capturedAt: new Date().toISOString(),
  };
  store.set(horseId, rec);
  log(`[ped] ${prof.name} ← ${rec.sire} / ${rec.damsire}`);
  return rec;
}

// ---------- ride → canonical runner ----------
function runnerOf(ride, ped) {
  const horse = ride.horse ?? {};
  const horseId = horse.horse_reference?.id;
  return {
    num: ride.cloth_number ?? null,
    frame: null, // 英国无枠番；SL 卡片 JSON 无 draw 字段
    horse: { id: horseId ? `rp:${horseId}` : null, name: horse.name ?? null },
    sex: sexOf(horse.sex?.type),
    age: horse.age ?? null,
    color: colourOf(ride.horseColour),
    jockey: ride.jockey
      ? { id: ride.jockey.person_reference?.id ? `rp:${ride.jockey.person_reference.id}` : null, name: ride.jockey.name ?? null }
      : null,
    weight: stonesToKg(ride.handicap),
    weightRaw: ride.handicap ?? null,
    trainer: ride.trainer
      ? { id: ride.trainer.business_reference?.id ? `rp:${ride.trainer.business_reference.id}` : null, name: ride.trainer.name ?? null }
      : null,
    owner: ride.owner?.name ? { id: null, name: ride.owner.name } : null,
    breeder: null, // SL 卡片与档案均无
    sire: ped?.sire ? { id: null, name: ped.sire } : null,
    dam: ped?.dam ? { id: null, name: ped.dam } : null,
    bms: ped?.damsire ? { id: null, name: ped.damsire } : null,
    sireSire: null, // SL 相对 id 缺陷 → 父马档案无法反查（见 pedigreeOf）
    recent: (horse.previous_results ?? []).slice(0, 3).map((x) => ({
      rank: x.position != null ? `${x.position}着` : null,
      date: x.date ?? null,
      venue: x.course_name ?? null,
      raceKey: x.race_id ? String(x.race_id) : null,
      raceName: x.race_name ?? null,
      surface: null,
      distance: ukDistanceToMeters(x.distance),
      distanceRaw: x.distance ?? null,
      going: x.going ?? null,
      time: null,
      margin: null,
      odds: x.odds ?? null,
      position: x.position ?? null,
      runnerCount: x.runner_count ?? null,
      raceClass: x.race_class ?? null,
      desc: x.ride_description ?? null,
    })),
    rp: {
      formsummary: horse.formsummary?.display_text ?? null,
      lastRanDays: horse.last_ran_days ?? null,
      headgear: (ride.headgear ?? []).map((h) => h.name ?? h).filter(Boolean),
      timeformStars: ride.timeform_stars ?? null,
      rating123: ride.rating123 ?? null,
      status: ride.ride_status ?? null,
      foaled: horse.foaled ?? null,
    },
  };
}

// ---------- 连通性自检 ----------
export async function probe() {
  const out = { rpDirect: null, sl: null };
  const r1 = await get("https://www.racingpost.com/racecards/").catch(() => null);
  out.rpDirect = { status: r1?.status ?? 0, note: r1?.status === 200 ? "直连可用" : "WAF 406（预期内）→ 走 Sporting Life" };
  const r2 = await get(INDEX_URL).catch(() => null);
  const j = r2 ? nextData(r2.text) : null;
  const meetings = j?.props?.pageProps?.meetings ?? [];
  out.sl = { status: r2?.status ?? 0, meetings: meetings.length, races: meetings.reduce((n, m) => n + (m.races?.length ?? 0), 0) };
  return out;
}

// ---------- 采集 ----------
/**
 * @returns [{ date, file, doc }]  doc = canonical race.card/v2（字段名以 JBIS 为主）
 */
export async function collect({
  countries = ["GB", "IRE"], // ["GB","IRE",...] 或 "all"
  tracks = null, // [课程名/shortcode 小写比对] 或 null
  limit = 0, // 最多抓取场次数（0 = 不限）
  delayMs = 1200,
  pedigree = true, // 是否抓马匹档案补 父/母/母父
  fs, path,
  log = console.log,
}) {
  // "all" 兼容字符串与数组（CLI 归一化后可能传 ["all"]）
  const isAll = countries === "all" || (Array.isArray(countries) && countries.map((c) => String(c).toLowerCase()).includes("all"));
  const wanted = isAll
    ? null
    : countries.flatMap((c) => COUNTRY_GROUP[String(c).toUpperCase()] ?? [String(c).toUpperCase()]);

  // 血统缓存单文件包（入库 → CI 增量复用，见 lib/ped-cache.js）
  const store = pedCache(path.resolve("data", "pedigree", "rp-horse.json"));

  // 1) 当日 index：会议 + 场次 meta + 单场链接
  const page = await get(INDEX_URL);
  await sleep(delayMs);
  const j = nextData(page.text);
  const meetings = j?.props?.pageProps?.meetings ?? [];
  if (!meetings.length) throw new Error("SL racecards: 无会议数据（页面结构可能变更）");

  // 单场链接（race id → path），Next 路由需要
  const hrefMap = new Map();
  for (const m of [...page.text.matchAll(/href="(\/racing\/racecards\/[^"]*\/racecard\/(\d+)[^"]*)"/g)]) {
    hrefMap.set(Number(m[2]), m[1]);
  }

  // 2) 会议过滤
  const picked = meetings.filter((mt) => {
    const cs = mt.meeting_summary?.course;
    if (!cs) return false;
    if (wanted && !wanted.includes(cs.country?.short_name)) return false;
    if (tracks && !tracks.some((t) => String(t).toLowerCase() === cs.name.toLowerCase() || String(t).toLowerCase() === String(cs.course_shortcode ?? "").toLowerCase())) return false;
    return true;
  });
  log(`[index] ${meetings.length} 会议 → 选中 ${picked.length}（countries=${countries}）`);

  const byDate = new Map(); // dateLabel → races[]
  let fetched = 0;

  for (const mt of picked) {
    const cs = mt.meeting_summary.course;
    const courseId = cs.course_reference?.id;
    const tz = courseTzOf(cs.country?.short_name, cs.name);
    const races = [...(mt.races ?? [])].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));

    for (const [i, race] of races.entries()) {
      if (limit && fetched >= limit) break;
      fetched++;

      const url = racePageUrl(race, courseId, cs.name, hrefMap);
      const rp = await get(url).catch(() => null);
      await sleep(delayMs);
      const rj = rp && rp.status === 200 ? nextData(rp.text) : null;
      const rides = rj?.props?.pageProps?.race?.rides ?? [];
      const raceId = race.race_summary_reference?.id;

      // 血统补全（本场合计的每匹马一次）
      const runners = [];
      for (const ride of rides) {
        const horseId = ride.horse?.horse_reference?.id;
        const ped = pedigree && horseId ? await pedigreeOf(horseId, { store, delayMs, log }) : null;
        runners.push(runnerOf(ride, ped));
      }

      const raceType = runTypeOf(race.name);
      const k = klassOfRP({ name: race.name, raceClass: race.race_class, runType: raceType });
      const inst = race.time ? raceInstant(race.date, race.time, tz, DISPLAY_TZ) : null;

      byDate.set(race.date, byDate.get(race.date) ?? new Map());
      const slot = byDate.get(race.date);
      if (!slot.has(courseId)) {
        slot.set(courseId, {
          schema: "race.card/v2",
          source: "racingpost",
          fetchLayer: "sportinglife.com",
          sourceKey: `rp:${courseId}`,
          date: race.date,
          track: race.course_shortcode ?? cs.course_shortcode ?? slugify(cs.name),
          trackId: courseId,
          venue: cs.name,
          country: cs.country?.short_name ?? null,
          countryLong: cs.country?.long_name ?? null,
          scope: "overseas",
          timeZone: DISPLAY_TZ, // startTime 的时区（展示口径）
          localTimeZone: tz, // date 标签口径（场地当地）
          going: mt.meeting_summary?.going ?? null,
          surfaceRaw: mt.meeting_summary?.surface_summary ?? cs.surface_summary ?? null,
          sourceUrl: url,
          capturedAt: new Date().toISOString(),
          races: [],
        });
      }
      const doc = slot.get(courseId);
      doc.races.push({
        no: i + 1,
        startTime: race.time ?? null,
        startTimeTz: DISPLAY_TZ,
        startTimeInstant: inst ? isoInZone(inst, DISPLAY_TZ) : null,
        startTimeLocal: inst ? zonedDate(inst, tz).time : null, // 场地当地钟面
        name: race.name ?? null,
        surface: surfaceOf(race.course_surface?.surface),
        distance: ukDistanceToMeters(race.distance),
        distanceRaw: race.distance ?? null,
        heads: race.ride_count ?? null,
        klass: k.klass,
        klassGroup: k.klassGroup,
        gradeTag: k.gradeTag,
        raceClass: race.race_class ?? null,
        raceType,
        raceKey: raceId ? String(raceId) : null,
        raceStage: race.race_stage ?? null,
        status: runners.length ? "entries" : "pending",
        runners,
      });
      log(`[race] ${race.date} ${cs.name} R${i + 1} ${race.time} ${race.name} — ${runners.length} 頭`);
    }
    if (limit && fetched >= limit) break;
  }

  // 3) 展开为落盘单元（血统缓存包落盘）
  store.save();
  log(`[ped-cache] rp-horse ${store.size()} 匹 → data/pedigree/rp-horse.json`);
  const out = [];
  for (const [date, courses] of byDate) {
    for (const doc of courses.values()) {
      out.push({ date, file: `rp-${doc.trackId}.json`, doc });
    }
  }
  return out;
}
