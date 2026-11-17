// San Isidro（Hipódromo de San Isidro，阿根廷布宜诺斯艾利斯）比赛源适配器（docs/DESIGN.md §8）
//
// ## 站点结构（2026-11-17 实测）
// - WordPress + Inertia 式前端：每个页面把组件数据内嵌在
//   `<script data-page="app" type="application/json">` 里（UTF-8，无需解析 HTML 表格）。
// - 按日期的官方节目：`/programacion/programa-oficial/{YYYY-MM-DD}`（无节目日 404）
//   → props.reunion.premios[] = 场次（含 inscricpiones[] 出马表）。
// - 马详情页：`/programacion/ejemplares/{id}` → props.ejemplar，含
//   padre_id/padre_nombre（父）、madre_id（母）、abuelo_materno_id（母父）—— 全部带站内稳定 id。
// - 父父：节目页没有这一层，借种马自己的 ejemplar 页（padre_id 即种马 id）取其 padre。
//   结果按种马 id 缓存 data/pedigree/si-sire.json，跨日复用；马页缓存 si-horse.json。
//   三国源里 San Isidro 是唯一能同时拿到 父/母/母父/父父 + 全部站内 id 的源。
//
// ## 语义对照
// - peso：阿根廷节目负磅 = jockey_kilos（骑手携带总重，含鞍具），与 TJK weight 同口径。
// - cuidador = 练马师；caballeriza = 马房（非马主，不写 owner）。
// - estado：reunion.estado = DEPURADOS 时退马已定；REUNIÓN 当日还有 CAMBIOS，暂不追。
// - sexo 码：M=Macho(牡) C=Castrado(セ) H=Hembra(牝)；pelaje 码：Z/A/T/N/R/C → JBIS 毛色近似。
//
// ## 时区
// America/Argentina/Buenos_Aires，UTC-3 全年不变（2009 年起废 DST）。
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";
import { pedCache } from "../lib/ped-cache.js";
import { instantFromZoned, isoInZone } from "./normalize.js";

export const id = "sanisidro";
export const label = "San Isidro (Argentina)";
export const homeUrl = "https://hipodromosanisidro.com/programacion/calendario";

const BASE = "https://hipodromosanisidro.com";
const TZ = "America/Argentina/Buenos_Aires";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAG = "si";

// 源站部分 ejemplar 页是应用级 503（Laravel 错误页，实测同一页面 3 次运行跨 1h 均 503，
// 与请求频率无关 —— 服务端数据问题，属确定性故障）；网络抖动则偶发。
// 策略：HTTP 错误（带 status）只试 1 次、结果由调用方负缓存；网络错误歇 30s 再试 1 次。
// 返回 { html } 或 { error, status? }（status 存在 = 应用级确定性失败）。
async function fetchSi(url, src) {
  let lastErr = null;
  for (const wait of [0, 30000]) {
    if (wait) await sleep(wait);
    try {
      const html = await fetchHtmlSoft(url, { src, ua: BROWSER_UA, retries: 1 });
      return { html };
    } catch (e) {
      lastErr = e;
      if (e.status) return { error: e.message, status: e.status }; // 4xx/5xx：重试无意义
    }
  }
  return { error: lastErr?.message ?? "fetch failed" };
}

// ---------- 文本工具 ----------
const num = (s) => {
  const m = String(s ?? "").replace(/\s/g, "").match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
};
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim() || null;
// 阿根廷奖金写法「3.910.000」→ 3910000
const arNum = (s) => {
  const n = String(s ?? "").replace(/\./g, "").replace(/\s/g, "").match(/\d+/);
  return n ? Number(n[0]) : null;
};

// Inertia 数据页 → props JSON（页面不存在时整段缺失）
export function appData(html) {
  const m = String(html ?? "").match(/<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

// ---------- 字段映射 ----------
const SEX = { M: "牡", C: "セ", H: "牝" };
const COLOUR = { Z: "青鹿毛", A: "栗毛", T: "芦毛", N: "青毛", R: "駁毛", C: "栗毛" };
const SURFACE = (raw) => {
  const s = String(raw ?? "").toUpperCase();
  if (!s) return null;
  if (s.includes("CESP") || s.includes("CÉSPED") || s.includes("TURF") || s.includes("PASTO")) return "芝";
  if (s.includes("ARENA") || s.includes("ARENA ") || s.includes("DIRT") || s.includes("SAND")) return "ダ";
  return null;
};

/** 赛名/条件 → 比赛格（阿根廷：G1-G3 / Listed 在赛名里，Handicap 是让赛制非级别） */
function klassOf({ nombre = "", nombreLargo = "", esClasico = false }) {
  const n = `${nombre} ${nombreLargo}`;
  const g = n.match(/\bG\s*([123])\b/);
  if (g) return { klass: `G${"ⅠⅡⅢ"[+g[1] - 1]}`, klassGroup: "重賞", gradeTag: `G${"ⅠⅡⅢ"[+g[1] - 1]}` };
  if (/\bListed\b/i.test(n)) return { klass: "L", klassGroup: "重賞", gradeTag: "L" };
  return { klass: esClasico ? "Clásico" : null, klassGroup: "一般", gradeTag: null };
}

// 「DUBAI THUNDER (GB)」→ { name: "DUBAI THUNDER", country: "GB" }
export function nameCountry(s) {
  const t = clean(s);
  if (!t) return null;
  const m = t.match(/^(.*?)[\s]*\(([A-Z]{2,3})\)\s*$/);
  return m ? { name: clean(m[1]), country: m[2] } : { name: t, country: null };
}

/**
 * 节目 JSON → canonical race.card/v2（不含血统补全层）
 * @param {object} reunion props.reunion
 * @param {string} dateIso 场地当地比赛日
 */
export function parseReunion(reunion, dateIso) {
  const races = [];
  for (const p of reunion?.premios ?? []) {
    const runners = [];
    for (const ins of p.inscripciones ?? []) {
      if (String(ins.estado ?? "").toUpperCase().includes("RETIRADO")) continue;
      const nc = nameCountry(ins.ejemplar_padre);
      const weight = num(ins.jockey_kilos);
      runners.push({
        num: num(ins.orden),
        frame: null, // 阿根廷无枠位概念（mandil=马号）
        horse: ins.ejemplar_id ? { id: `${TAG}:${ins.ejemplar_id}`, name: clean(ins.ejemplar_nombre) } : { id: null, name: clean(ins.ejemplar_nombre) },
        sex: SEX[ins.ejemplar_sexo_codigo] ?? null,
        age: ins.ejemplar_edad != null ? +ins.ejemplar_edad : null,
        color: COLOUR[ins.ejemplar_pelaje_codigo] ?? null,
        jockey: { id: null, name: clean(ins.jockey) },
        weight: weight,
        weightRaw: ins.jockey_kilos != null ? String(ins.jockey_kilos) : null,
        weightOver: null,
        trainer: { id: null, name: clean(ins.cuidador) },
        owner: null, // 阿根廷节目只给马房（caballeriza），马主在赛果页才有 → 不冒填
        breeder: null,
        sire: nc ? { id: null, name: nc.name, country: nc.country } : null, // 血统层在 enrich 阶段覆盖
        dam: clean(ins.ejemplar_madre) ? { id: null, name: clean(ins.ejemplar_madre) } : null,
        bms: null,
        sireSire: null,
        recent: [], // 阿根廷节目页无近5跑结构化数据（ejemplar_performance 多为空）
        silk: null,
        si: {
          inscripcionId: ins.id ?? null,
          estado: ins.estado ?? null,
          pelaje: clean(ins.ejemplar_pelaje),
          pesoEjemplar: ins.ejemplar_peso != null && +ins.ejemplar_peso > 0 ? +ins.ejemplar_peso : null, // 0=未称重
          jockeyDescargos: ins.jockey_descargos != null ? +ins.jockey_descargos : null,
          caballeriza: clean(ins.caballeriza),
          caballerizaColores: clean(ins.caballeriza_colores),
          herrajes: clean(ins.herrajes),
          medicamentos: clean(ins.medicamentos),
          performance: clean(ins.ejemplar_performance),
          mandil: ins.mandil_colores ?? null,
        },
      });
    }
    const k = klassOf({ nombre: p.nombre ?? "", nombreLargo: p.nombre_largo ?? "", esClasico: !!p.es_clasico });
    const hhmm = String(p.hora ?? "").match(/^(\d{1,2}):(\d{2})/);
    const [y, m, d] = dateIso.split("-").map(Number);
    const inst = hhmm ? new Date(instantFromZoned(y, m, d, +hhmm[1], +hhmm[2], TZ)) : null;
    const dist = p.condicion_detalles?.distancia != null ? +p.condicion_detalles.distancia : null;
    const pista = p.condicion_detalles?.pista ?? null;
    races.push({
      no: p.orden != null ? +p.orden : null,
      startTime: hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null,
      startTimeTz: TZ,
      startTimeInstant: inst ? isoInZone(inst, TZ) : null,
      startTimeLocal: hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null,
      name: clean(p.nombre) ?? null,
      surface: SURFACE(pista),
      distance: dist,
      distanceRaw: dist ? `${dist}m` : null,
      heads: runners.length,
      klass: k.klass,
      klassGroup: k.klassGroup,
      gradeTag: k.gradeTag,
      raceClass: p.condicion_detalles?.tipo ?? null,
      raceType: "FLAT", // 阿根廷圣伊西德罗仅平地
      raceKey: p.id != null ? String(p.id) : null,
      status: runners.length ? "entries" : "pending",
      runners,
      si: {
        nombreLargo: clean(p.nombre_largo),
        reunionNo: reunion.numero != null ? +reunion.numero : null,
        reunionEstado: reunion.estado ?? null,
        condicion: clean(p.condicion),
        trazado: clean(p.condicion_detalles?.trazado),
        pistaEstado: clean(p.pista_estado),
        pistaRecord: clean(p.pista_record),
        grupo: p.condicion_detalles?.grupo ?? null,
        esClasico: !!p.es_clasico,
        esEstadistico: !!p.es_estadistico,
        bolsaTotal: arNum(p.bolsa_distribucion?.total_bolsa),
        apuestas: clean(p.apuestas?.descripcion),
        retiradas: (p.inscripciones_retiradas ?? []).map((x) => ({
          orden: x.orden ?? null,
          name: clean(x.ejemplar_nombre),
          id: x.ejemplar_id ? `${TAG}:${x.ejemplar_id}` : null,
        })),
      },
    });
  }
  return {
    schema: "race.card/v2",
    source: "sanisidro",
    fetchLayer: "hipodromosanisidro.com",
    sourceKey: "sanisidro:1",
    date: dateIso,
    track: "san-isidro",
    trackId: 1,
    venue: "San Isidro",
    country: "ARG",
    countryLong: "Argentina",
    scope: "overseas",
    timeZone: TZ,
    localTimeZone: TZ,
    going: null,
    surfaceRaw: clean(reunion?.pista_tipo),
    sourceUrl: null,
    capturedAt: new Date().toISOString(),
    races,
    sanisidro: {
      fecha: clean(reunion?.fecha),
      estado: reunion?.estado ?? null,
      pistaTipo: clean(reunion?.pista_tipo),
    },
  };
}

// ---------- 血统补全 ----------
// 马页缓存：ejemplar_id → { sire, dam, bms, birth, breeder }（名字带国码原样保留）
function horseCache() {
  return pedCache(`${process.cwd()}/data/pedigree/si-horse.json`);
}
// 种马页缓存：sireId → { sireSire: { id, name, country } }
function sireCache() {
  return pedCache(`${process.cwd()}/data/pedigree/si-sire.json`);
}

/** ejemplar 页 JSON → { sire, dam, bms, birth, breeder }（id 归 si: 前缀） */
export function pedigreeOf(ej) {
  if (!ej) return null;
  const withCountry = (idField, nameField) => {
    const n = nameCountry(ej[nameField]);
    return n ? { id: ej[idField] ? `${TAG}:${ej[idField]}` : null, name: n.name, country: n.country } : null;
  };
  return {
    sire: withCountry("padre_id", "padre_texto") ?? withCountry("padre_id", "padre_nombre"),
    dam: ej.madre_nombre ? { id: ej.madre_id ? `${TAG}:${ej.madre_id}` : null, name: clean(ej.madre_nombre), country: null } : null,
    bms: withCountry("abuelo_materno_id", "abuelo_materno_texto") ?? withCountry("abuelo_materno_id", "abuelo_materno_nombre"),
    birth: ej.fecha_nacimiento ?? null,
    breeder: clean(ej.criador),
    sex: ej.sexo ?? null,
    pelaje: ej.pelaje ?? null,
  };
}

/**
 * 给一批文档补 runner.sire / dam(id) / bms / sireSire。
 * - 母父（bms）：马详情页 abuelo_materno（一马 1 请求，缓存跨日复用）
 * - 父父（sireSire）：种马自己的 ejemplar 页（一父 1 请求，缓存跨日复用 → 第二天起近 0 请求）
 * @returns {{horses:object, sires:object}} 本次补全统计
 */
export async function resolvePedigree(docs, { delayMs = 700, log = console.log } = {}) {
  const hCache = horseCache();
  const sCache = sireCache();
  const stat = { horses: { names: 0, queried: 0, hit: 0, miss: 0, filled: 0 }, sires: { names: 0, queried: 0, hit: 0, miss: 0, filled: 0 }, heads: 0 };

  // ① 收集本场全部出场马 id（文档里 horse.id = si:{ejemplar_id}）
  const horseIds = new Map(); // id → { name }
  for (const doc of docs)
    for (const race of doc.races ?? [])
      for (const r of race.runners ?? []) {
        stat.horses.heads = (stat.horses.heads ?? 0) + 1;
        if (!r.horse?.id || !/^si:\d+$/.test(r.horse.id)) continue;
        horseIds.set(r.horse.id, { name: r.horse.name });
      }

  // ② 马页 → sire/dam/bms（先查缓存）
  const horsePed = new Map();
  for (const [hid, meta] of horseIds) {
    stat.horses.names++;
    let ped = hCache.get(hid);
    if (ped?.status === 503 && (Date.now() - Date.parse(ped.failedAt ?? 0)) / 864e5 < 7) {
      stat.horses.miss++; // 负缓存内：应用级 503，7 天内免重试
      continue;
    }
    if (!ped || ped.status === 503) {
      const resp = await fetchSi(`${BASE}/programacion/ejemplares/${hid.slice(3)}`, "si-horse");
      await sleep(delayMs);
      stat.horses.queried++;
      if (!resp.html) {
        if (resp.status) {
          // 应用级确定性失败（如 Laravel 503）：负缓存 7 天，避免每次运行空烧请求
          hCache.set(hid, { status: resp.status, failedAt: new Date().toISOString() });
          log(`[ped] ${meta.name}(${hid}) → 源站 HTTP ${resp.status}（确定性失败，负缓存 7 天）`);
        } else {
          log(`[ped] ${meta.name}(${hid}) → 网络失败（未缓存，稍后重试）：${resp.error}`);
        }
        continue;
      }
      const j = appData(resp.html);
      ped = pedigreeOf(j?.props?.ejemplar);
      ped = ped ? { ...ped, capturedAt: new Date().toISOString() } : { miss: 1, capturedAt: new Date().toISOString() };
      hCache.set(hid, ped);
      if (ped.sire || ped.dam) stat.horses.hit++;
      else stat.horses.miss++;
    }
    if (ped?.sire || ped?.dam || ped?.bms) horsePed.set(hid, ped);
  }

  // ③ 种马页 → 父父（种马 id 去重后远少于马数）
  const sireIds = new Map();
  for (const ped of horsePed.values()) {
    const sid = ped.sire?.id;
    if (sid && /^si:\d+$/.test(sid)) sireIds.set(sid, { name: ped.sire.name });
  }
  const sireSireOf = new Map();
  for (const [sid, meta] of sireIds) {
    stat.sires.names++;
    let rec = sCache.get(sid);
    if (rec?.status === 503 && (Date.now() - Date.parse(rec.failedAt ?? 0)) / 864e5 < 7) {
      stat.sires.miss++; // 负缓存内
      continue;
    }
    if (!rec || rec.status === 503) {
      const resp = await fetchSi(`${BASE}/programacion/ejemplares/${sid.slice(3)}`, "si-sire");
      await sleep(delayMs);
      stat.sires.queried++;
      if (!resp.html) {
        if (resp.status) {
          sCache.set(sid, { status: resp.status, failedAt: new Date().toISOString() });
          log(`[siresire] ${meta.name}(${sid}) → 源站 HTTP ${resp.status}（确定性失败，负缓存 7 天）`);
        } else {
          log(`[siresire] ${meta.name}(${sid}) → 网络失败（未缓存，稍后重试）：${resp.error}`);
        }
        continue;
      }
      const ped = pedigreeOf(appData(resp.html)?.props?.ejemplar);
      // 种马页的 padre = 本马父父；母页无关。同一马 id 既是马又是父，页结构一致。
      rec = ped ? { sireSire: ped.sire, capturedAt: new Date().toISOString() } : { miss: 1, capturedAt: new Date().toISOString() };
      sCache.set(sid, rec);
      if (rec.sireSire) stat.sires.hit++;
      else stat.sires.miss++;
    }
    if (rec?.sireSire) sireSireOf.set(sid, rec.sireSire);
  }

  // ④ 回填 runners
  for (const doc of docs)
    for (const race of doc.races ?? [])
      for (const r of race.runners ?? []) {
        if (!/^si:\d+$/.test(r.horse?.id ?? "")) continue;
        stat.heads++;
        const ped = horsePed.get(r.horse.id);
        if (!ped) continue;
        if (ped.sire) r.sire = ped.sire;
        if (ped.dam) r.dam = ped.dam;
        if (ped.bms) r.bms = ped.bms;
        const ss = r.sire?.id ? sireSireOf.get(r.sire.id) : null;
        if (ss) {
          r.sireSire = ss;
          stat.sires.filled++;
        }
        if (ped.birth || ped.breeder) {
          r.si = { ...r.si, ...(ped.birth ? { birth: ped.birth } : {}), ...(ped.breeder ? { breeder: ped.breeder } : {}) };
        }
        stat.horses.filled++;
      }

  hCache.save();
  sCache.save();
  log(
    `[ped] 马 ${stat.horses.filled}/${stat.horses.heads} 頭（缓存 ${stat.horses.names - stat.horses.queried}，本次请求 ${stat.horses.queried}，查无 ${stat.horses.miss}）`
  );
  log(
    `[siresire] 父父补完 ${stat.sires.filled}/${stat.heads} 頭 / 父名 ${stat.sires.names} 个` +
      `（缓存 ${stat.sires.names - stat.sires.queried}，本次请求 ${stat.sires.queried}，查无 ${stat.sires.miss}）`
  );
  return stat;
}

// ---------- 连通性自检 ----------
export async function probe() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const html = await fetchHtmlSoft(`${BASE}/programacion/programa-oficial/${today}`, { src: "si-probe", ua: BROWSER_UA }).catch(() => null);
  const j = html ? appData(html) : null;
  const reunion = j?.props?.reunion;
  return {
    program: { ok: Boolean(reunion), date: reunion?.fecha ?? null, races: reunion?.premios?.length ?? 0 },
    horsePage: null,
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
 * @param {string[]} o.dates      比赛日（YYYY-MM-DD，阿根廷当地）；缺省 = 今天 + 明天
 * @param {number} o.delayMs      马页/种马页请求间隔
 * @param {boolean} o.pedigree    是否补 母父/父父（马页 + 种马页，均带持久缓存）
 * @returns [{ date, file, doc }]
 */
export async function collect({ dates = null, limit = 0, delayMs = 1500, pedigree = true, log = console.log } = {}) {
  const days = dates?.length ? dates : [todayInTz(), addDays(todayInTz(), 1)];
  const out = [];
  let fetched = 0;

  for (const dateIso of days) {
    const url = `${BASE}/programacion/programa-oficial/${dateIso}`;
    const resp = await fetchSi(url, "si-prog");
    if (!resp?.html) {
      log(`[index] ${dateIso} 当日无节目（404／抓取失败：${resp?.error ?? resp?.status ?? "?"}）`);
      continue;
    }
    const j = appData(resp.html);
    const reunion = j?.props?.reunion;
    if (!reunion?.premios?.length) {
      log(`[index] ${dateIso} 页面无 reunion 数据 → 跳过`);
      continue;
    }
    fetched++;
    const doc = parseReunion(reunion, dateIso);
    doc.sourceUrl = url;
    const heads = doc.races.reduce((n, r) => n + r.heads, 0);
    log(`[race] ${dateIso} ${doc.venue} Reunión ${reunion.numero} ${doc.races.length} R / ${heads} 頭 / estado=${reunion.estado ?? "-"}`);
    out.push({ date: dateIso, file: `${TAG}-1.json`, doc });
    if (limit && fetched >= limit) break;
  }

  if (pedigree && out.length) await resolvePedigree(out.map((u) => u.doc), { delayMs, log });
  return out;
}
