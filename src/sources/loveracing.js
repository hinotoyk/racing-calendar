// LOVERACING.NZ（新西兰赛马会官方 RaceInfo）比赛源适配器（docs/DESIGN.md §8）
//
// ## 站点结构（2026-11-18 实测，详见《澳大利亚+新西兰赛马出走表免费获取方案.md》）
// - 首页 /RaceInfo.aspx：主日历表（<td>Sat 26 Dec</td><td><a href="/RaceInfo/{id}/Meeting-Overview.aspx">Name</a>）
//   + 侧栏分组 <li class="meeting nominations|fields|results">（带当前阶段）→ 一次解析即得未来数日全部 meeting。
// - Meeting-Overview.aspx：`<li id="raceN" class="race {nominations|fields|fields-download|results}">` 分场，
//   场次信息在 col2=开跑时刻 / col3=赛名 / col4=条件+距离。
//   马匹两种形态（解析双兼容，详见 parseNzHorseTable）：
//     A) 表格（nominations / fields / results 阶段）：th 表头驱动映射，列集随阶段演进；
//     B) div 行（fields-download 阶段）：col-number / col-form / col-horse(+subtext)，
//        subtext "(5g Zed - Hermione)" = 年龄/性别/父-母，100% 覆盖。
// - EntryDetail 模态 /Common/SystemTemplates/Modal/EntryDetail.aspx?...HorseID=...（~130KB/马）：
//   骑师/练马师/毛色/装备/马主/生产牧场/出生日/评分。fields-download 阶段概览里没有骑练，
//   需逐马抓模态补全 —— 数据按马缓存 data/pedigree/lv-horse.json，跨日复用（第二次起近 0 请求）。
// - barrier/负磅：只在赛日晨 fields 阶段表格才发布，其余阶段为 null（不冒填）。
// - 反爬：间歇性 403（同 headers 先 403 后 200，无 set-cookie）→ 403 退避重试即可。
//
// ## 语义对照
// - 性别码：g=gelding(セ) c=colt(牡) f=filly(牝) h=horse(牡) m=mare(牝) s=stallion(牡)
// - 毛色（模态英文）：bay→鹿毛 brown→青鹿毛 black→青毛 chestnut→栗毛 grey→芦毛 roan→駁毛 white→白毛
// - 阶段语义：nominations=初报 / fields=正式出马 / results=赛果（本场采集器只做出走表，
//   results 阶段文档照样落盘，供赛果 CI 后续复用）
//
// ## 时区
// Pacific/Auckland（9 月末-4 月初 UTC+13，其余 UTC+12，DST 由 IANA 处理）。
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";
import { pedCache } from "../lib/ped-cache.js";
import { instantFromZoned, isoInZone } from "./normalize.js";

export const id = "loveracing";
export const label = "LOVERACING.NZ (New Zealand)";
export const homeUrl = "https://loveracing.nz/raceinfo";

const BASE = "https://loveracing.nz";
const TZ = "Pacific/Auckland";
const TAG = "lv";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// NZ 日期 "Sat 26 Dec" → iso（缺年：按当前年推，早于当前 6 个月以上则 +1 年）
export function nzDateIso(s) {
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!m) return null;
  const mon = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[m[2].toLowerCase()];
  if (!mon) return null;
  const now = new Date();
  let y = now.getUTCFullYear();
  let dt = Date.UTC(y, mon - 1, Number(m[1]));
  if (dt < Date.UTC(y, now.getUTCMonth(), now.getUTCDate()) - 180 * 864e5) dt = Date.UTC(++y, mon - 1, Number(m[1]));
  return new Date(dt).toISOString().slice(0, 10);
}

// NZ 站反爬：间歇性 403（同 headers 先 403 后 200，无 set-cookie）+ 模态接口 429 限流
// → 403/429 都退避重试（429 退避更长，实测 1.2s 间隔即触发）
async function fetchNz(url, src = TAG) {
  for (let i = 0; ; i++) {
    try {
      return await fetchHtmlSoft(url, { src, ua: BROWSER_UA, retries: 0 });
    } catch (e) {
      const backoff = e.status === 429 ? 15000 : 3000;
      const maxRetry = e.status === 429 ? 2 : 3;
      if ((e.status === 403 || e.status === 429) && i < maxRetry) {
        await sleep(backoff * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

// ---------- 首页 → meeting 列表 ----------
export function parseIndex(html) {
  const meetings = new Map(); // id → {id, name, date, kind}
  // ① 主日历表
  for (const rm of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rm[1];
    const lm = row.match(/\/RaceInfo\/(\d+)\/Meeting-Overview\.aspx[^>]*>([^<]*)</i);
    if (!lm) continue;
    const d = nzDateIso(strip(row.match(/<td[^>]*>([^<]*\d{1,2}\s+\w{3,9})</i)?.[1]));
    if (!d) continue;
    meetings.set(Number(lm[1]), { id: Number(lm[1]), name: strip(lm[2]), date: d, kind: "calendar" });
  }
  // ② 侧栏分组（带当前阶段，覆盖/补充主日历）
  for (const lm of html.matchAll(/class="[^"]*meeting\s+(nominations|fields|results)"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const body = lm[2];
    const idm = body.match(/\/RaceInfo\/(\d+)\/Meeting-Overview\.aspx/);
    if (!idm) continue;
    const prev = meetings.get(Number(idm[1]));
    const name = strip((body.match(/<a[^>]*>([\s\S]*?)<\/a>/) ?? [])[1]);
    meetings.set(Number(idm[1]), {
      id: Number(idm[1]),
      name: name || prev?.name,
      date: nzDateIso((body.match(/class="ml-auto date">([^<]*)</) ?? [])[1]) ?? prev?.date,
      kind: lm[1].toLowerCase(),
    });
  }
  return [...meetings.values()].filter((m) => m.date && m.name);
}

// ---------- Meeting-Overview 解析 ----------
/** 赛名/条件 → 比赛格（NZ：Group 1-3 / Listed 在赛名或条件里） */
function klassOf(...texts) {
  const n = texts.filter(Boolean).join(" ");
  const g = n.match(/Group\s*([123])/i) || n.match(/\bG\s*([123])\b/);
  if (g) return { klass: `G${"ⅠⅡⅢ"[+g[1] - 1]}`, klassGroup: "重賞", gradeTag: `G${"ⅠⅡⅢ"[+g[1] - 1]}` };
  if (/\bListed\b/i.test(n)) return { klass: "L", klassGroup: "重賞", gradeTag: "L" };
  return { klass: null, klassGroup: "一般", gradeTag: null };
}

/** 名字尾缀国码「Zed (GB)」→ { name, country } */
export function nameCountry(s) {
  const t = clean(s);
  if (!t) return null;
  const m = t.match(/^(.*?)[\s]*\(([A-Z]{2,3})\)\s*$/);
  return m ? { name: clean(m[1]), country: m[2] } : { name: t, country: null };
}

// 每马的 EntryDetail 模态链接（含 HorseID/JockeyID/RaceID）
function parseNzEntryLinks(body) {
  return [...new Set([...body.matchAll(/href="(\/Common\/SystemTemplates\/Modal\/EntryDetail\.aspx\?[^"]+?)#/g)].map((m) => m[1]))];
}
function horseIdOf(entryUrl) {
  const m = String(entryUrl ?? "").match(/HorseID=(\d+)/);
  return m ? `${TAG}:${m[1]}` : null;
}

/**
 * 马匹两种形态：
 * A) 表格（nominations / fields / results）：th>Horse 驱动，列集随阶段演进（表头驱动不写死列序）
 * B) div 行（fields-download）：col-number / col-form / col-horse(+subtext)
 * @returns [{ horseNo, name, entryUrl, ...字段 }]
 */
export function parseNzHorseTable(body, stage) {
  const runners = [];
  const NZ_SEX = { g: "gelding", m: "mare", c: "colt", f: "filly", h: "horse", s: "stallion" };
  const tbl = body.match(/<table[\s\S]*?<th[^>]*>\s*Horse\s*<\/th>[\s\S]*?<\/table>/i);
  if (tbl) {
    const tableHtml = tbl[0];
    const ths = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => strip(m[1]).toLowerCase());
    const col = (...names) => {
      for (const n of names) {
        const i = ths.findIndex((t) => t === n || t.startsWith(n));
        if (i >= 0) return i;
      }
      return -1;
    };
    const idxMap = {
      horse: col("horse"), jockey: col("jockey", "rider"), trainer: col("trainer"), age: col("age"),
      sex: col("sex"), weight: col("weight"), barrier: col("barrier"), no: col("#", "tab"),
      owner: col("owner"), breeder: col("breeder"), sire: col("sire"), dam: col("dam"),
      form: col("form"),
    };
    for (const rm of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = rm[1];
      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
      if (cells.length < ths.length - 1 || !cells[idxMap.horse]) continue;
      const get = (k) => (idxMap[k] >= 0 ? cells[idxMap[k]] || null : null);
      const entryUrl = (rowHtml.match(/href="(\/Common\/SystemTemplates\/Modal\/EntryDetail\.aspx\?[^"]+?)"/) ?? [])[1] ?? null;
      const scratched = /Scratch/i.test(rowHtml);
      runners.push({
        horseNo: get("no") ? Number(get("no")) || null : runners.length + 1,
        name: get("horse"),
        entryUrl,
        jockey: get("jockey"), trainer: get("trainer"),
        age: /^\d+$/.test(get("age") ?? "") ? Number(get("age")) : null,
        sex: NZ_SEX[(get("sex") ?? "").toLowerCase()] ?? get("sex"),
        weight: num(get("weight")), barrier: get("barrier") != null ? num(get("barrier")) : null,
        owner: get("owner"), breeder: get("breeder"),
        sire: nameCountry(get("sire")), dam: get("dam") ? { id: null, name: clean(get("dam")) } : null,
        colour: null, foaled: null, form: get("form"),
        scratched,
      });
    }
    return runners;
  }
  // B) fields-download div 行
  const rowMarks = [...body.matchAll(/class="col col-number">(\d+)<\/div>/g)];
  for (let i = 0; i < rowMarks.length; i++) {
    const seg = body.slice(rowMarks[i].index, i + 1 < rowMarks.length ? rowMarks[i + 1].index : undefined);
    const form = seg.match(/class="col col-form">([^<]*)</)?.[1]?.trim() ?? null;
    const horseSeg = seg.match(/class="col col-horse">([\s\S]*?)(?:<\/div>\s*(?:<\/div>)?\s*$|class="col col-number")/);
    const horseHtml = horseSeg?.[1] ?? seg.match(/class="col col-horse">([\s\S]*)/)?.[1] ?? "";
    const name = strip((horseHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/) ?? [])[1]);
    if (!name) continue;
    const entryUrl = (horseHtml.match(/href="(\/Common\/SystemTemplates\/Modal\/EntryDetail\.aspx\?[^"]+?)"/) ?? [])[1] ?? null;
    const sub = strip((horseHtml.match(/class="subtext">([^<]*)</) ?? [])[1]);
    const r = {
      horseNo: Number(rowMarks[i][1]),
      name,
      entryUrl,
      form,
      age: null, sex: null, sire: null, dam: null,
      jockey: null, trainer: null, weight: null, barrier: null,
      owner: null, breeder: null, colour: null, foaled: null,
      scratched: false,
    };
    // "(5g Zed - Hermione)" / "(4g Proisir (AUS) - Kay's Awake)" —— 整体包在一个括号里
    const sm = sub.match(/^\((\d+)\s*([a-z])\s+([\s\S]+)\)$/i);
    if (sm) {
      r.age = Number(sm[1]);
      r.sex = NZ_SEX[sm[2].toLowerCase()] ?? sm[2];
      const parts = sm[3].split(/\s+-\s+/);
      if (parts.length >= 2) {
        r.sire = nameCountry(parts[0]);
        r.dam = { id: null, name: parts.slice(1).join(" - ").trim() };
      }
    }
    runners.push(r);
  }
  return runners;
}

/** Meeting-Overview 页 → [{ no, stage, time, name, conditions, distance, runners, entries }] */
export function parseNzOverview(html) {
  const races = [];
  // 注意 stage 可能是 "fields-download"（连字符）：class="race fields-download"
  const parts = html.split(/<li\s+id\s*=\s*"race(\d+)"[^>]*class="race\s+([a-z-]+)"/i);
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const no = Number(parts[i]);
    const stage = parts[i + 1].toLowerCase();
    const body = parts[i + 2];
    const info = {};
    const c2 = body.match(/<td\s+class="col2">([\s\S]*?)<\/td>/i);
    const c3 = body.match(/<td\s+class="col3">([\s\S]*?)<\/td>/i);
    const c4 = body.match(/<td\s+class="col4">([\s\S]*?)<\/td>/i);
    if (c2) info.time = strip(c2[1]);
    if (c3) info.name = strip(c3[1]);
    if (c4) info.conditions = strip(c4[1]);
    const dist = (info.conditions ?? "").match(/(\d{3,4})m\b/i);
    if (dist) info.distance = Number(dist[1]);
    races.push({
      no, stage, ...info,
      runners: parseNzHorseTable(body, stage),
      entries: parseNzEntryLinks(body),
    });
  }
  return races;
}

// ---------- EntryDetail 模态（按马缓存） ----------
function horseCache() {
  return pedCache(`${process.cwd()}/data/pedigree/lv-horse.json`);
}

/** 模态页 → { jockey, trainer, age, colour, sex, owner, breeder, sire, dam, foaled, gear, flatRating } */
export function parseNzModal(html) {
  const plain = strip(html);
  const out = {};
  const jm = plain.match(/With Jockey \(([^)]+)\)/);
  if (jm) out.jockey = jm[1].trim();
  const tm = plain.match(/Trainer:\s*(.*?)\s*Training Location:/s);
  if (tm) out.trainer = tm[1].trim();
  // Horse Details 段：年龄 + 毛色 + 性别。毛色可能双词（"Bay or Brown Gelding"），
  // 旧正则 ([A-Za-z-]+)\s+([A-Za-z]+) 会把 "or" 当成性别（2026-11-18 Theonewekept 实测）；
  // 改为捕获整个段（到 Owner/Breeder/Flat Rating 等下一区块关键词为止），末词=性别、其余=毛色
  const hd = plain.match(/Horse Details\s*(\d+)\s*YO\s+(.+?)(?=\s+Owner:|\s+Breeder:|\s+Sire:|\s+Dam:|\s+Flat Rating|\s+Current Gear|\s+Trainer:|$)/i);
  if (hd) {
    out.age = Number(hd[1]);
    const seg = hd[2].trim();
    const sm = seg.match(/^(.*?)(?:\s+or\s+|\s+)(mare|gelding|colt|filly|entire|horse)$/i);
    if (sm) {
      out.colour = sm[1].trim().split(/\s+/)[0].toLowerCase(); // 双毛色取首个（"Bay or Brown"→bay）
      out.sex = sm[2].toLowerCase();
    }
  }
  const om = plain.match(/Owner:\s*(.*?)\s*Breeder:/s);
  if (om) out.owner = om[1].trim() || null;
  const bm = plain.match(/Breeder:\s*(.*?)\s*Sire:/s);
  if (bm) out.breeder = bm[1].trim();
  const sire = plain.match(/Sire:\s*(.*?)\s*Dam:/s);
  if (sire) out.sire = sire[1].replace(/\s+\d{4}\s*$/, "").trim();
  const dam = plain.match(/Dam:\s*(.*?)\s*Foaling:/s);
  if (dam) out.dam = dam[1].replace(/\s+\d{4}\s*$/, "").trim();
  const fm = plain.match(/Foaling:\s*(\d{1,2}\s+\w{3}\s+\d{4})/);
  if (fm) {
    const [d, mon, y] = fm[1].split(/\s+/);
    const mm = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" }[mon];
    if (mm) out.foaled = `${y}-${mm}-${d.padStart(2, "0")}`;
  }
  // 装备区块：HTML 内每项一行，替换标签为换行后取非空行
  const gearSeg = html.match(/Current Gear:([\s\S]*?)Horse Details\b/s);
  if (gearSeg) {
    const items = gearSeg[1].replace(/<[^>]+>/g, "\n").split("\n").map((s) => strip(s)).filter((s) => s && !/^-A$|N\/A/i.test(s));
    if (items.length) out.gear = items;
  }
  const fr = plain.match(/Flat Rating:\s*(\d+)/);
  if (fr) out.flatRating = Number(fr[1]);
  return out;
}

// ---------- 字段映射 ----------
const SEX_JP = { gelding: "セ", colt: "牡", stallion: "牡", horse: "牡", mare: "牝", filly: "牝" };
const COLOUR_JP = {
  bay: "鹿毛", brown: "青鹿毛", "bay-brown": "青鹿毛", "brown-bay": "青鹿毛", "black-bay": "青鹿毛",
  black: "青毛", chestnut: "栗毛", grey: "芦毛", gray: "芦毛", roan: "駁毛", white: "白毛", "grey-bay": "芦毛",
};
const jpColour = (s) => COLOUR_JP[String(s ?? "").toLowerCase()] ?? null;
const jpSex = (s) => SEX_JP[String(s ?? "").toLowerCase()] ?? null;

/** 源 runner + 模态缓存 → canonical runner（race.card/v2） */
function toCanonicalRunner(r, md) {
  const weight = r.weight ?? null;
  return {
    num: r.horseNo,
    frame: null, // NZ 无枠位概念
    horse: { id: horseIdOf(r.entryUrl), name: r.name },
    sex: jpSex(r.sex) ?? (md?.sex ? jpSex(md.sex) : null),
    age: r.age ?? md?.age ?? null,
    color: jpColour(md?.colour) ?? null,
    jockey: { id: null, name: clean(r.jockey ?? md?.jockey) },
    weight,
    weightRaw: r.weightRaw ?? (r.weight != null ? `${r.weight}kg` : null),
    weightOver: null,
    trainer: { id: null, name: clean(r.trainer ?? md?.trainer) },
    owner: clean(md?.owner ?? r.owner),
    breeder: clean(md?.breeder ?? r.breeder),
    sire: r.sire ?? (md?.sire ? nameCountry(md.sire) : null),
    dam: r.dam ?? (md?.dam ? { id: null, name: clean(md.dam) } : null),
    bms: null, // 模态无母父字段，不冒填
    sireSire: null,
    recent: [],
    silk: null,
    lv: {
      form: clean(r.form),
      barrier: r.barrier ?? null,
      foaled: md?.foaled ?? null,
      colourRaw: md?.colour ?? null,
      sexRaw: r.sex ?? md?.sex ?? null,
      gear: md?.gear ?? [],
      flatRating: md?.flatRating ?? null,
      scratched: !!r.scratched,
      entryUrl: r.entryUrl ?? null,
    },
  };
}

/**
 * Meeting-Overview 解析结果 + meeting 元数据 → canonical race.card/v2 文档
 */
export function buildDoc(mt, races, { capturedAt = new Date().toISOString() } = {}) {
  const venue = mt.name;
  const track = String(venue).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `meeting-${mt.id}`;
  const [y, m, d] = mt.date.split("-").map(Number);
  const outRaces = [];
  for (const r of races) {
    const scratched = r.runners.filter((x) => x.scratched);
    const active = r.runners.filter((x) => !x.scratched);
    const runners = active.map((x) => toCanonicalRunner(x, null));
    const hhmm = String(r.time ?? "").match(/(\d{1,2}):(\d{2})/);
    const inst = hhmm ? new Date(instantFromZoned(y, m, d, +hhmm[1], +hhmm[2], TZ)) : null;
    const k = klassOf(r.name, r.conditions);
    outRaces.push({
      no: r.no,
      startTime: hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null,
      startTimeTz: TZ,
      startTimeInstant: inst ? isoInZone(inst, TZ) : null,
      startTimeLocal: hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null,
      name: clean(r.name),
      surface: null, // NZ 概览页无场地材质字段，不冒填
      distance: r.distance ?? null,
      distanceRaw: r.distance ? `${r.distance}m` : null,
      heads: runners.length,
      klass: k.klass,
      klassGroup: k.klassGroup,
      gradeTag: k.gradeTag,
      raceClass: clean(r.conditions) ? r.conditions.slice(0, 120) : null,
      raceType: "FLAT",
      raceKey: `${mt.id}-${r.no}`,
      status: runners.length ? "entries" : "pending",
      runners,
      lv: {
        stage: r.stage,
        conditions: clean(r.conditions),
        scratchings: scratched.map((x) => ({ num: x.horseNo, name: x.name, id: horseIdOf(x.entryUrl) })),
      },
    });
  }
  return {
    schema: "race.card/v2",
    source: "loveracing",
    fetchLayer: "loveracing.nz",
    sourceKey: `${TAG}:${mt.id}`,
    date: mt.date,
    track,
    trackId: null,
    venue,
    country: "NZ", // site/app.js 国家组码（NZ → 新西兰）
    countryLong: "New Zealand",
    scope: "overseas",
    timeZone: TZ,
    localTimeZone: TZ,
    going: null,
    surfaceRaw: null,
    sourceUrl: `${BASE}/RaceInfo/${mt.id}/Meeting-Overview.aspx`,
    capturedAt,
    races: outRaces,
    loveracing: {
      meetingId: mt.id,
      stage: mt.kind,
    },
  };
}

// ---------- 模态富化（骑师/练马师/毛色/马主/生产牧场/出生日） ----------
/**
 * 给一批文档补 canonical runner 的模态字段（按马 id 缓存，跨日复用）。
 * fields-download 阶段概览只有 马号/Form/马名/年龄性别/父母系；骑练等在 EntryDetail 模态里。
 */
export async function resolveModal(docs, { delayMs = 3500, limit = 0, log = console.log } = {}) {
  const cache = horseCache();
  const stat = { queried: 0, hit: 0, miss: 0, filled: 0, heads: 0 };
  const targets = []; // { runner, url }
  for (const doc of docs)
    for (const race of doc.races ?? [])
      for (const r of race.runners ?? []) {
        stat.heads++;
        if (!r.lv?.entryUrl) continue;
        // 富化目标 = 缺骑师（表格阶段）或 缺性别/年龄/母系名（results 阶段表格常无这几列，
        // 2026-11-18 SC 实测整场全缺；模态 EntryDetail 有性别/年龄/母系，按马 id 缓存去重）
        const need = !r.jockey?.name || r.sex == null || r.age == null || !r.dam?.name;
        if (!need) continue;
        const hid = r.horse?.id;
        targets.push({ runner: r, url: r.lv.entryUrl, hid });
      }
  const capped = limit > 0 ? targets.slice(0, limit) : targets;
  for (const t of capped) {
    let md = t.hid ? cache.get(t.hid) : null;
    if (!md) {
      let html = null;
      try {
        await sleep(delayMs);
        html = await fetchNz(`${BASE}${t.url}`, `${TAG}-modal`);
      } catch (e) {
        log(`[modal] ${t.runner.horse?.name} → ${e.message}`);
      }
      stat.queried++;
      if (html) {
        md = { ...parseNzModal(html), capturedAt: new Date().toISOString() };
        if (t.hid) cache.set(t.hid, md);
        if (md.jockey || md.trainer) stat.hit++;
        else stat.miss++;
      }
    } else {
      stat.hit++;
    }
    if (!md) continue;
    const r = t.runner;
    const was = JSON.stringify([r.jockey?.name, r.trainer?.name, r.owner, r.breeder, r.color]);
    if (md.jockey && !r.jockey?.name) r.jockey = { id: null, name: clean(md.jockey) };
    if (md.trainer && !r.trainer?.name) r.trainer = { id: null, name: clean(md.trainer) };
    if (md.owner && !r.owner) r.owner = clean(md.owner);
    if (md.breeder && !r.breeder) r.breeder = clean(md.breeder);
    if (md.foaled && !r.lv.foaled) r.lv.foaled = md.foaled;
    if (md.gear?.length) r.lv.gear = md.gear;
    if (md.flatRating != null && r.lv.flatRating == null) r.lv.flatRating = md.flatRating;
    if (md.colour && !r.color) r.color = jpColour(md.colour);
    if (md.age && r.age == null) r.age = md.age;
    if (md.sex && !r.sex) r.sex = jpSex(md.sex);
    if (md.sire && !r.sire?.name) r.sire = nameCountry(md.sire);
    // results 阶段表格母系列常为空单元格 → r.dam 可能是 {name:null} 空对象，
    // 不能只判 !r.dam（2026-11-18 SC 24 頭实测全部被空对象挡住）
    if (md.dam && !r.dam?.name) r.dam = { id: null, name: clean(md.dam) };
    if (was !== JSON.stringify([r.jockey?.name, r.trainer?.name, r.owner, r.breeder, r.color])) stat.filled++;
  }
  cache.save();
  log(`[modal] 富化 ${stat.filled}/${stat.heads} 頭（缓存命中 ${stat.hit}，本次请求 ${stat.queried}，查无 ${stat.miss}）`);
  return stat;
}

// ---------- Breeding 页血统补全（母父/父父，按马缓存） ----------
function pedCacheLv() {
  return pedCache(`${process.cwd()}/data/pedigree/lv-ped.json`);
}

/** Breeding 页 → { sireId, damId, bms, sireSire }（bms/sireSire = {id, name}，来自 Sire Line / Dam Line 表） */
export function parseNzBreeding(html) {
  // 血统表祖先名带「出生年」尾缀（"Deep Impact (JPN) 2002"），去掉年份只留国码，
  // 否则归一化键变成 deepimpactjpn2002，无法与 JBIS canonical（ディープインパクト）合并
  const anchor = (td) => {
    const m = td.match(/EntryDetail\.aspx\?HorseID=(\d+)[^"]*"[^>]*>([^<]+)</);
    return m ? { id: `${TAG}:${m[1]}`, name: strip(m[2]).replace(/\s*\d{4}\s*$/, "").trim() } : null;
  };
  const out = {};
  // Overview：Sire/Dam 带稳定 id
  const ov = html.match(/Sire:<\/strong>\s*<a[^>]*HorseID=(\d+)[^"]*"[^>]*>([^<]+)</);
  if (ov) out.sireId = `${TAG}:${ov[1]}`;
  const dm = html.match(/Dam:<\/strong>\s*<a[^>]*HorseID=(\d+)[^"]*"[^>]*>([^<]+)</);
  if (dm) out.damId = `${TAG}:${dm[1]}`;
  // Dam Line 表：第 1 行 col3 = 母父（Sire of Broodmare）
  const damTab = html.match(/id="dam"[^>]*>[\s\S]*?<table[\s\S]*?<\/table>/i);
  if (damTab) {
    const rows = [...damTab[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const first = rows.find((r) => r[1].includes("by"));
    if (first) {
      const tds = [...first[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
      if (tds.length >= 3) out.bms = anchor(tds[2][1]);
    }
  }
  // Sire Line 表：第 1 行 = 父（col1）× 父之母（col3）；第 2 行 col1 = 父父
  const sireTab = html.match(/id="sire"[^>]*>[\s\S]*?<table[\s\S]*?<\/table>/i);
  if (sireTab) {
    const rows = [...sireTab[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const dataRows = rows.filter((r) => r[1].includes("EntryDetail.aspx"));
    if (dataRows.length >= 2) {
      const tds = [...dataRows[1][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
      if (tds.length >= 1) out.sireSire = anchor(tds[0][1]);
    }
  }
  return out;
}

/**
 * 给一批文档补 runner.bms（母父）/ sireSire（父父），并把 sire/dam 升级为带稳定 id。
 * 数据源：/Breeding/{horseId}/x.aspx（slug 可省略，按 ID 直取，~68KB/马），按马缓存跨日复用。
 */
export async function resolvePedigree(docs, { delayMs = 3500, log = console.log } = {}) {
  const cache = pedCacheLv();
  const stat = { queried: 0, hit: 0, miss: 0, filled: 0, heads: 0 };
  const targets = []; // { runner, hid }
  const seen = new Set();
  for (const doc of docs)
    for (const race of doc.races ?? [])
      for (const r of race.runners ?? []) {
        stat.heads++;
        const hid = r.horse?.id;
        if (!hid || !/^lv:\d+$/.test(hid) || seen.has(hid)) continue;
        seen.add(hid);
        targets.push({ runner: r, hid });
      }
  for (const t of targets) {
    let ped = cache.get(t.hid);
    if (!ped) {
      let html = null;
      try {
        await sleep(delayMs);
        html = await fetchNz(`${BASE}/Breeding/${t.hid.slice(3)}/x.aspx`, `${TAG}-ped`);
      } catch (e) {
        log(`[ped] ${t.runner.horse?.name}(${t.hid}) → ${e.message}`);
      }
      stat.queried++;
      if (html) {
        ped = { ...parseNzBreeding(html), capturedAt: new Date().toISOString() };
        cache.set(t.hid, ped);
        if (ped.bms || ped.sireSire) stat.hit++;
        else stat.miss++;
      }
    } else {
      stat.hit++;
    }
    if (!ped) continue;
    const r = t.runner;
    if (ped.sireId && !r.sire?.id) r.sire = { ...(r.sire ?? {}), id: ped.sireId, name: r.sire?.name ?? strip(ped.sireId) };
    if (ped.damId && !r.dam?.id) r.dam = { ...(r.dam ?? {}), id: ped.damId };
    if (ped.bms && !r.bms) r.bms = ped.bms;
    if (ped.sireSire && !r.sireSire) r.sireSire = ped.sireSire;
    stat.filled++;
  }
  cache.save();
  log(`[ped] 血统补全 ${stat.filled}/${stat.heads} 頭（缓存命中 ${stat.hit}，本次请求 ${stat.queried}，查无 ${stat.miss}）`);
  return stat;
}

// ---------- 连通性自检 ----------
export async function probe() {
  const html = await fetchNz(`${BASE}/RaceInfo.aspx`, `${TAG}-probe`).catch(() => null);
  const meetings = html ? parseIndex(html) : [];
  return {
    program: { ok: meetings.length > 0, meetings: meetings.length },
    next: meetings.slice(0, 3).map((m) => `${m.date} ${m.name}(${m.kind})`),
  };
}

// ---------- 采集 ----------
const todayInTz = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * @param {object} o
 * @param {string[]} o.dates   比赛日（YYYY-MM-DD，NZ 当地）；缺省 = 今天 + 明天
 * @param {number} o.limit     每日最多抓 N 个 meeting（0=不限）
 * @param {number} o.delayMs   模态请求间隔
 * @param {boolean} o.pedigree 是否抓 EntryDetail 模态补骑练/毛色/马主（带持久缓存）
 * @returns [{ date, file, doc }]
 */
export async function collect({ dates = null, limit = 0, delayMs = 3500, pedigree = true, log = console.log } = {}) {
  const days = dates?.length ? dates : [todayInTz(), addDays(todayInTz(), 1)];
  const idx = await fetchNz(`${BASE}/RaceInfo.aspx`);
  const allMeetings = parseIndex(idx);
  log(`[index] RaceInfo.aspx: ${allMeetings.length} meetings（未来数日全集）`);
  const out = [];
  for (const dateIso of days) {
    const dayMeetings = allMeetings.filter((m) => m.date === dateIso);
    if (!dayMeetings.length) {
      log(`[index] ${dateIso}: 无 meeting`);
      continue;
    }
    let picked = dayMeetings;
    if (limit) picked = dayMeetings.slice(0, limit);
    for (const mt of picked) {
      await sleep(1500);
      let html = null;
      try {
        html = await fetchNz(`${BASE}/RaceInfo/${mt.id}/Meeting-Overview.aspx`);
      } catch (e) {
        log(`[race] ${dateIso} ${mt.name}: overview 抓取失败 ${e.message}`);
        continue;
      }
      const races = parseNzOverview(html);
      const heads = races.reduce((n, r) => n + r.runners.length, 0);
      if (!races.length || !heads) {
        log(`[race] ${dateIso} ${mt.name}: 页面无出马数据（阶段=${mt.kind}）→ 跳过`);
        continue;
      }
      const doc = buildDoc(mt, races);
      // results 阶段表格有骑练但没有性别/年龄/母系列 → resolveModal 现按
      // 「缺骑师 或 缺性别/年龄/母系」定目标（内部有马 id 缓存，重复抓取为 0 请求）
      if (pedigree) await resolveModal([doc], { delayMs, log });
      if (pedigree) await resolvePedigree([doc], { delayMs, log }); // 母父/父父（Breeding 页，缓存）
      const stages = [...new Set(races.map((r) => r.stage))].join("/");
      const heads2 = doc.races.reduce((n, r) => n + r.heads, 0);
      log(`[race] ${dateIso} ${doc.venue}（#${mt.id}）: ${doc.races.length} R / ${heads2} 頭 / 阶段=${stages || mt.kind}`);
      out.push({ date: dateIso, file: `${TAG}-${mt.id}.json`, doc });
    }
  }
  return out;
}
