// TurfeOnline（turfeonline.com.br，巴西赛马媒体）比赛源适配器（docs/DESIGN.md §8）
//
// ## 站点结构（2026-11-17 实测）
// - Joomla 站点。索引页 `/programas`（Joomla 分页 ?start=20…）按时间倒序列出
//   「Programação {Venue} ({d}/{m}/{Y})」文章，URL `/programas/{id}-{timestamp}`。
// - 文章正文为纯文本行式（无表格）：
//     CORRIDAS DE {星期}, {d}/{m}/{Y}.
//     REUNIÃO Nº 2020.
//     1º   PÁREO – ÀS 18:00 – 1.500 (GRAMA)
//     PRÊMIO   EREBUS
//     1 / UNO VALLIENTE / V.BORGES / 58 / 1      ← 马号 / 马名 / 骑师 / 负磅 / 闸位
//   负磅变体：58（普通）、58/5（见习骑师减 5kg）、52/48（AP 减后 / 基准）。
// - 覆盖 Gávea / Cidade Jardim / Cristal / Tarumã（巴西职业赛马全部主要赛场），
//   发布比赛事日早约 3–7 天 → 满足「当天及次日」。
// - **无血统、无练马师、无马 id**：sire/dam/bms/sireSire 全部留空，
//   血统后续靠 JCB retrospecto PDF 或 stud book 按马名补（宁缺勿错）。
//
// ## 时区
// America/Sao_Paulo（巴西利亚时间，2019 年起无 DST）。
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";
import { instantFromZoned, isoInZone } from "./normalize.js";

export const id = "turfeonline";
export const label = "TurfeOnline (Brasil)";
export const homeUrl = "https://www.turfeonline.com.br/programas";

const BASE = "https://www.turfeonline.com.br";
const TZ = "America/Sao_Paulo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTo(url, src) {
  let html = await fetchHtmlSoft(url, { src, ua: BROWSER_UA, retries: 3 }).catch(() => null);
  if (html) return html;
  await sleep(5000);
  return fetchHtmlSoft(url, { src, ua: BROWSER_UA, retries: 2 }).catch(() => null);
}

// ---------- 文本工具 ----------
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
/** 正文行提取（去 script/style，块级标签换行） */
export function extractLines(html) {
  const text = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|td|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** 「Programação Gávea (17/11/2026)」→ { venue: "Gávea", date: "2026-11-17" }（「1º/11/2026」→ 01 日） */
export function parseTitle(title) {
  const m = String(title ?? "").trim().match(/^Programação\s+(.+?)\s*\((\d{1,2})º?\/(\d{1,2})\/(\d{4})\)\s*$/i);
  if (!m) return null;
  return { venue: m[1].trim(), date: `${m[4]}-${String(+m[3]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}` };
}

const SURFACE = { GRAMA: "芝", AREIA: "ダ", SINTÉTICA: "ダ" };

/**
 * 正文行 → races[]（canonical 片段）
 * 行式约定：场次头「Nº PÁREO – ÀS HH:MM – 1.500 (GRAMA)」；runner 块 = 马号 / 马名 / 骑师 / 负磅 / 闸位。
 * 马名行是纯字母（含空格/重音），负磅行形如 58、58/5、52/48 —— 用「整数行 = 马号计数器」定位块头。
 */
export function parseProgramacao(lines) {
  const races = [];
  let cur = null;

  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, " ");

    // 场次头：1º PÁREO – ÀS 18:00 – 1.500 (GRAMA)
    const head = line.match(/^(\d{1,2})[ºo°]\s*P[ÁA]REO\s*[–—-]\s*[ÀA]S\s*(\d{1,2}:\d{2})\s*[–—-]\s*([\d.,]+)\s*\(([^)]+)\)/i);
    if (head) {
      // REUNIÃO 行先建的占位块（无场次号无马）直接丢弃
      if (cur && (cur.no != null || cur.runners.length)) races.push(finishRace(cur));
      cur = {
        no: +head[1],
        time: head[2],
        dist: head[3].replace(/\./g, "").replace(",", ""),
        surfaceRaw: head[4].trim().toUpperCase(),
        prize: null,
        category: null,
        reunion: null,
        runners: [],
        pending: null,
        expect: 1,
      };
      continue;
    }
    if (!cur) {
      // REUNIÃO Nº 2020.
      const reu = line.match(/^REUNI[ÃA]O\s*N[ºO°]\s*(\d+)/i);
      if (reu) cur = { no: null, time: null, dist: null, surfaceRaw: null, prize: null, category: null, reunion: reu[1], runners: [], pending: null, expect: 1 };
      continue;
    }

    // PRÊMIO 行（奖金名）；CLAIMING/CATEGORIA 行（类别）
    if (/^PR[ÊE]MIO\b/i.test(line)) {
      cur.prize = line.replace(/^PR[ÊE]MIO\s*/i, "").trim() || null;
      continue;
    }
    if (/^(P[ÁA]REO\s+DE\s+\w+|CATEGORIA|HANDICAP|CONDICIONAL|PROVA ESPECIAL|ESPECIAL)\b/i.test(line) && !cur.prize) {
      cur.category = line;
      continue;
    }

    // runner 块：整数行 = 期望马号 → 依次取 马名/骑师/负磅，闸位行核对
    const n = line.match(/^(\d{1,2})$/);
    if (n && !cur.pending && +n[1] === cur.expect && cur.expect <= 20) {
      cur.pending = { num: +n[1], name: null, jockey: null, weightRaw: null };
      cur.expect++;
      continue;
    }
    if (cur.pending) {
      const p = cur.pending;
      if (p.name == null) {
        p.name = line;
      } else if (p.jockey == null) {
        p.jockey = line;
      } else if (p.weightRaw == null) {
        p.weightRaw = line;
        // 负磅下一行是闸位（与马号一致）：吞掉
        cur.runners.push({ ...p });
        cur.pending = null;
      }
    }
  }
  if (cur) races.push(finishRace(cur));
  return races;

  function finishRace(r) {
    return { ...r, dist: r.dist ? +r.dist : null };
  }
}

/** races 片段 + 外壳 → canonical runners */
function toCanonical(race, dateIso, trackSlug = null) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const dist = race.dist ? +race.dist : null;
  const hhmm = race.time?.match(/(\d{1,2}):(\d{2})/);
  const inst = hhmm ? new Date(instantFromZoned(y, m, d, +hhmm[1], +hhmm[2], TZ)) : null;
  const runners = race.runners.map((p) => {
    // 负磅：58 / 58/5（AP 减 5kg）/ 52/48 —— 主值取第一位；原始串保留
    const weight = p.weightRaw?.match(/\d+/)?.[0] != null ? +p.weightRaw.match(/\d+/)[0] : null;
    const ap = p.jockey?.match(/\(AP\.?\s*(\d+)\)/i);
    return {
      num: p.num,
      frame: null, // 巴西 mandil 是马牌号，不是日本枠番
      horse: { id: null, name: p.name ?? null },
      sex: null,
      age: null,
      color: null,
      jockey: { id: null, name: p.jockey ?? null },
      weight: weight,
      weightRaw: p.weightRaw ?? null,
      weightOver: ap ? +ap[1] : null,
      trainer: { id: null, name: null },
      owner: null,
      breeder: null,
      sire: null, // 源无血统（待 JCB retrospecto / stud book 补）
      dam: null,
      bms: null,
      sireSire: null,
      recent: [],
      silk: null,
      tol: { weightRaw: p.weightRaw ?? null, apprentice: ap ? +ap[1] : null },
    };
  });
  const graded = race.prize?.match(/\(G([123])\)/i);
  return {
    no: race.no,
    startTime: hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null,
    startTimeTz: TZ,
    startTimeInstant: inst ? isoInZone(inst, TZ) : null,
    startTimeLocal: hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null,
    name: race.prize ?? race.category ?? null,
    surface: SURFACE[race.surfaceRaw] ?? null,
    distance: dist,
    distanceRaw: race.dist ? `${race.dist}m` : null,
    heads: runners.length,
    klass: graded ? `G${"ⅠⅡⅢ"[+graded[1] - 1]}` : race.category ? race.category.slice(0, 40) : "一般",
    klassGroup: graded ? "重賞" : "一般",
    gradeTag: graded ? `G${"ⅠⅡⅢ"[+graded[1] - 1]}` : null,
    raceClass: race.category,
    raceType: "FLAT",
    // 场次级唯一键。必须带场地：Gávea / Cidade Jardim / Cristal 的场次号都从 1 起，
    // 同一天多场地作赛时 `tol-1` 会撞键（前端分页串场、结果层 join 串马），故拼上场地 slug。
    raceKey: `tol-${trackSlug ?? "x"}-${race.no}`,
    status: runners.length ? "entries" : "pending",
    runners,
    tol: { surfaceRaw: race.surfaceRaw ?? null, categoria: race.category ?? null },
  };
  return dist;
}

// ---------- 采集 ----------
const todayInTz = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const slugOf = (venue) =>
  String(venue).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** 索引页（含分页）→ [{ id, title, venue, date, url }] */
export async function fetchIndex({ pages = 3, log = console.log } = {}) {
  const items = [];
  const seen = new Set();
  for (let p = 0; p < pages; p++) {
    const start = p * 20;
    const url = start ? `${BASE}/programas?start=${start}` : `${BASE}/programas`;
    const html = await fetchTo(url, "tol-index");
    if (!html) {
      log(`[index] 分页 ${p} 抓取失败`);
      break;
    }
    let added = 0;
    for (const m of String(html).matchAll(/<a[^>]+href="([^"]*\/programas\/\d+[^"]*)"[^>]*>([^<]*Programação[^<]*)<\/a>/gi)) {
      const url2 = m[1];
      if (seen.has(url2)) continue;
      seen.add(url2);
      const t = parseTitle(decodeEntities(m[2]));
      if (!t) continue;
      items.push({ url: url2.startsWith("http") ? url2 : `${BASE}/${url2.replace(/^\//, "")}`, ...t });
      added++;
    }
    if (!added) break;
  }
  return items;
}

/**
 * @param {object} o
 * @param {string[]} o.dates 比赛日（YYYY-MM-DD，巴西当地）；缺省 = 今天 + 明天
 * @returns [{ date, file, doc }]
 */
export async function collect({ dates = null, limit = 0, delayMs = 1200, pedigree = false, log = console.log } = {}) {
  const days = new Set(dates?.length ? dates : [todayInTz(), addDays(todayInTz(), 1)]);
  const index = await fetchIndex({ log });
  log(`[index] Programações 共 ${index.length} 篇（近 ${Math.ceil(index.length / 20)} 页）`);
  const picked = index.filter((it) => days.has(it.date));
  const byVenue = new Map(); // 同日同场地可能出现多篇（重发/更正）→ 只取第一篇
  for (const it of picked) {
    const key = `${it.date}:${it.venue}`;
    if (!byVenue.has(key)) byVenue.set(key, it);
  }
  log(`[index] 命中目标日期 ${picked.length} 篇 → 去重后 ${byVenue.size} 场`);

  const out = [];
  let fetched = 0;
  for (const [, it] of byVenue) {
    if (limit && fetched >= limit) break;
    const html = await fetchTo(it.url, "tol-prog");
    await sleep(delayMs);
    if (!html) {
      log(`[race] ${it.date} ${it.venue} 正文抓取失败 → 跳过`);
      continue;
    }
    fetched++;
    const lines = extractLines(html);
    const races = parseProgramacao(lines).map((r) => toCanonical(r, it.date, slugOf(it.venue)));
    const heads = races.reduce((n, r) => n + r.heads, 0);
    if (!heads) {
      log(`[race] ${it.date} ${it.venue} 解析 0 頭（版式变更？）→ 跳过`);
      continue;
    }
    const doc = {
      schema: "race.card/v2",
      source: "turfeonline",
      fetchLayer: "turfeonline.com.br",
      sourceKey: `turfeonline:${slugOf(it.venue)}`,
      date: it.date,
      track: slugOf(it.venue),
      trackId: null,
      venue: it.venue,
      country: "BRA",
      countryLong: "Brasil",
      scope: "overseas",
      timeZone: TZ,
      localTimeZone: TZ,
      going: null,
      surfaceRaw: null,
      sourceUrl: it.url,
      capturedAt: new Date().toISOString(),
      races,
      turfeonline: { titulo: it.title ?? `${it.venue} ${it.date}` },
    };
    log(`[race] ${it.date} ${it.venue} ${races.length} R / ${heads} 頭`);
    out.push({ date: it.date, file: `tol-${slugOf(it.venue)}.json`, doc });
  }
  return out;
}

export async function probe() {
  const items = await fetchIndex({ pages: 1, log: () => {} });
  return { index: { ok: items.length > 0, items: items.length, venues: [...new Set(items.map((i) => i.venue))] } };
}
