// TJK（Türkiye Jokey Kulübü，土耳其赛马会）比赛源适配器（docs/DESIGN.md §8）
//
// ## 站点结构（2026-11-16 实测）
// - 纯服务端渲染 XHTML（无 __NEXT_DATA__、无 JSON API、UA 不校验），直连 200。
// - 每日节目 = 索引页 1 次（当天有比赛的场地清单，含本国 10 场 + TJK 代播的境外场）
//   + 单城市页 1 次（该场地整日全部场次 + 出马表，600KB–1MB）。
// - 页面还挂了官方导出（PDF / CSV）在 medya-cdn.tjk.org，URL 可按「日期 + 城市名」拼；
//   `tjk.probe.js` 用它做交叉校验（场次数 / 时刻 / 距离 / 场地类型 / 比赛格码）。
//
// ## 为什么抓 HTML 而不是官方 CSV
// CSV 缺马、骑手、调教师、马主的**稳定 id**（只有名字），也没有母父（BMS）与彩衣；
// HTML 一页拿全（AtId / JokeyId / AntrenorId / SahipId / 父-母-母父 / 彩衣直链 / 让赛评分 / 赔率 / 人气），
// 且骑手调教师的**全名**只在 HTML 的 title 属性里（CSV 是 E.AKPINAR 这种缩写）。
// 请求量与 CSV 同量级（都是一城市一请求），故以 HTML 为主、CSV 仅作对账。
//
// ## 时区
// Europe/Istanbul，UTC+3 全年不变（2016 年起无夏令时），date 标签与 startTime 同口径。
//
// ## robots.txt（务必先读）
// www.tjk.org 的 robots.txt 是 `User-agent: * / Disallow: /`，并逐个点名封了
// GPTBot / ClaudeBot / DeepSeekBot / CCBot 等 AI 系爬虫。**本适配器默认不接入 CI**，
// 只在人工显式执行 `node src/collect-sources.js --source tjk` 时运行。
import fs from "node:fs";
import path from "node:path";
import { fetchHtmlSoft, fetchBuffer, BROWSER_UA } from "../lib/fetch.js";
import { pedCache } from "../lib/ped-cache.js";
import { createHorseLookup, preferredMapFromSireCache, sireAnswerOf } from "../lib/horse-lookup.js";
import { loadHomonym } from "../lib/homonym.js";

export const id = "tjk";
export const label = "TJK (Türkiye)";
export const homeUrl = "https://www.tjk.org/EN/YarisSever/Info/Page/GunlukYarisProgrami";

const BASE = "https://www.tjk.org";
const CDN = "https://medya-cdn.tjk.org";
const TZ = "Europe/Istanbul"; // UTC+3，无 DST
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 文本工具 ----------
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
const stripTags = (s) => decodeEntities(String(s ?? "").replace(/<[^>]*>/g, " "));
const norm = (s) => stripTags(s).replace(/\s+/g, " ").trim();
const num = (s) => {
  const m = String(s ?? "").replace(/\s/g, "").match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
};

// 土耳其字符 → ASCII（场地 slug 用；ı/İ 都要落到 i）
const TR_FOLD = { ı: "i", İ: "i", ş: "s", Ş: "s", ğ: "g", Ğ: "g", ç: "c", Ç: "c", ö: "o", Ö: "o", ü: "u", Ü: "u", â: "a" };
export function slugify(s) {
  return String(s ?? "")
    .replace(/[ıİşŞğĞçÇöÖüÜâ]/g, (c) => TR_FOLD[c] ?? c)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------- 场地 / 场次归一 ----------
// 索引页给「当天有比赛的场地」，本国 10 场 + TJK 代播的境外场（Belmont Park ABD / Le Mans Fransa…）。
// 境外场名一律以国名结尾 → 反向识别；Karma 是同日多场混编的复播位（整日内容与各国场重复），跳过。
const FOREIGN_TAIL =
  /(ABD|Avustralya|Malezya|Guney Afrika|Arjantin|Brezilya|Kanada|Fransa|Şili|Sili|Japonya|Almanya|Italya|İtalya|İngiltere|Irlanda|Yeni Zelanda|Singapur|Kore|Hong Kong|Uruguay|Peru|Meksika)\s*$/i;

const SURFACE = (raw) => {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("turf")) return "芝";
  if (s.includes("dirt") || s.includes("sand") || s.includes("all weather")) return "ダ";
  return null;
};
const SEX = { c: "牡", f: "牝", h: "牡", m: "牝", g: "セ" };
const COLOUR = { b: "鹿毛", ch: "栗毛", gr: "芦毛", ro: "駁毛", bl: "青毛", wh: "白毛", br: "青鹿毛" };
const GEAR_NAME = { B: "Blinkers", H: "Hood", TT: "Tongue-Tie", E: "Eyeshields", S: "Sheepskin", CP: "Cheek Pieces" };

// 「3yo ch c」/「7yo chm」/「2yo b f」→ { age, colour, sex }
// 毛色码可能与性別码连写（chm = chestnut mare）：先试 2 字母毛色白名单，再退 1 字母
function parseAgeSex(raw) {
  const s = String(raw ?? "").replace(/\s+/g, "").toLowerCase();
  const m = s.match(/^(\d+)yo(.*)$/);
  if (!m) return null;
  const rest = m[2];
  if (rest.length < 2) return { age: +m[1], colour: null, sex: SEX[rest.at(-1)] ?? null };
  const two = rest.slice(0, 2);
  if (COLOUR[two]) return { age: +m[1], colour: COLOUR[two], sex: SEX[rest.slice(2)] ?? null };
  return { age: +m[1], colour: COLOUR[rest[0]] ?? null, sex: SEX[rest.slice(1)] ?? null };
}

/**
 * 比赛格归一：TJK 赛事类型码 → klass / klassGroup / gradeTag
 * 实测码：G 1/2/3（可带 /ULS 等后缀）、A 2/A 3（本国 Pattern，低于 GⅢ）、Listed、
 *        Handicap N、Condition N、Condition Handicap N、Maiden、Claiming N、Selling N
 * 后缀是出赛资格限定（/DHÖW 国家种马场生产、/Fillies 牝马、/Mares 成年牝马、/ULS 国际开放），
 * 不影响级别判定 → klass 保留原文（含后缀），便于回溯。
 */
export function klassOfTJK(code, name) {
  const c = String(code ?? "").trim();
  const g = c.match(/^G\s*([123])/i) ?? String(name ?? "").match(/\bG\s*([123])\b/);
  if (g) {
    const tag = `G${"ⅠⅡⅢ"[+g[1] - 1]}`;
    return { klass: tag, klassGroup: "重賞", gradeTag: tag };
  }
  const a = c.match(/^A\s*([123])/i);
  if (a) return { klass: `A${a[1]}`, klassGroup: "重賞", gradeTag: `A${a[1]}` };
  if (/^Listed/i.test(c)) return { klass: "L", klassGroup: "重賞", gradeTag: "L" };
  return { klass: c || "一般", klassGroup: "一般", gradeTag: null };
}

// ---------- 时区工具（与 normalize.js 同算法，此处自持以免公共层改动） ----------
function offsetMinutes(tz, at) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = String(part ?? "GMT+00:00").match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + (+(m[3] ?? 0)));
}
function instantAt(dateIso, hh, mm, tz = TZ) {
  const [y, mo, d] = dateIso.split("-").map(Number);
  let ts = Date.UTC(y, mo - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, mo - 1, d, hh, mm) - offsetMinutes(tz, new Date(ts)) * 60000;
  return new Date(ts);
}
function isoInZone(date, tz = TZ) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value;
  const off = offsetMinutes(tz, date);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:00${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// ---------- 索引页 → 城市清单 ----------
export function parseIndexCities(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/SehirId=(\d+)&[^"]*?QueryParameter_Tarih=([^&"]*)&[^"]*?SehirAdi=([^&"]*)/g)) {
    const sid = m[1];
    if (seen.has(sid)) continue;
    seen.add(sid);
    const name = decodeEntities(decodeURIComponent(m[3].replace(/\+/g, " ")));
    out.push({ id: sid, name, foreign: FOREIGN_TAIL.test(name), karma: /^Karma$/i.test(name) });
  }
  return out;
}

// ---------- 单城市页 → canonical race.card/v2 ----------
function cellsOf(rowHtml) {
  const out = new Map();
  for (const m of rowHtml.matchAll(/<td class="gunluk-GunlukYarisProgrami-([A-Za-z0-9_]+)"[^>]*>([\s\S]*?)<\/td>/g)) out.set(m[1], m[2]);
  return out;
}

// 「父 - 母 / 母父 (国)」→ { sire, dam, bms }（各段可能缺，国码只出现在父/母父上）
// 源站在名字后打 `*`（「TEMPLE CITY*」= 站方自己的注记，不是马名的一部分）→ 一律剥掉
function originOf(raw) {
  const s = norm(raw).replace(/\*/g, "");
  if (!s) return { sire: null, dam: null, bms: null };
  const slash = s.split(/\s*\/\s*/);
  const dash = slash[0].split(/\s+-\s+/);
  const pick = (x) => {
    const t = String(x ?? "").trim();
    if (!t) return null;
    const m = t.match(/^(.*?)\s*\(([A-Z]{2,3})\)$/);
    return m ? { name: m[1].trim(), country: m[2] } : { name: t, country: null };
  };
  return { sire: pick(dash[0]), dam: pick(dash[1]), bms: pick(slash[1]) };
}

function idOf(cell, param, prefix) {
  const v = String(cell ?? "").match(new RegExp(`QueryParameter_${param}=(\\d+)`))?.[1];
  return v ? `${prefix}${v}` : null;
}
const fullNameOf = (cell) => {
  const t = String(cell ?? "").match(/title="([^"]*)"/)?.[1];
  return decodeEntities(t ?? norm(cell)) || null;
};

function runnerOf(rowHtml) {
  const c = cellsOf(rowHtml);
  const horseCell = c.get("AtAdi") ?? "";
  const horseName = norm(horseCell.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? horseCell)
    .replace(/\(\d+\)$/, "")
    .trim();
  const pos = horseCell.match(/<span title="[^"]*">\s*\((\d+)\)\s*<\/span>/)?.[1] ?? null;
  // 装具：短码 + 悬浮说明成对给出。源站自身有渲染缺陷（Hood 的说明被写成「Hood' style」）→ 按短码收敛
  const gear = [...horseCell.matchAll(/id='aciklamaFancyShrt'\s*>([^<]+)<\/span>\s*<a class='tooltiptextt'[^>]*>([^<]*)</g)].map((m) => {
    const code = decodeEntities(m[1]).trim().toUpperCase();
    return { code, name: GEAR_NAME[code] ?? norm(m[2]).replace(/'?\s*style\s*$/i, "").trim() };
  });

  const jockeyCell = c.get("JokeAdi") ?? "";
  const trainerCell = c.get("AntronorAdi") ?? "";
  const ownerCell = c.get("SahipAdi") ?? "";
  const ownerId = ownerCell.match(/QueryParameter_SahipId=(\d+)/)?.[1] ?? null;
  const weightRaw = norm(c.get("Kilo"));
  const wm = weightRaw.match(/^([\d.,]+)\s*(?:\+\s*([\d.,]+))?/);
  const yas = parseAgeSex(norm(c.get("YasEN")));
  const agf = norm(c.get("AGFORAN")).match(/%?([\d.,]+)\s*\((\d+)\)/);
  const startRaw = norm(c.get("StartId"));

  return {
    num: num(norm(c.get("SiraId"))),
    frame: null, // 土耳其无 8 枠制
    horse: { id: idOf(horseCell, "AtId", "tjk:"), name: horseName || null },
    sex: yas?.sex ?? null,
    age: yas?.age ?? null,
    color: yas?.colour ?? null,
    jockey: jockeyCell ? { id: idOf(jockeyCell, "JokeyId", "tjk:j"), name: fullNameOf(jockeyCell) } : null,
    weight: wm ? Number(wm[1].replace(",", ".")) : null,
    weightRaw: weightRaw || null,
    weightOver: wm?.[2] ? Number(wm[2].replace(",", ".")) : null, // 「+0.40 Fazla Kilo」= 超出申报负重
    trainer: trainerCell ? { id: idOf(trainerCell, "AntrenorId", "tjk:t"), name: fullNameOf(trainerCell) } : null,
    owner: ownerCell ? { id: idOf(ownerCell, "SahipId", "tjk:o"), name: fullNameOf(ownerCell) } : null,
    breeder: null, // 节目页无
    sire: null, // 由 parseProgramHtml 统一填（父/母/母父在同一列）
    dam: null,
    bms: null,
    sireSire: null, // 采集末尾由 resolveSireSire 借 At Sorgulama 补全（节目页没有这一层）
    // 近走：节目页只公布近 6 走的名次串（「5 2 1」= 最近一走走 5 着，0 = 10 名外），
    // 没有日期/场地/距离 → 只填 rank，让日历「前走」列不至于全空
    recent: (norm(c.get("Son6Yaris")) || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((x) => ({ rank: x === "0" ? "10着外" : `${x}着` })),
    silk: (() => {
      const href = c.get("FormaKodu")?.match(/href="([^"]+\.jpg)"/)?.[1];
      return href ? { url: href.replace(/^\/\//, "https://"), owner: null, via: "tjk" } : null;
    })(),
    tjk: {
      ownerId: ownerId ? Number(ownerId) : null, // 彩衣图就按 SahipId 命名（/formaftp/{id}.jpg）
      gate: startRaw ? num(startRaw) : null, // St = 闸位（≠ 马番 No）
      outerStart: /\bDS\b/.test(startRaw), // DS = 委员会议决改外枠出发（不是取消资格）
      prefStart: /Tercihli Start/.test(c.get("StartId") ?? ""),
      rating: num(norm(c.get("Hc"))), // RT = 让赛评分
      form: norm(c.get("Son6Yaris")) || null, // 近 6 走：Ç 芝 / K ダ / S 合成 + 名次（0 = 10 名外）
      lr: num(norm(c.get("KGS"))),
      l20: num(norm(c.get("s20"))),
      bestTime: norm(c.get("DERECE")) || null,
      odds: num(norm(c.get("Gny"))), // Gny = 单胜赔率
      agfPct: agf ? Number(agf[1].replace(",", ".")) : null, // AGF = 六重彩人气占比
      agfRank: agf ? +agf[2] : null,
      gear,
      finishPos: pos ? +pos : null, // 赛后节目页会带名次
      raw: { yo: norm(c.get("YasEN")), origin: norm(c.get("Baba")), st: startRaw },
    },
  };
}

export function parseProgramHtml(html, { dateIso, sehirId = null, cityName = null } = {}) {
  // 场地状态：源站分两个 span（草地 / 全天候），别把后面的天气与导出链接一起吞进来
  const turf = norm(html.match(/<span class="raceWeatherGreen">([\s\S]*?)<\/span>/)?.[1] ?? "") || null;
  const fiber = norm(html.match(/<span class="raceWeatherBrown">([\s\S]*?)<\/span>/)?.[1] ?? "") || null;
  const going = [turf, fiber].filter(Boolean).join(" / ") || null;
  const weather = norm(html.match(/Weather\s*:([\s\S]*?)<span style="float: right;">/)?.[1] ?? "") || null;
  const dayLabel = html.match(/\((\d+)\.\s*Race Day\)/)?.[1] ?? null;

  // 场次块：<div id="228573" sehir="İstanbul"> … 到下一个场次块 / 页脚 / 文本结束
  const blocks = [
    ...html.matchAll(/<div id="(\d{6,})" sehir="([^"]*)">([\s\S]*?)(?=<div id="\d{6,}" sehir="|<div class="footer|<\/body>|$)/g),
  ];
  const races = [];

  for (const b of blocks) {
    const raceId = b[1];
    const block = b[3];
    const head = block.match(/<h3 class="race-no">([\s\S]*?)<\/h3>/)?.[1] ?? "";
    const sponsorName = norm(head.match(/<span class="ozelKosuAdi">([\s\S]*?)<\/span>/)?.[1] ?? "") || null;
    // 赛名会插在「5. Race」与时刻之间（「5. Race 16.00 SAKARYA RACE」），故时刻取串末 HH.MM
    const headPlain = norm(head.replace(/<span class="ozelKosuAdi">[\s\S]*?<\/span>/g, " "));
    const hhmm = headPlain.match(/(\d{1,2})[.:](\d{2})\s*$/); // 「1.」后是字母，不会误配
    const raceNo = headPlain.match(/^(\d+)\.\s*Race/) ? +headPlain.match(/^(\d+)\.\s*Race/)[1] : null;

    const cfgHtml = block.match(/<h3 class="race-config">([\s\S]*?)<\/h3>/)?.[1] ?? "";
    const klassCode = norm(cfgHtml.match(/<a class="aciklamaFancy"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "") || null;
    const cfg = norm(cfgHtml);
    const breed = /Purebred Arabians/i.test(cfg) ? "ARAB" : /Thoroughbreds/i.test(cfg) ? "TB" : null;
    const ageCond = cfg.match(/(\d)\s*Years Old(?: And Up)?/i)?.[0] ?? null;
    const sexCond = /\bFillies\b/i.test(cfg) ? "Fillies" : /\bMares\b/i.test(cfg) ? "Mares" : /\bColts\b/i.test(cfg) ? "Colts" : null;
    const distM = cfg.match(/(\d{3,4})\s*(?=Turf|Dirt|Fiber Sand|All Weather)/i);
    const surfRaw = cfg.match(/(Turf|Dirt|Fiber Sand|All Weather)\b/i)?.[1] ?? null;
    const bestTime = cfg.match(/B\.T\.\s*:\s*([\d.]+)/)?.[1] ?? null;

    const table =
      block.match(new RegExp(`<div id="kosubilgisi-${raceId}"[^>]*>[\\s\\S]*?<tbody>([\\s\\S]*?)</tbody>`))?.[1] ?? "";
    const runners = table
      .split(/<tr[^>]*>/)
      .slice(1)
      .map((r) => runnerOf(r))
      .filter((r) => r.num != null || r.horse.name);

    // 血统：父 / 母 / 母父在同一列（Origin），逐行摊平到 runner
    const origins = [...table.matchAll(/<td class="gunluk-GunlukYarisProgrami-Baba"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => originOf(m[1]));
    runners.forEach((r, i) => {
      const o = origins[i];
      if (!o) return;
      r.sire = o.sire ? { id: null, name: o.sire.name, country: o.sire.country } : null;
      r.dam = o.dam ? { id: null, name: o.dam.name } : null;
      r.bms = o.bms ? { id: null, name: o.bms.name, country: o.bms.country } : null;
    });

    const k = klassOfTJK(klassCode, sponsorName);
    const inst = hhmm ? instantAt(dateIso, +hhmm[1], +hhmm[2]) : null;
    const t = hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null;

    races.push({
      no: raceNo,
      startTime: t,
      startTimeTz: TZ,
      startTimeInstant: inst ? isoInZone(inst) : null,
      startTimeLocal: t, // 展示口径与场地口径一致
      name: sponsorName ?? klassCode ?? null,
      surface: SURFACE(surfRaw),
      distance: distM ? +distM[1] : null,
      distanceRaw: distM ? `${distM[1]}m` : null,
      heads: runners.length,
      klass: k.klass,
      klassGroup: k.klassGroup,
      gradeTag: k.gradeTag,
      raceClass: klassCode,
      raceType: "FLAT", // 土耳其无跳栏
      raceKey: raceId,
      status: runners.length ? "entries" : "pending",
      runners,
      tjk: { breed, ageCondition: ageCond, sexCondition: sexCond, bestTime, surfaceRaw: surfRaw, conditions: cfg || null },
    });
  }

  const city = cityName ?? decodeEntities(html.match(/<div class="program" id="([^"]+)"/)?.[1] ?? "");
  return {
    schema: "race.card/v2",
    source: "tjk",
    fetchLayer: "tjk.org",
    sourceKey: `tjk:${sehirId ?? slugify(city)}`,
    date: dateIso,
    track: slugify(city),
    trackId: sehirId ? Number(sehirId) : null,
    venue: city,
    country: "TUR",
    countryLong: "Türkiye",
    scope: "overseas",
    timeZone: TZ,
    localTimeZone: TZ,
    going,
    surfaceRaw: null,
    sourceUrl: null,
    capturedAt: new Date().toISOString(),
    races,
    tjk: { sehirId: sehirId ? Number(sehirId) : null, raceDay: dayLabel, weather },
  };
}

// ---------- 官方 CSV（对账用：场次数 / 时刻 / 距离 / 场地 / 比赛格码） ----------
export function parseProgramCsv(csv) {
  const text = String(csv ?? "").replace(/^\uFEFF/, "");
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\d+\.\s*Race/.test(line)) continue;
    const p = line.split(";").map((x) => x.trim());
    const time = p[0].match(/(\d{1,2})[.:](\d{2})\s*$/);
    const di = p.findIndex((x) => /^\d{3,4}m$/.test(x));
    out.push({
      no: +p[0].match(/^(\d+)\./)[1],
      time: time ? `${String(+time[1]).padStart(2, "0")}:${time[2]}` : null,
      klassCode: p[1] ?? null,
      ageBreed: p[2] ?? null,
      distance: di >= 0 ? +p[di].replace("m", "") : null,
      surface: di >= 0 ? p[di + 1] ?? null : null,
    });
  }
  return out;
}

export async function fetchProgramCsv(dateIso, city) {
  const [y, m, d] = dateIso.split("-");
  const url = `${CDN}/raporftp/TJKPDF/${y}/${dateIso}/CSV/GunlukYarisProgrami/${d}.${m}.${y}-${encodeURIComponent(city)}-GunlukYarisProgrami-EN.csv`;
  const txt = await fetchHtmlSoft(url, { src: "tjk-csv", ua: BROWSER_UA, headers: { Accept: "text/csv,*/*;q=0.8" } }).catch(() => null);
  return txt ? { url, races: parseProgramCsv(txt) } : { url, races: null };
}

// ---------- 官方 CSV（赛果）：一城市一次请求拿到全天所有场次的全序着顺 ----------
// 列序（表头 No;Horse Name;Age;Sire;Dam;Weight;Jockey;Owner;Trainer;St;PSF;R;Time;Win;Margin,;LR;L20;BestTime）：
//   注意首列 No **不是马号而是着顺**（CSV 按名次排列，退出马也占末位序号）→ 与出馬表对齐只能靠马名/闸位。
//   St = 闸位（可能带 " - DS" 改外枠出发）；PSF = 人气「%占比(排名)」，双彩池场次是两个值取第一个；
//   Time = 走破时（退出马写 Withdrawn）；Win = 独赢赔率（土耳其小数逗号）；Margin = 着差（Lengths/半马身/鼻/颈）。
export function parseResultCsv(csv) {
  const text = String(csv ?? "").replace(/^\uFEFF/, "");
  const byNo = new Map();
  let cur = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.split(";").map((x) => x.trim());

    const head = line.match(/^(\d+)\.\s*Race\b/);
    if (head) {
      const times = [...p[0].matchAll(/(\d{1,2})[.:](\d{2})/g)];
      const t = times.at(-1);
      const di = p.findIndex((x) => /^\d{3,4}m$/.test(x));
      cur = {
        no: +head[1],
        startTime: t ? `${String(+t[1]).padStart(2, "0")}:${t[2]}` : null,
        klassCode: p[1] || null,
        ageBreed: p[2] || null,
        distance: di >= 0 ? +p[di].replace("m", "") : null,
        surface: di >= 0 ? (p[di + 1] || null) : null,
        bestTime: line.match(/Best Timing\s*:\s*([\d.:]+)/)?.[1] ?? null,
        winningTime: null,
        rows: [],
      };
      byNo.set(cur.no, cur);
      continue;
    }
    if (!cur) continue;
    if (p[0] === "No" || p[0] === "Prize" || /^\d+\.\)/.test(p[0])) continue; // 表头 / 奖金行
    if (!/^\d+$/.test(p[0]) || !p[1]) continue;

    const finishRank = +p[0];
    const withdrawn = /^Withdrawn$/i.test(p[12] ?? "") || /\(Withdrawn\)/i.test(p[1]);
    const timeOk = /^\d{1,2}:\d{2}(?:\.\d+)?$/.test(p[12] ?? "");
    const row = {
      // 着顺：退出马（Withdrawn）在 CSV 里仍占末位序号，改用异常码「取」而不是名次
      finish: withdrawn ? "取" : finishRank,
      finishRank,
      nameRaw: p[1].replace(/\s*\(Withdrawn\)/i, "").trim(), // 带装备码，由采集端按本地马名剥离匹配
      ageCode: p[2] || null,
      sire: p[3] || null,
      dam: p[4] || null,
      ...parseWeightCell(p[5]),
      jockey: p[6] || null,
      owner: p[7] || null,
      trainer: p[8] || null,
      ...parseStartCell(p[9]),
      ...parseAgfCell(p[10]),
      rating: /^\d+$/.test(p[11] ?? "") ? +p[11] : null,
      time: timeOk ? p[12] : null,
      winOdds: trNum(p[13]),
      margin: marginText(p[14]),
    };
    if (row.finish === 1 && row.time) cur.winningTime = row.time;
    cur.rows.push(row);
  }

  return [...byNo.values()].sort((a, b) => a.no - b.no);
}

export async function fetchResultCsv(dateIso, city) {
  const [y, m, d] = dateIso.split("-");
  const url = `${CDN}/raporftp/TJKPDF/${y}/${dateIso}/CSV/GunlukYarisSonuclari/${d}.${m}.${y}-${encodeURIComponent(city)}-GunlukYarisSonuclari-EN.csv`;
  const txt = await fetchHtmlSoft(url, { src: "tjk-csv", ua: BROWSER_UA, headers: { Accept: "text/csv,*/*;q=0.8" } }).catch(() => null);
  return txt ? { url, races: parseResultCsv(txt) } : { url, races: null };
}

// 土耳其小数逗号：16,60 → 16.6
function trNum(s) {
  const m = String(s ?? "").match(/^-?[\d.,]+/);
  if (!m) return null;
  const t = m[0];
  // 末段 2 位且无千分点歧义时按小数处理（16,60 / 2,5）；"595.000" 这类千分位不在本列出现
  const v = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(v) ? v : null;
}

// 负重「51,5 +1.10」→ weight 51.5（+1.10 = 超出申报负重）
function parseWeightCell(s) {
  const m = String(s ?? "").match(/^([\d.,]+)\s*(?:\+\s*([\d.,]+))?/);
  if (!m) return { weight: null, weightRaw: s || null, weightOver: null };
  const num = (x) => Number(String(x).replace(",", "."));
  return {
    weight: Number.isFinite(num(m[1])) ? num(m[1]) : null,
    weightRaw: s || null,
    weightOver: m[2] ? (Number.isFinite(num(m[2])) ? num(m[2]) : null) : null,
  };
}

// 闸位「4」「13 - DS」→ gate 4 / outerStart（DS = 委员会议决改外枠出发，不是取消资格）
function parseStartCell(s) {
  const t = String(s ?? "").trim();
  const m = t.match(/^(\d+)/);
  return { gate: m ? +m[1] : null, outerStart: /\bDS\b/.test(t) };
}

// 人气「%4.16(9)」/ 双彩池「%22.86(1)  %25.76(1)」→ 取第一个
function parseAgfCell(s) {
  const m = String(s ?? "").match(/%\s*([\d.]+)\s*\(\s*(\d+)\s*\)/);
  return m ? { agfPct: Number(m[1]), agfRank: +m[2] } : { agfPct: null, agfRank: null };
}

// 着差：与日本源口径一致（马身用数字、鼻/颈/头用单字）
function marginText(s) {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const len = t.match(/^([\d.,]+)\s*Lengths?$/i);
  if (len) return len[1].replace(",", ".");
  if (/^Half\s*Length$/i.test(t)) return "0.5";
  if (/^Nose$/i.test(t)) return "鼻";
  if (/^Neck$/i.test(t)) return "颈";
  if (/^(Short\s*)?Head$/i.test(t)) return "头";
  return t;
}

// ---------- 彩衣：/formaftp/{SahipId}.jpg（同一马主跨场同名 → 按马主 id 缓存，重采 0 请求） ----------
const SILKS_DIR = path.resolve("data", "silks");
let silkStore = null;
const silkStoreOf = () => (silkStore ??= pedCache(path.resolve("data", "pedigree", "tjk-silk.json")));

export async function tjkSilk(ownerId, delayMs = 0, log = () => {}) {
  if (!ownerId) return null;
  const store = silkStoreOf();
  const key = String(ownerId);
  const cached = store.get(key);
  if (cached) return cached.miss ? null : { url: cached.file, owner: { id: `tjk:o${key}`, name: null }, via: "tjk" };
  const got = await fetchBuffer(`${CDN}/formaftp/${key}.jpg`, { src: "tjk-silk" }).catch(() => null);
  if (delayMs) await sleep(delayMs);
  if (!got) {
    store.set(key, { miss: 1 });
    return null;
  }
  const file = `tjk-o${key}.jpg`;
  const abs = path.join(SILKS_DIR, file);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(SILKS_DIR, { recursive: true });
    fs.writeFileSync(abs, got.buf);
  }
  const rel = `data/silks/${file}`;
  store.set(key, { file: rel, bytes: got.buf.length });
  log(`[silk] tjk owner ${key} → ${rel}`);
  return { url: rel, owner: { id: `tjk:o${key}`, name: null }, via: "tjk" };
}

// ---------- 连通性自检 ----------
export async function probe() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [y, m, d] = today.split("-");
  const rb = await fetchHtmlSoft(`${BASE}/robots.txt`, { src: "tjk-robots", ua: BROWSER_UA }).catch(() => null);
  const idx = await fetchHtmlSoft(
    `${BASE}/EN/YarisSever/Info/Page/GunlukYarisProgrami?QueryParameter_Tarih=${d}%2F${m}%2F${y}`,
    { src: "tjk", ua: BROWSER_UA }
  ).catch(() => null);
  const cities = idx ? parseIndexCities(idx) : [];
  return {
    robots: rb ? { disallowAll: /User-agent:\s*\*[\s\S]{0,80}?Disallow:\s*\//i.test(rb), bytes: rb.length } : null,
    index: { ok: Boolean(idx), cities: cities.length, turkish: cities.filter((c) => !c.foreign && !c.karma).length },
  };
}

// ---------- 祖父（父父）补全：借 TJK 自家「At Sorgulama」按父名反查父的父 ----------
// 节目页只给「父 - 母 / 母父」，没有父的父。TJK 的 At Sorgulama（马籍查询）结果行带
// Orijin(Baba-Anne) 列，形如「KITTEN'S JOY (USA) - GATA BELLA (USA)」= 该马的父 - 母，
// 所以「按父名查一次」就等于拿到本行的祖父。
//
// 为什么不用 JBIS（rp 源的 enrichSireSire 那条路）：土耳其本国配种的种公马
// （ÖZHABER / AŞIKBEY / GÜMBÜRGÜMBÜR …）与阿拉伯马在 JBIS 基本没有记录，而 TJK 马籍库
// 覆盖本国全部马匹（含进口种公马）。成本：父名去重后 30–60 个/城市日（全国 150 上下），
// 结果按父名缓存 data/pedigree/tjk-sire.json，跨日复用 —— 第二天起 0 请求。
//
// 宁缺勿错：同名多匹且父不同 → 不填（记 ambiguous 进缓存，留待人工裁决），
// 与 lib/horse-lookup.js 的口径一致。国码 / 品种 / 性别三处交叉校验：
//   · 卡上「SMART ROBIN (JPN)」的 (JPN) 必须与结果行一致（结果行不带国码则放行）
//   · 场次品种 ARAB/TB → İngiliz/Arap，命中即收窄（同名阿拉伯马与英纯血不混）
//   · 父位只可能是牡马（Cinsiyet = Erkek；Dişi / İğdiş 一律否掉）
const AT_QUERY = `${BASE}/TR/YarisSever/Query/Data/Atlar`;
const IRK = { ARAB: "Arap", TB: "İngiliz" };
// 源站注记星号（「TEMPLE CITY*」）与国码后缀都不是马名的一部分
const clean = (s) => decodeEntities(String(s ?? "")).replace(/\*/g, "").replace(/\s+/g, " ").trim();
const countryOf = (s) => decodeEntities(String(s ?? "")).match(/\(([A-Z]{2,3})\)\s*$/)?.[1] ?? null;
const bare = (s) => clean(s).replace(/\s*\([A-Z]{2,3}\)\s*$/, "").trim();
// 比对键：去国码、去撇号/标点、土耳其字符折 ASCII、小写（DEEP IMPACT (JPN) == Deep Impact）
const nameKey = (s) =>
  bare(s)
    .replace(/['’`´.]/g, "")
    .replace(/[ıİşŞğĞçÇöÖüÜâ]/g, (c) => TR_FOLD[c] ?? c)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/** At Sorgulama 结果表 → [{ name, irk, sex, origin }]（name 含国码，origin = 「父 - 母」原文） */
export function parseHorseQueryRows(html) {
  const rows = [];
  for (const tr of String(html ?? "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = {};
    for (const td of tr[1].matchAll(/<td[^>]*class="sorgu-Atlar-([A-Za-z]+)"[^>]*>([\s\S]*?)<\/td>/g)) {
      // 名字后的 <sup>%</sup> 是「75% 奖金率」角标，不是名字的一部分
      cells[td[1]] = norm(td[2].replace(/<sup[\s\S]*?<\/sup>/g, " "));
    }
    if (!cells.AtIsmi) continue;
    rows.push({ name: cells.AtIsmi, irk: cells.IrkAdi ?? null, sex: cells.Cinsiyet ?? null, origin: cells.BabaAdi ?? "" });
  }
  return rows;
}

/** 「KITTEN'S JOY (USA) - GATA BELLA (USA)」→ { name: "KITTEN'S JOY", country: "USA" } */
export function sireOfOriginCell(v) {
  const s = clean(norm(v));
  if (!s) return null;
  const seg = s.split(/\s+-\s+/)[0].trim();
  if (!seg) return null;
  const c = seg.match(/^(.*?)\s*\(([A-Z]{2,3})\)$/);
  return c ? { name: c[1].trim(), country: c[2] } : { name: seg, country: null };
}

/** 结果行 + 期望（父名/国码/品种）→ { sire } | { miss } | { ambiguous, candidates } */
export function pickSireSire(rows, { name, country = null, breed = null } = {}) {
  const k = nameKey(name);
  if (!k) return { miss: 1 };
  let cands = (rows ?? []).filter((r) => nameKey(r.name) === k);
  // 国码：先认「同国」的行，没有再退到没标国码的行（卡上 (AUS) 时不能混进无国码的同名阿拉伯马）
  if (country) {
    const same = cands.filter((r) => countryOf(r.name) === country);
    const noCc = cands.filter((r) => !countryOf(r.name));
    cands = same.length ? same : noCc;
  }
  // 父位只可能是牡马：有性别值的一律按 Erkek 过（Dişi / İğdiş 直接否掉），全无性别信息才放行
  const sexed = cands.filter((r) => r.sex);
  if (sexed.length) cands = cands.filter((r) => r.sex === "Erkek");
  const wantIrk = breed ? IRK[breed] ?? null : null;
  if (wantIrk) {
    const byIrk = cands.filter((r) => r.irk === wantIrk);
    if (byIrk.length) cands = byIrk;
  }
  if (!cands.length) return { miss: 1 };
  const opts = cands.map((r) => sireOfOriginCell(r.origin)).filter(Boolean);
  const uniq = new Map(opts.map((o) => [nameKey(o.name), o]));
  if (uniq.size === 1) return { sire: [...uniq.values()][0] };
  if (uniq.size === 0) return { miss: 1 };
  return { ambiguous: 1, candidates: cands.map((r) => `${r.name}｜${r.origin}`).slice(0, 5) };
}

/**
 * 给一批文档补 runner.sireSire（父父）。原地改 runners，返回统计。
 * @param {object[]} docs
 * @param {{delayMs?:number, log?:Function}} [o]
 */
export async function resolveSireSire(docs, { delayMs = 1000, log = console.log } = {}) {
  const cache = pedCache(path.resolve("data", "pedigree", "tjk-sire.json"));
  const need = new Map(); // 父名比对键 → { name, country, breed }
  for (const doc of docs)
    for (const race of doc.races ?? []) {
      const breed = race.tjk?.breed ?? null;
      for (const r of race.runners ?? []) {
        if (!r.sire?.name) continue;
        const k = nameKey(r.sire.name);
        if (!k) continue;
        const e = need.get(k) ?? { name: r.sire.name, country: r.sire.country ?? null, breed };
        if (!e.country && r.sire.country) e.country = r.sire.country;
        if (!e.breed && breed) e.breed = breed;
        need.set(k, e);
      }
    }
  const stat = { names: need.size, queried: 0, hit: 0, miss: 0, ambiguous: 0, filled: 0, heads: 0, jbis: 0 };
  if (!need.size) return stat;

  const answers = new Map(); // 父名比对键 → { name, country }
  const missed = []; // TJK 马籍库查无（多为只进口冻精、未在土耳其登记的种公马）→ 走 JBIS 兜底
  for (const [k, e] of need) {
    let rec = cache.get(k);
    if (!rec) {
      const url = `${AT_QUERY}?QueryParameter_AtIsmi=${encodeURIComponent(bare(e.name))}`;
      const html = await fetchHtmlSoft(url, { src: "tjk-sire", ua: BROWSER_UA }).catch(() => null);
      await sleep(delayMs);
      stat.queried++;
      // 网络失败 ≠ 查无此马：不缓存，留给下次（否则会把限流写成终态）
      if (html == null) {
        log(`[siresire] ${e.name} → 查询失败（未缓存，稍后重试）`);
        continue;
      }
      let rows = parseHorseQueryRows(html);
      // 已故种公马（TURBO / KAIZBERT …）不在默认名单里：默认查询 0 命中时带 OLDUFLG=on 再查一次
      if (!rows.some((r) => nameKey(r.name) === k)) {
        const html2 = await fetchHtmlSoft(`${url}&QueryParameter_OLDUFLG=on`, { src: "tjk-sire", ua: BROWSER_UA }).catch(() => null);
        await sleep(delayMs);
        stat.queried++;
        if (html2) rows = rows.concat(parseHorseQueryRows(html2));
      }
      const picked = pickSireSire(rows, e);
      rec = { key: k, name: bare(e.name), ...picked, capturedAt: new Date().toISOString() };
      cache.set(k, rec);
      if (rec.sire) stat.hit++;
      else if (rec.ambiguous) stat.ambiguous++;
      else stat.miss++;
      log(
        rec.sire
          ? `[siresire] ${rec.name} → 父 ${rec.sire.name}${rec.sire.country ? ` (${rec.sire.country})` : ""}`
          : rec.ambiguous
            ? `[siresire] ${rec.name} → 同名多匹且父不同，留空待裁决：${rec.candidates.join(" / ")}`
            : `[siresire] ${rec.name} → 马籍库查无此马，转 JBIS`
      );
    }
    if (rec?.sire) answers.set(k, rec.sire);
    // JBIS 也查过的（jbisMissAt 在 30 天内）不再重复请求，避免天天白跑
    else if (rec?.miss && !(rec.jbisMissAt && (Date.now() - Date.parse(rec.jbisMissAt)) / 864e5 < 30)) missed.push([k, e]);
  }
  // ② JBIS 兜底：TJK 马籍库里没有这匹马时（只进口冻精、未在土耳其登记配种的种公马），
  //    借道 JBIS 馬検索（与 rp 源同一套名字解析缓存 data/pedigree/name-lookup.json）。
  //    命中后父父是日文表记，但 build 侧 alias 会把两侧归到同一个 JBIS id，筛选仍然互通。
  if (missed.length) {
    let lookup = null;
    try {
      let preferred = null;
      try {
        preferred = preferredMapFromSireCache(JSON.parse(fs.readFileSync(path.resolve("data", "pedigree", "jbis-sire.json"), "utf8")));
      } catch {}
      lookup = createHorseLookup({
        cache: pedCache(path.resolve("data", "pedigree", "name-lookup.json")),
        delayMs: 1200,
        preferred,
        homonym: loadHomonym(),
        log,
      });
    } catch (e) {
      log(`[siresire] JBIS 兜底不可用：${e.message}`);
    }
    if (lookup) {
      let jhit = 0;
      for (const [k, e] of missed) {
        const rec2 = await lookup.resolve(bare(e.name), { log, intl: true, asSire: true });
        const a = sireAnswerOf(rec2, true);
        if (!a?.sire?.name) {
          // rec2 非空 = JBIS 明确「查无此马」→ 记 30 天免重试；为空 = 网络/限流失败，下轮再试
          if (rec2) {
            const cur = cache.get(k) ?? { key: k, name: bare(e.name), miss: 1 };
            cur.jbisMissAt = new Date().toISOString().slice(0, 10);
            cache.set(k, cur);
          }
          continue;
        }
        const rec = {
          key: k,
          name: bare(e.name),
          sire: { id: a.sire.id ?? null, name: a.sire.name, country: countryOf(a.sire.name) },
          via: "jbis",
          capturedAt: new Date().toISOString(),
        };
        cache.set(k, rec);
        answers.set(k, rec.sire);
        jhit++;
        log(`[siresire] ${rec.name} → 父 ${rec.sire.name} [JBIS]`);
      }
      lookup.save();
      stat.jbis = jhit;
      log(`[siresire] JBIS 兜底命中 ${jhit}/${missed.length}`);
    }
  }

  for (const doc of docs)
    for (const race of doc.races ?? [])
      for (const r of race.runners ?? []) {
        stat.heads++;
        if (!r.sire?.name) continue;
        const a = answers.get(nameKey(r.sire.name));
        if (!a) continue;
        r.sireSire = { id: null, name: a.name, country: a.country ?? null };
        stat.filled++;
      }

  cache.save();
  log(
    `[siresire] 父父补完 ${stat.filled}/${stat.heads} 頭 / 父名 ${stat.names} 个` +
      `（本次请求 ${stat.queried}，命中 ${stat.hit}，查无 ${stat.miss}${stat.jbis ? `（JBIS 兜底 ${stat.jbis}）` : ""}，同名歧义 ${stat.ambiguous}）`
  );
  return stat;
}

// ---------- 采集 ----------
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const todayInTz = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/**
 * @param {object} o
 * @param {string[]} o.dates      比赛日（YYYY-MM-DD，欧洲/伊斯坦布尔）；缺省 = 今天 + 明天
 *                                （TJK 出馬表通常提前 1–2 日发布，两天窗口够覆盖 CI 日跑）
 * @param {string[]|null} o.tracks 场地过滤（场地名 / slug / SehirId，小写比对）
 * @param {number} o.limit        最多抓几个城市页（0 = 不限）
 * @param {number} o.delayMs      城市页之间间隔
 * @param {boolean} o.silk        是否下载彩衣图
 * @param {boolean} o.pedigree    是否补父父（借 At Sorgulama，一父名 1 请求，带缓存）
 * @returns [{ date, file, doc }]
 */
export async function collect({ dates = null, tracks = null, limit = 0, delayMs = 2000, silk = true, pedigree = true, log = console.log } = {}) {
  const days = dates?.length ? dates : [todayInTz(), addDays(todayInTz(), 1)];
  const out = [];
  let fetched = 0;

  for (const dateIso of days) {
    const [y, m, d] = dateIso.split("-");
    const trDate = `${d}/${m}/${y}`;
    const idxUrl = `${BASE}/EN/YarisSever/Info/Page/GunlukYarisProgrami?QueryParameter_Tarih=${encodeURIComponent(trDate)}`;
    const idxHtml = await fetchHtmlSoft(idxUrl, { src: "tjk", ua: BROWSER_UA }).catch(() => null);
    if (!idxHtml) {
      log(`[index] ${dateIso} 索引页失败／当日无节目`);
      continue;
    }
    const cities = parseIndexCities(idxHtml).filter((c) => !c.foreign && !c.karma);
    const picked = tracks
      ? cities.filter((c) => tracks.some((t) => {
          const k = String(t).toLowerCase();
          return k === String(c.id) || k === c.name.toLowerCase() || k === slugify(c.name);
        }))
      : cities;
    log(`[index] ${dateIso} 本国场地 ${cities.length} → 选中 ${picked.length}（${picked.map((c) => c.name).join(", ") || "-"}）`);

    for (const c of picked) {
      if (limit && fetched >= limit) break;
      const url = `${BASE}/EN/YarisSever/Info/Sehir/GunlukYarisProgrami?SehirId=${c.id}&QueryParameter_Tarih=${encodeURIComponent(trDate)}&SehirAdi=${encodeURIComponent(c.name)}`;
      const html = await fetchHtmlSoft(url, { src: "tjk", ua: BROWSER_UA }).catch(() => null);
      await sleep(delayMs);
      if (!html) {
        log(`[city] ${c.name}(${c.id}) 抓取失败 → 跳过`);
        continue;
      }
      fetched++;

      const doc = parseProgramHtml(html, { dateIso, sehirId: c.id, cityName: c.name });
      doc.sourceUrl = url;

      if (silk) {
        for (const race of doc.races) {
          for (const r of race.runners) {
            if (!r.tjk?.ownerId) continue;
            const s = await tjkSilk(r.tjk.ownerId, 0, log);
            if (s) r.silk = s;
          }
        }
        // 同一马主在同日多处出现 → 上面已按 ownerId 缓存，重复调用 0 请求
      }

      const heads = doc.races.reduce((n, r) => n + r.heads, 0);
      log(`[race] ${dateIso} ${doc.venue}(${c.id}) ${doc.races.length} R / ${heads} 頭 / going=${doc.going ?? "-"}`);
      out.push({ date: dateIso, file: `tjk-${c.id}.json`, doc });
    }
    if (limit && fetched >= limit) break;
  }

  if (silkStore) silkStore.save();
  // 父父（祖父）补全：节目页没有这一层，借马籍查询按父名反查（缓存跨日复用）
  if (pedigree && out.length) await resolveSireSire(out.map((u) => u.doc), { log });
  return out;
}
