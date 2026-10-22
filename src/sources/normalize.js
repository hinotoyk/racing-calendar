// 中间映射层：各比赛源 → JBIS 主 schema（docs/DESIGN.md §8）
// 纯函数、无 IO；时区标注与单位换算集中在这里。
//
// ## 时区约定（重要）
// - Sporting Life（RP 集团数据）页面上的 `time` 一律是 **英国当地时间（Europe/London）**，
//   与场地所在国无关（实测：Abu Dhabi 13:00 = 当地 17:00、Belmont 17:10 = 当地 12:10）。
// - `date` 是 **场地当地** 的比赛日标签（Charles Town 23:00→02:17 跨英国午夜仍属同一比赛日）。
// - 因此每张卡片落盘时同时标注：
//     timeZone      —— startTime 的时区（展示口径，RP 源恒为 Europe/London）
//     localTimeZone —— 场地时区（date 标签口径）
//     startTimeInstant —— ISO8601 绝对时刻（含偏移），由 raceInstant() 消解跨日歧义
// - JBIS 源两口径一致（Asia/Tokyo）。

// ---------- 时区工具 ----------
function offsetMinutes(tz, at) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = String(part ?? "GMT+00:00").match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + (+(m[3] ?? 0)));
}

export function zoneOffsetLabel(tz, at = new Date()) {
  const mins = offsetMinutes(tz, at);
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// 按 tz 解释墙上时间 → Date（两步校正法，处理 DST）
export function instantFromZoned(y, m, d, h, min, tz) {
  let ts = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    ts = Date.UTC(y, m - 1, d, h, min) - offsetMinutes(tz, new Date(ts)) * 60000;
  }
  return new Date(ts);
}

export function zonedDate(date, tz) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}

export function isoInZone(date, tz) {
  const { date: d, time } = zonedDate(date, tz);
  return `${d}T${time}:00${zoneOffsetLabel(tz, date).replace("UTC", "")}`;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 国家/地区 → IANA 时区（场地当地口径）
export const COURSE_TZ = {
  ENG: "Europe/London", Wale: "Europe/London", SCO: "Europe/London",
  Eire: "Europe/Dublin",
  FR: "Europe/Paris",
  UAE: "Asia/Dubai",
  SAF: "Africa/Johannesburg",
  USA: "America/New_York",
  CAN: "America/Toronto",
  AUS: "Australia/Sydney",
  JPN: "Asia/Tokyo",
  HKG: "Asia/Hong_Kong",
};

const COURSE_TZ_OVERRIDE = {
  "Remington Park": "America/Chicago",
  "Horseshoe Indianapolis": "America/Indiana/Indianapolis",
  Woodbine: "America/Toronto",
};

export function courseTzOf(country, venue) {
  return COURSE_TZ_OVERRIDE[venue] ?? COURSE_TZ[country] ?? "Europe/London";
}

/**
 * 由「场地当地比赛日标签 + 源展示时间（英国当地）」求绝对时刻。
 * SL 的 date 是场地当地标签，time 是 UK 当地钟面：跨英国午夜的美国夜场，
 * 对应的英国日历日 = 标签 +1。用场地时区反推哪个解释与标签自洽。
 */
export function raceInstant(dateLabel, displayTime, courseTz, displayTz = "Europe/London") {
  const [h, min] = displayTime.split(":").map(Number);
  for (const shift of [0, 1]) {
    const ymd = addDays(dateLabel, shift).split("-").map(Number);
    const inst = instantFromZoned(ymd[0], ymd[1], ymd[2], h, min, displayTz);
    if (zonedDate(inst, courseTz).date === dateLabel) return inst;
  }
  const ymd = dateLabel.split("-").map(Number);
  return instantFromZoned(ymd[0], ymd[1], ymd[2], h, min, displayTz);
}

// ---------- 单位换算 ----------
// "2m 1f 33y" → 米（mile=1609.344, furlong=201.168, yard=0.9144）
export function ukDistanceToMeters(raw) {
  if (!raw) return null;
  let m = 0;
  const mi = raw.match(/(\d+)\s*m(?:ile)?s?\b/i);
  const fu = raw.match(/(\d+)\s*f(?:ur(?:long)?)?s?\b/i);
  const ya = raw.match(/(\d+)\s*y(?:d|ard)?s?\b/i);
  const me = raw.match(/(\d{3,4})\s*m\b/);
  if (mi) m += +mi[1] * 1609.344;
  if (fu) m += +fu[1] * 201.168;
  if (ya) m += +ya[1] * 0.9144;
  if (me && !mi && !fu) m = +me[1];
  return m ? Math.round(m) : null;
}

// "11-0"（英石-磅）→ 公斤
export function stonesToKg(raw) {
  const m = String(raw ?? "").match(/(\d+)\s*-(\d+)/);
  if (!m) return null;
  return Math.round((+m[1] * 6.35029318 + +m[2] * 0.45359237) * 10) / 10;
}

// ---------- 字段归一 ----------
// RP/SL sex.type → JBIS 性別（c=colt f=filly g=gelding m=mare h=horse r=rig）
export function sexOf(type) {
  return { c: "牡", f: "牝", g: "セ", m: "牝", h: "牡", r: "騸" }[type] ?? null;
}

// 毛色代码 → JBIS 毛色（近似对应，raw 保留在 runner.rp.colour）
export function colourOf(code) {
  return { b: "鹿毛", br: "青鹿毛", ch: "栗毛", gr: "芦毛", bl: "青毛", wh: "白毛", ro: "駁毛", pu: "粕毛" }[code] ?? null;
}

// 场地：SL surface → 芝/ダ（英国全场地的 all-weather 按惯例归 ダート）
export function surfaceOf(surfaceCode) {
  const s = String(surfaceCode ?? "").toUpperCase();
  if (!s) return null;
  if (s.includes("TURF")) return "芝";
  if (/AWT|ALL.?WEATHER|FIBRE|POLY|SAND|TAPETA/.test(s)) return "ダ";
  return null;
}

// 竞走种别（由赛名推断）：HURDLE / CHASE / NH_FLAT / FLAT
export function runTypeOf(name) {
  const n = String(name ?? "");
  if (/steeple|chase\b/i.test(n) && !/handicap chase/i.test(n)) return "CHASE";
  if (/chase/i.test(n)) return "CHASE";
  if (/hurdle/i.test(n)) return "HURDLE";
  if (/nh flat|national hunt flat|bumper/i.test(n)) return "NH_FLAT";
  return "FLAT";
}

/**
 * 比赛格归一（RP 口径 → JBIS 展示口径）：
 * - Group/Grade 1-3、Listed → GⅠ-GⅢ / L（group=重賞）
 * - Hurdle/Chase → group=障害
 * - 其余 Class 1-7 → klass="Class N"（group=一般/障害）
 */
export function klassOfRP({ name, raceClass, runType }) {
  const n = String(name ?? "");
  let gradeTag = null;
  let klass = null;
  let group = null;

  const grp = n.match(/Group\s*(\d)/i);
  const grd = n.match(/Grade\s*(\d)/i);
  if (grp) {
    gradeTag = `G${"ⅠⅡⅢ"[+grp[1] - 1] ?? grp[1]}`;
    klass = gradeTag;
    group = "重賞";
  } else if (grd) {
    gradeTag = `G${"ⅠⅡⅢ"[+grd[1] - 1] ?? grd[1]}`;
    klass = gradeTag;
    group = "重賞";
  } else if (/listed/i.test(n)) {
    gradeTag = "L";
    klass = "L";
    group = "重賞";
  } else if (raceClass) {
    klass = `Class ${raceClass}`;
  }

  const isJump = runType === "HURDLE" || runType === "CHASE";
  if (!group) group = isJump ? "障害" : "一般";
  return { klass: klass ?? (isJump ? "障害" : "一般"), klassGroup: group, gradeTag };
}
