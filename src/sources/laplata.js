// La Plata（Hipódromo de La Plata，阿根廷布宜诺斯艾利斯省立赛马场）比赛源适配器（docs/DESIGN.md §8）
//
// ## 站点结构（2026-11-17 实测）
// - 服务端渲染 PHP（无 JSON API）。月历页 `index.php?mes={M}&ano={Y}` 给出当月每个赛日的
//   `busqueda.php?numReu={N}&...&fecha=YYYY-MM-DD` 链接 → 赛日发现 + Reunión 编号。
// - **verTelas.php（列表版式）**：`/h/wsAdmin/programaOficial/verTelas.php?numReu={N}&ano={Y}&fecha={DD-MM-YYYY}`
//   一个页面含整日全部场次 + 全部出马（11 场 103 頭 107KB）→ 每赛日只需 2 个请求。
//   busqueda.php（单场版式）结构相同，仅作单场核对用。
// - 出马表字段：Nº（mandil）、SPC（马名）、父 - 母（padreMadre 行）、P 毛色码、E 年龄、
//   Kg 负磅、Jockey、Entrenador、Caballeriza、Chaq.（彩衣描述）、4Ult.（近 4 跑，Debuta= debut）。
// - 母父/父父：页面没有这两层。血统行只有「父 - 母」→ bms/sireSire 留空（宁缺勿错），
//   后续可借 San Isidro 的 si-horse 缓存或 stud book 按马名补。
//
// ## 时区
// America/Argentina/Buenos_Aires，UTC-3 全年不变。
// 场地是泥地（ARENA），页面不标注场地类型 → surface 恒为 ダ，原值留 null。
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";
import { instantFromZoned, isoInZone, sexFromConditionEs } from "./normalize.js";

export const id = "laplata";
export const label = "La Plata (Argentina)";
export const homeUrl = "https://www.hipodromolaplata.gba.gov.ar/h/index.php";

const BASE = "https://www.hipodromolaplata.gba.gov.ar";
const TZ = "America/Argentina/Buenos_Aires";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAG = "lp";

// 偶发失败兜底（与 sanisidro.js 同策略：长退避一次，仍失败返回 null 留待下次）
async function fetchLp(url, src) {
  let html = await fetchHtmlSoft(url, { src, ua: BROWSER_UA, retries: 3 }).catch(() => null);
  if (html) return html;
  await sleep(5000);
  return fetchHtmlSoft(url, { src, ua: BROWSER_UA, retries: 2 }).catch(() => null);
}

// ---------- 文本工具 ----------
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", iexcl: "¡", uerr: "ü" };
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
const norm = (s) => decodeEntities(String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
const divText = (html, cls) => norm(html.match(new RegExp(`<div class='${cls}'[^>]*>([\\s\\S]*?)</div>`))?.[1] ?? "") || null;
const num = (s) => {
  const m = String(s ?? "").replace(/\s/g, "").match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
};

/** 月历页 → [{ numReu, date, url }]（仅 diaConPrograma 的日子） */
export function parseCalendar(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/href='busqueda\.php\?numReu=(\d+)&mes=\d+&dia=\d+&ano=(\d{4})&fecha=(\d{4}-\d{2}-\d{2})&numeroPremio=1'/g)) {
    out.push({ numReu: +m[1], date: m[3], url: `${BASE}/h/busqueda.php?numReu=${m[1]}&numeroPremio=1` });
  }
  return out;
}

/** 「SHAWERTON - CASERA SEXY」→ { sire, dam }（马名带连字符极少见，取最后一个 " - " 切分） */
export function originOf(s) {
  const t = norm(s);
  if (!t) return { sire: null, dam: null };
  const split = (v) => {
    if (!v) return null;
    const m = v.match(/^(.*?)[\s]*\(([A-Z]{2,3})\)\s*$/);
    return m ? { name: m[1].trim(), country: m[2] } : { name: v, country: null };
  };
  const i = t.lastIndexOf(" - ");
  if (i < 0) return { sire: split(t), dam: null };
  return { sire: split(t.slice(0, i).trim()), dam: split(t.slice(i + 3).trim()) };
}

/** 毛色码（La Plata 用小写字母，z/za? d 等）→ JBIS 近似（原值留 lp.pelajeRaw） */
const COLOUR = { a: "栗毛", z: "青鹿毛", t: "芦毛", r: "駁毛", n: "青毛", c: "栗毛" };

/**
 * verTelas.php / busqueda.php HTML → races[]（canonical 片段，不含外壳）
 * 结构：每场 = 头表（ordenCarrera/hora/nomCarrera/distanciaSinImg/condicion/apuestas）+ grillaBusqueda 出马表。
 */
export function parseReunionHtml(html) {
  const text = String(html ?? "");
  // 场次切块：到下一个 ordenCarrera / 页脚
  const blocks = [...text.matchAll(/<div class='ordenCarrera'>(\d+)[°o]<\/div>([\s\S]*?)(?=<div class='ordenCarrera'>|<div class='info-pestania'>|$)/g)];
  const races = [];

  for (const b of blocks) {
    const no = num(b[1]); // 块切分时已捕获「N°」
    const block = b[2];
    const horaRaw = divText(block, "hora"); // 「14:30h」
    const hhmm = horaRaw?.match(/(\d{1,2}):(\d{2})/);
    const name = (divText(block, "nomCarrera") ?? "").replace(/^Premio:\s*/i, "").trim() || null;
    const distRaw = divText(block, "distanciaSinImg");
    const dist = num(distRaw);
    // 条件文本 = 第 2 个 condicion div（第 1 个在 tdLeft，是双马注/投注周期文本）
    const conds = [...block.matchAll(/<div class='condicion'>([\s\S]*?)<\/div>/g)].map((m) => norm(m[1]));
    const condicion = conds.length > 1 ? conds[1] : (conds[0] ?? null);
    const apuestas = [...block.matchAll(/<div class='apuestas'>([\s\S]*?)<\/div>/g)].map((m) => norm(m[1]));

    // 出马行：9 列固定序 —— 0=CABALLERIZA(马房+彩衣) 1=4Ult.(近跑) 2=Nº 3=SPC(马名+父-母)
    //                        4=P(毛色) 5=E(龄) 6=Kg(负磅) 7=Jockey 8=Entrenador
    // 含 txtNegrita 的 <tr> 才是 runner；filete / record / 分隔行跳过
    const runners = [];
    for (const tr of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const row = tr[1];
      const horseName = norm(row.match(/<div class='txtNegrita'>([\s\S]*?)<\/div>/)?.[1] ?? "");
      if (!horseName) continue;
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      const cells = tds.map((td) => ({
        // 同一 td 里可能出现多个同类 div：按出现次序存档，buildRunner 按列语义取用
        txtleft: [...td.matchAll(/<div class='txtleft'[^>]*>([\s\S]*?)<\/div>/g)].map((m) => norm(m[1])),
        padreMadre: [...td.matchAll(/<div class='padreMadre'>([\s\S]*?)<\/div>/g)].map((m) => norm(m[1])),
        form: norm(td.match(/<div class='txt4ult'>([\s\S]*?)<\/div>/)?.[1] ?? "") || null,
        mandil: norm(td.match(/<div class='mandil'>([\s\S]*?)<\/div>/)?.[1] ?? "") || null,
        pelo: norm(td.match(/<div class='pelo'>([\s\S]*?)<\/div>/)?.[1] ?? "") || null,
        center: [...td.matchAll(/<div class='txtCenter'[^>]*>([\s\S]*?)<\/div>/g)].map((m) => norm(m[1])),
      }));
      runners.push(buildRunner(horseName, cells));
    }

    races.push({ no, horaRaw, hhmm, name, dist, distRaw, condicion, apuestas, runners });
  }
  return races;
}

export function buildRunner(horseName, cells) {
  const c0 = cells[0] ?? {}, c1 = cells[1] ?? {}, c2 = cells[2] ?? {}, c3 = cells[3] ?? {};
  const c4 = cells[4] ?? {}, c5 = cells[5] ?? {}, c6 = cells[6] ?? {}, c7 = cells[7] ?? {}, c8 = cells[8] ?? {};
  // SPC 单元格的 padreMadre = 「父 - 母」（彩衣的 padreMadre 在 0 列）
  const origin = originOf(c3.padreMadre?.[0] ?? "");
  return {
    num: num(c2.mandil) ?? null,
    frame: null,
    horse: { id: null, name: horseName }, // La Plata 页面无马 id，仅名字
    sex: null, // 页面不标性别（只在条件文本里）
    age: num(c3.center?.[0]) ?? num(c5.center?.[0]),
    color: COLOUR[(c4.pelo ?? "").trim().toLowerCase()[0]] ?? null,
    jockey: { id: null, name: c7.txtleft?.[0] ?? null },
    weight: num(c3.center?.[1]) ?? num(c6.center?.[0]),
    weightRaw: c3.center?.[1] ?? c6.center?.[0] ?? null,
    weightOver: null,
    trainer: { id: null, name: c8.txtleft?.[0] ?? null },
    owner: null,
    breeder: null,
    sire: origin.sire?.name ? { id: null, name: origin.sire.name, country: origin.sire.country } : null,
    dam: origin.dam?.name ? { id: null, name: origin.dam.name } : null,
    bms: null, // 本源无母父层
    sireSire: null, // 本源无父父层
    recent: [],
    silk: null,
    lp: {
      form: c1.form ?? null, // 近 4 跑（「Debuta」= 首次出场）
      pelajeRaw: c4.pelo ?? null,
      caballeriza: c0.txtleft?.[0] ?? null,
      chaq: c0.padreMadre?.[0] ?? null,
    },
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
 * @param {string[]} o.dates 比赛日（YYYY-MM-DD，阿根廷当地）；缺省 = 今天 + 明天
 * @returns [{ date, file, doc }]
 */
export async function collect({ dates = null, limit = 0, delayMs = 1500, pedigree = false, log = console.log } = {}) {
  const days = dates?.length ? dates : [todayInTz(), addDays(todayInTz(), 1)];
  const out = [];
  let fetched = 0;
  const calCache = new Map(); // "Y-M" → reunion map

  for (const dateIso of days) {
    const [y, m] = dateIso.split("-").map(Number);
    const calKey = `${y}-${m}`;
    let reunions = calCache.get(calKey);
    if (!reunions) {
      const html = await fetchLp(`${BASE}/h/index.php?mes=${m}&ano=${y}`, "lp-cal");
      if (!html) {
        log(`[cal] ${calKey} 月历抓取失败`);
        reunions = new Map();
      } else {
        reunions = new Map(parseCalendar(html).map((r) => [r.date, r]));
        log(`[cal] ${calKey} 当月赛日 ${reunions.size} 个`);
      }
      calCache.set(calKey, reunions);
      await sleep(delayMs);
    }
    const reu = reunions.get(dateIso);
    if (!reu) {
      log(`[index] ${dateIso} 当日无节目`);
      continue;
    }
    const [dd, mm] = [dateIso.slice(8, 10), dateIso.slice(5, 7)];
    const url = `${BASE}/h/wsAdmin/programaOficial/verTelas.php?numReu=${reu.numReu}&ano=${y}&fecha=${dd}-${mm}-${y}`;
    const html = await fetchLp(url, "lp-tela");
    await sleep(delayMs);
    if (!html) {
      log(`[race] ${dateIso} Reunión ${reu.numReu} 节目页抓取失败 → 跳过`);
      continue;
    }
    fetched++;
    const parsed = parseReunionHtml(html);

    const races = [];
    for (const p of parsed) {
      const inst = p.hhmm ? new Date(instantFromZoned(+y, +m, +dateIso.slice(8, 10), +p.hhmm[1], +p.hhmm[2], TZ)) : null;
      // 页面不逐马标性别；条件文本限定单性组时推断赛事级性别（Potrancas/Yeguas→牝 等）
      const sexInferred = sexFromConditionEs(p.condicion);
      races.push({
        no: p.no,
        startTime: p.hhmm ? `${String(+p.hhmm[1]).padStart(2, "0")}:${p.hhmm[2]}` : null,
        startTimeTz: TZ,
        startTimeInstant: inst ? isoInZone(inst, TZ) : null,
        startTimeLocal: p.hhmm ? `${String(+p.hhmm[1]).padStart(2, "0")}:${p.hhmm[2]}` : null,
        name: p.name,
        surface: "ダ", // La Plata 全泥地，页面不标注
        distance: p.dist,
        distanceRaw: p.distRaw,
        heads: p.runners.length,
        klass: p.name?.match(/\b(G[123])\b/)?.[1] ? `G${"ⅠⅡⅢ"[+p.name.match(/\bG([123])\b/)[1] - 1]}` : p.name?.match(/\(G([123])\)/)?.[1] ? `G${"ⅠⅡⅢ"[+p.name.match(/\(G([123])\)/)[1] - 1]}` : "一般",
        klassGroup: /\bG[123]\b|\(G[123]\)/.test(p.name ?? "") ? "重賞" : "一般",
        gradeTag: /\bG[123]\b|\(G[123]\)/.test(p.name ?? "") ? p.name.match(/G([123])/)[1] && `G${"ⅠⅡⅢ"[+p.name.match(/G([123])/)[1] - 1]}` : null,
        raceClass: null,
        raceType: "FLAT",
        // raceKey 必须场次级唯一：Reunión 号整日共用一个，前端按 raceKey 分页会把 11 场并成一场
        raceKey: `laplata-${dateIso}-R${p.no}`,
        status: p.runners.length ? "entries" : "pending",
        runners: p.runners.map((x) => (x.sex ? x : { ...x, sex: sexInferred })),
        lp: { numReu: reu.numReu, condicion: p.condicion, apuestas: p.apuestas.length ? p.apuestas : null, sexSource: sexInferred ? "condicion" : null },
      });
    }

    const doc = {
      schema: "race.card/v2",
      source: "laplata",
      fetchLayer: "hipodromolaplata.gba.gov.ar",
      sourceKey: "laplata:1",
      date: dateIso,
      track: "la-plata",
      trackId: 1,
      venue: "La Plata",
      country: "ARG",
      countryLong: "Argentina",
      scope: "overseas",
      timeZone: TZ,
      localTimeZone: TZ,
      going: null,
      surfaceRaw: null,
      sourceUrl: url,
      capturedAt: new Date().toISOString(),
      races,
      laplata: { numReu: reu.numReu, fecha: dateIso },
    };
    const heads = races.reduce((n, r) => n + r.heads, 0);
    log(`[race] ${dateIso} La Plata Reunión ${reu.numReu} ${races.length} R / ${heads} 頭`);
    out.push({ date: dateIso, file: `${TAG}-1.json`, doc });
    if (limit && fetched >= limit) break;
  }
  return out;
}

export async function probe() {
  const now = todayInTz();
  const [y, m] = now.split("-").map(Number);
  const html = await fetchLp(`${BASE}/h/index.php?mes=${m}&ano=${y}`, "lp-probe");
  const reus = html ? parseCalendar(html) : [];
  return { calendar: { ok: Boolean(html), month: `${y}-${m}`, meetings: reus.length } };
}
