// Racing Australia（澳官方 racingaustralia.horse /FreeFields/）比赛源适配器（docs/DESIGN.md §8）
//
// ## 站点结构（2026-11-18 实测，详见《澳大利亚+新西兰赛马出走表免费获取方案.md》）
// - 八州日历 `Calendar.aspx?State={NSW|VIC|QLD|WA|SA|TAS|ACT|NT}`：一页列未来约 10 天，
//   每场按当前阶段给链接 `href="/FreeFields/{Page}.aspx?Key=2026Nov18,NSW,Warwick Farm"`，
//   Key 格式完全可预测（`YYYYMonDD,州,赛场`，URL 编码逗号/空格）。
//   阶段优先级：Form(全字段主抓页) > Acceptances(仅出马行) > Weights > Nominations。
// - `Form.aspx?Key=...`：每场一页含全部场次：
//   * 正式出马行 `<td class="no|last|horse|trainer|jockey|barrier|weight|penalty|penalty|hcp">`
//   * 每马资料块（class="horse-number" + horse-name + class="plain"）：
//     "4 year old bay or brown gelding (17-10-2022) Sire: ... Dam: ... (母父) Breeder: ... Owners: ..."
//     → 年龄/性别/毛色/出生日/父/母/母父/马主/生产牧场 全免费同页可得（实测覆盖 87-100%）
//   * 含 Gear Changes（装备变更）与 Scratched（退赛）。
// - Form 无出马行（阶段不足/已完赛）→ 回退 Acceptances.aspx。
//
// ## 反爬实测（重要教训）
// - Zenedge 防护会往**所有正常页面**注入 `<script src="/__zenedge/assets/hic.js">`
//   —— 「页面里有 __zenedge 字样」不是挑战页判据（2026-11-18 曾因此误判整轮限流）。
//   真挑战页 = "Are you human?" 文本（约 9KB 空壳、无 Key 链接）。
// - 高频触发真挑战：100+ 请求/2.5h 后进入小时级观察名单 → 生产 CI 单次 ≤15 页、间隔 ≥5s。
//
// ## 时区
// 各州 IANA：NSW/ACT=Sydney, VIC=Melbourne, QLD=Brisbane, SA=Adelaide, WA=Perth, TAS=Hobart, NT=Darwin。
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";
import { instantFromZoned, isoInZone } from "./normalize.js";

export const id = "racingaustralia";
export const label = "Racing Australia";
export const homeUrl = "https://racingaustralia.horse/";

const BASE = "https://racingaustralia.horse/FreeFields";
const TAG = "ra";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
const STATE_TZ = {
  NSW: "Australia/Sydney", ACT: "Australia/Sydney",
  VIC: "Australia/Melbourne", QLD: "Australia/Brisbane",
  SA: "Australia/Adelaide", WA: "Australia/Perth",
  TAS: "Australia/Hobart", NT: "Australia/Darwin",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- 文本工具 ----------
const decodeEnt = (s) =>
  String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const strip = (s) => decodeEnt(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const clean = (s) => strip(s) || null;
const num = (s) => {
  const m = String(s ?? "").replace(/\s/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// "2026Nov18" → "2026-11-18"
export function isoFromKey(k) {
  const m = String(k).match(/^(\d{4})([A-Za-z]{3})(\d{1,2})/);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x === m[2]);
  return mon >= 0 ? `${m[1]}-${String(mon + 1).padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

// ---------- 抓取层（真挑战页检测 + 退避） ----------
// Zenedge 往所有正常页注入 __zenedge 脚本 → 只认 "Are you human?" 文本为挑战判据
const isChallenge = (html) => !!html && /Are you human\?/i.test(html);
async function fetchRa(url, { attempts = 3, src = TAG } = {}) {
  for (let i = 0; ; i++) {
    let html = null;
    try {
      html = await fetchHtmlSoft(url, { src, ua: BROWSER_UA, retries: 1 });
    } catch (e) {
      if (i + 1 >= attempts) throw e;
      await sleep(30000);
      continue;
    }
    if (!isChallenge(html)) return html;
    if (i + 1 >= attempts) throw new Error("RA challenge page (rate limited)");
    console.log(`    [RA] 挑战页 → 退避 60s 后重试（${i + 1}/${attempts - 1}）`);
    await sleep(60000);
  }
}

// ---------- 字段映射 ----------
const SEX_JP = { gelding: "セ", mare: "牝", filly: "牝", colt: "牡", entire: "牡", horse: "牡" };
const COLOUR_JP = {
  bay: "鹿毛", brown: "青鹿毛", black: "青毛", chestnut: "栗毛",
  grey: "芦毛", roan: "駁毛", buckskin: "栃栗毛", palomino: "帕洛米诺", white: "白毛",
};
// "4 year old bay or brown gelding (17-10-2022)" / "3 year old grey-bay gelding (14-9-2023)"
// （日/月可为 1-2 位数字）
const SEX_WORDS = ["gelding", "mare", "filly", "colt", "entire", "horse", "brown"];
const COLOUR_WORDS = ["bay", "brown", "black", "chestnut", "grey", "roan", "buckskin", "palomino", "white"];
export function parseProfileDesc(desc) {
  const m = desc.match(/(\d+)\s*year\s*old\s+(.*?)\s*\((\d{1,2})-(\d{1,2})-(\d{4})\)/i);
  if (!m) return {};
  const rest = m[2].toLowerCase();
  const out = { age: Number(m[1]), foaled: `${m[5]}-${m[4].padStart(2, "0")}-${m[3].padStart(2, "0")}` };
  const words = rest.split(/\s+or\s+|-|\s+/);
  out.colour = words.filter((w) => COLOUR_WORDS.includes(w)).join(" / ") || null;
  out.sex = words.find((w) => SEX_WORDS.includes(w)) ?? null;
  return out;
}

// 「Zed (NZ)」→ { name, country }
export function nameCountry(s) {
  const t = clean(s);
  if (!t) return null;
  const m = t.match(/^(.*?)[\s]*\(([A-Z]{2,3})\)\s*$/);
  return m ? { name: clean(m[1]), country: m[2] } : { name: t, country: null };
}

function klassOf(...texts) {
  const n = texts.filter(Boolean).join(" ");
  const g = n.match(/Group\s*([123])/i) || n.match(/\bG\s*([123])\b/);
  if (g) return { klass: `G${"ⅠⅡⅢ"[+g[1] - 1]}`, klassGroup: "重賞", gradeTag: `G${"ⅠⅡⅢ"[+g[1] - 1]}` };
  if (/\bListed\b/i.test(n)) return { klass: "L", klassGroup: "重賞", gradeTag: "L" };
  return { klass: null, klassGroup: "一般", gradeTag: null };
}

// ---------- 八州日历 ----------
export function parseCalendar(html) {
  const out = [];
  const re = /href="\/FreeFields\/(\w+)\.aspx\?Key=([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const key = decodeEnt(m[2]).replace(/%2C/gi, ",").replace(/%20/gi, " ");
    const [d, state, venue] = key.split(",");
    const date = isoFromKey(d);
    if (!date || !state || !venue) continue;
    out.push({ date, state, venue, stage: m[1] });
  }
  return out;
}

/**
 * 八州日历 → 目标日期的 meeting 列表（同场按阶段去重，保留最高阶段供回退选页）
 * @returns [{ date, state, venue, stage }]
 */
export async function collectAuMeetings(dates, { delayMs = 5000, log = console.log } = {}) {
  const seen = new Map();
  for (const st of AU_STATES) {
    await sleep(delayMs);
    let html = null;
    try {
      html = await fetchRa(`${BASE}/Calendar.aspx?State=${st}`, { src: `${TAG}-cal` });
    } catch (e) {
      log(`  [cal] ${st}: FAIL ${e.message}`);
      continue;
    }
    const rank = { Form: 4, Acceptances: 3, Weights: 2, Nominations: 1 };
    for (const it of parseCalendar(html ?? "")) {
      if (!dates.includes(it.date)) continue;
      const id = `${it.date}|${it.state}|${it.venue}`;
      const prev = seen.get(id);
      if (!prev || (rank[it.stage] ?? 0) > (rank[prev.stage] ?? 0)) seen.set(id, it);
    }
  }
  return [...seen.values()];
}

// ---------- Form/Acceptances 页解析 ----------
/** 分场（<span>Race N ...</span>）→ 出马行 + 每马资料块 */
export function parseRaForm(html) {
  const races = [];
  const spans = [...html.matchAll(/<span[^>]*>\s*(Race\s+\d+[^<]*)<\/span>/gi)];
  for (let i = 0; i < spans.length; i++) {
    // Form 页 span 内只有 "Race N"，时间/赛名/距离在 span 后的下一个元素（"- 2:55PM TAB PLATE (1200 METRES)"）；
    // Acceptances 页整个头部都在 span 内。合并两种来源，窗口截到 "Times displayed"/奖金行。
    const inline = strip(spans[i][1]);
    const start = spans[i].index + spans[i][0].length;
    const end = i + 1 < spans.length ? spans[i + 1].index : undefined;
    const win = strip(html.slice(start, end)).split(/Times displayed|Of \$|Prize/i)[0];
    const head = `${inline} ${win}`.trim();
    const no = Number(head.match(/Race\s+(\d+)/i)?.[1]);
    const rest = head.replace(/^Race\s+\d+\s*-?\s*/i, "");
    const time12 = rest.match(/\d{1,2}:\d{2}\s*(?:AM|PM)/i)?.[0] ?? null;
    const name = rest.replace(/\d{1,2}:\d{2}\s*(?:AM|PM)\s*/i, "").replace(/\s*\(\d+\s*METRES\)\s*$/i, "").trim() || null;
    const distance = num(rest.match(/\((\d{3,4})\s*METRES\)/i)?.[1]);
    const body = html.slice(start, end);
    races.push({ no, name, time12, distance, ...parseRaRaceBody(body) });
  }
  return races;
}

function parseRaRaceBody(body) {
  const runners = [];
  const gearChanges = [];
  // 正式出马行：td class 序列 no/last/horse/trainer/jockey/barrier/weight/penalty/penalty/hcp
  const rowRe = /<tr[^>]*>((?:(?!<\/tr>)[\s\S])*?<td[^>]*class=["']?no["']?[^>]*>[\s\S]*?)<\/tr>/g;
  for (const rm of body.matchAll(rowRe)) {
    const row = rm[1];
    const cell = (cls) => {
      const c = row.match(new RegExp(`<td[^>]*class=["']?${cls}["']?[^>]*>([\\s\\S]*?)</td>`, "i"));
      return c ? strip(c[1]) || null : null;
    };
    const scratched = /Scratched/i.test(row);
    runners.push({
      horse_no: num(cell("no")),
      form: cell("last"),
      horse_name: cell("horse")?.replace(/\s*\((?:AUS|NZ|GB|IRE|USA|FR|GER|JPN|SAF)\)\s*$/, "").trim() ?? null,
      horse_country: nameCountry(cell("horse"))?.country ?? null,
      trainer: cell("trainer"),
      jockey: cell("jockey")?.replace(/\s*\(a\d+(?:\/[\d.]+kg)?\)\s*$/, "").trim() ?? null, // 去学徒让磅后缀
      barrier: cell("barrier") != null && cell("barrier") !== "" ? num(cell("barrier")) : null,
      weight: num(cell("weight")),
      weightRaw: cell("weight"),
      probable_weight: cell("penalty"),
      hcp_rating: cell("hcp") != null && cell("hcp") !== "" ? num(cell("hcp")) : null,
      scratched,
      sex: null, age: null, colour: null, foaled: null,
      sire: null, dam: null, dam_sire: null, owner: null, breeder: null,
      _prof: false,
    });
  }
  // 每马资料块（与出马行按 horse-number 关联）
  const profRe = /class="horse-number">(\d+)<[\s\S]*?class="horse-name"[^>]*>([\s\S]*?)<\/span>[\s\S]*?class="plain">([\s\S]*?)<\/span>/gi;
  for (const pm of body.matchAll(profRe)) {
    const no = Number(pm[1]);
    const plain = strip(pm[3]);
    const r = runners.find((x) => x.horse_no === no && !x._prof);
    if (!r) continue;
    r._prof = true;
    Object.assign(r, parseProfileDesc(plain));
    const sire = plain.match(/Sire:\s*(.+?)\s+Dam:/s);
    const dam = plain.match(/Dam:\s*([\s\S]*?)(?:View Pedigree Report|Breeder:)/);
    if (sire) r.sire = nameCountry(sire[1].trim());
    if (dam) {
      let seg = dam[1].replace(/\s+/g, " ").trim();
      // "Improvement (NZ) ( Swiss Ace )" / "Istanford (USA) ( Istan (USA) )" / "Rough Ride ( Flying Spur )"
      // 取最后一个括号组为母父（清理尾部国家码残段），其余为母系名（保留国家码后缀）
      const groups = [...seg.matchAll(/\(([^)]+)\)/g)];
      if (groups.length) {
        const last = groups[groups.length - 1];
        r.dam_sire = last[1].replace(/\(.*$/, "").replace(/\s+/g, " ").trim()
          .replace(/\s*\((?:AUS|NZ|GB|IRE|USA|FR|GER|JPN|SAF)\)\s*$/, "").trim() || null;
        seg = seg.slice(0, last.index).replace(/\($/, "").trim();
      }
      r.dam = seg || null;
    }
    const breeder = plain.match(/Breeder:\s*(.*?)\s*Owners?:/s);
    if (breeder) r.breeder = breeder[1].trim();
    const owner = plain.match(/Owners?:\s*(.+?)\s*(?:Gear|Trainer:|$)/s);
    if (owner) r.owner = owner[1].replace(/\(.*?share.*?\)/gi, "").trim() || null;
  }
  // 装备变更条目
  for (const gm of body.matchAll(/class="gear[^"]*"[^>]*>([\s\S]{0,200}?)<\/(?:td|div)>/gi)) {
    const t = strip(gm[1]);
    if (t) gearChanges.push(t);
  }
  return { runners, gearChanges };
}

// ---------- canonical 组装 ----------
function jp12h(t12) {
  const m = String(t12 ?? "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function toCanonicalRunner(r) {
  return {
    num: r.horse_no,
    frame: null,
    horse: { id: null, name: r.horse_name },
    sex: SEX_JP[r.sex?.toLowerCase()] ?? null,
    age: r.age ?? null,
    color: r.colour ? (COLOUR_JP[r.colour.split(" / ")[0].toLowerCase()] ?? null) : null,
    jockey: { id: null, name: clean(r.jockey) },
    weight: r.weight,
    weightRaw: r.weightRaw,
    weightOver: null,
    trainer: { id: null, name: clean(r.trainer) },
    owner: clean(r.owner),
    breeder: clean(r.breeder),
    sire: r.sire ?? null,
    dam: r.dam ? { id: null, name: clean(r.dam) } : null,
    bms: r.dam_sire ? { id: null, name: clean(r.dam_sire) } : null,
    sireSire: null,
    recent: [],
    silk: null,
    ra: {
      form: clean(r.form),
      barrier: r.barrier,
      hcpRating: r.hcp_rating,
      probableWeight: clean(r.probable_weight),
      horseCountry: r.horse_country,
      foaled: r.foaled ?? null,
      colourRaw: r.colour,
      sexRaw: r.sex,
      scratched: !!r.scratched,
      profiled: r._prof,
    },
  };
}

/** meeting + parseRaForm 结果 → canonical race.card/v2 */
export function buildDoc(mt, races, { capturedAt = new Date().toISOString() } = {}) {
  const tz = STATE_TZ[mt.state] ?? "Australia/Sydney";
  const venue = mt.venue;
  const track = String(venue).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `venue-${mt.state}`;
  const [y, m, d] = mt.date.split("-").map(Number);
  const outRaces = [];
  for (const r of races) {
    const scratched = r.runners.filter((x) => x.scratched);
    const active = r.runners.filter((x) => !x.scratched);
    const runners = active.map(toCanonicalRunner);
    const hhmm = jp12h(r.time12);
    const inst = hhmm ? new Date(instantFromZoned(y, m, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)), tz)) : null;
    const k = klassOf(r.name);
    outRaces.push({
      no: r.no,
      startTime: hhmm,
      startTimeTz: tz,
      startTimeInstant: inst ? isoInZone(inst, tz) : null,
      startTimeLocal: hhmm,
      name: clean(r.name),
      surface: null, // RA 出马页无场地材质字段，不冒填
      distance: r.distance ?? null,
      distanceRaw: r.distance ? `${r.distance}m` : null,
      heads: runners.length,
      klass: k.klass,
      klassGroup: k.klassGroup,
      gradeTag: k.gradeTag,
      raceClass: null,
      raceType: "FLAT",
      raceKey: `${mt.state}-${track}-${r.no}`,
      status: runners.length ? "entries" : "pending",
      runners,
      ra: {
        state: mt.state,
        stage: mt.stage,
        page: r.page ?? null,
        gearChanges: r.gearChanges ?? [],
        scratchings: scratched.map((x) => ({ num: x.horse_no, name: x.horse_name, country: x.horse_country })),
      },
    });
  }
  return {
    schema: "race.card/v2",
    source: "racingaustralia",
    fetchLayer: "racingaustralia.horse",
    sourceKey: `${TAG}:${mt.state}:${mt.venue}`,
    date: mt.date,
    track,
    trackId: null,
    venue,
    country: "AUS", // site/app.js 国家组码（AUS → 澳大利亚）
    countryLong: "Australia",
    scope: "overseas",
    timeZone: tz,
    localTimeZone: tz,
    going: null,
    surfaceRaw: null,
    sourceUrl: `${BASE}/Form.aspx?Key=${encodeURIComponent(`${mt.date.replace(/-/g, "").replace(/^(\d{4})(\d{2})(\d{2})$/, (s, yy, mo, dd) => `${yy}${MONTHS[Number(mo) - 1]}${Number(dd)}`)},${mt.state},${mt.venue}`)}`,
    capturedAt,
    races: outRaces,
    racingaustralia: {
      state: mt.state,
      stage: mt.stage,
    },
  };
}

// ---------- 连通性自检 ----------
export async function probe() {
  const html = await fetchRa(`${BASE}/Calendar.aspx?State=NSW`, { src: `${TAG}-probe` }).catch(() => null);
  const items = html ? parseCalendar(html) : [];
  return { program: { ok: items.length > 0, entries: items.length }, next: items.slice(0, 3) };
}

// ---------- 采集 ----------
const todayInTz = (tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * @param {object} o
 * @param {string[]} o.dates    比赛日（YYYY-MM-DD，场地当地标签）；缺省 = 今天 + 明天（Sydney 口径）
 * @param {string[]} o.states   限定州（缺省全部 8 州）
 * @param {number} o.limit      每日最多抓 N 个 meeting（0=不限）
 * @param {number} o.delayMs    请求间隔（RA 有 Zenedge，默认 5s）
 * @returns [{ date, file, doc }]
 */
export async function collect({ dates = null, states = null, limit = 0, delayMs = 5000, log = console.log } = {}) {
  const base = todayInTz("Australia/Sydney");
  const days = dates?.length ? dates : [base, addDays(base, 1)];
  const sts = states?.length ? AU_STATES.filter((s) => states.includes(s)) : AU_STATES;
  const meetings = (await collectAuMeetings(days, { delayMs, log })).filter((m) => sts.includes(m.state));
  log(`[index] 8 州日历 → ${days.join("/")} 合计 ${meetings.length} meetings`);
  const out = [];
  for (const date of days) {
    const dayMeetings = meetings.filter((m) => m.date === date);
    let picked = dayMeetings;
    if (limit) picked = dayMeetings.slice(0, limit);
    log(`[index] ${date}: ${dayMeetings.length} meetings`);
    for (const mt of picked) {
      const key = encodeURIComponent(`${mt.date.replace(/-/g, "").replace(/^(\d{4})(\d{2})(\d{2})$/, (s, yy, mo, dd) => `${yy}${MONTHS[Number(mo) - 1]}${Number(dd)}`)},${mt.state},${mt.venue}`);
      await sleep(delayMs);
      let html = null;
      let page = "Form";
      try {
        html = await fetchRa(`${BASE}/Form.aspx?Key=${key}`, { src: `${TAG}-form` });
      } catch { html = null; }
      if (!html || !/<td[^>]*class=["']?no["']?/i.test(html)) {
        // Form 未出/无出马行 → 回退 Acceptances
        page = "Acceptances";
        await sleep(delayMs);
        try {
          html = await fetchRa(`${BASE}/Acceptances.aspx?Key=${key}`, { src: `${TAG}-acc` });
        } catch { html = null; }
      }
      if (!html) {
        log(`  ${mt.venue}（${mt.state}）: 页面不可得（Form+Acceptances 均失败）`);
        continue;
      }
      const races = parseRaForm(html);
      const heads = races.reduce((n, r) => n + r.runners.length, 0);
      if (!races.length || !heads) {
        log(`  ${mt.venue}（${mt.state}）: 无出马行（已完赛或未发布）[${page}] → 跳过`);
        continue;
      }
      for (const r of races) r.page = page;
      const doc = buildDoc(mt, races);
      doc.sourceUrl = `${BASE}/${page}.aspx?Key=${key}`;
      const prof = doc.races.reduce((n, r) => n + r.runners.filter((x) => x.ra.profiled).length, 0);
      log(`  [race] ${date} ${doc.venue}（${mt.state}）: ${doc.races.length} R / ${heads} 頭 / 资料块 ${prof} [${page}]`);
      const file = `${TAG}-${mt.state}-${doc.track}.json`;
      out.push({ date, file, doc });
    }
  }
  return out;
}
