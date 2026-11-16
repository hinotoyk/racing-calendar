// 「马名 → JBIS id」解析器（JBIS 全文検索 /horse/result/?sid=horse&keyword=）
//
// 用途：Racing Post 源的血统只有名字没有 id（Sporting Life 档案 horse_reference.id
// 恒为页面自身 id 的数据缺陷，站内无法链查）。JBIS 的馬検索覆盖日本马与海外马
// （Dubawi/Mineshaft 等纯海外种公马也有记录），结果行自带 生年 / 性别 / 「種」标签 /
// 父母链接，既可解析 id，也可取到 父父（行内「父」列）。
//
// 消歧：同名马（如 Saxon Warrior(JPN) 与 Saxon Warrior(USA)）按
//   ① 名字归一化精确匹配（去国码后缀）→ ② 「種」标签 + 牡 + 生年 ≤ 当年-4（种公马年龄下限）
// 仍无法唯一时宁可返回 null（宁缺勿错），命中与否都进缓存避免重复请求。
// ③ 人工裁决的同名异马（data/pedigree/homonym.json）：海外语境下直接不解析 ——
//    搜索能命中的往往是「同名的日本马」（Silver State → シルバーステート），
//    这类错绑无法靠年龄/種标签区分（JBIS 里只有它一条，各项属性全对得上），只能显式拒绝。
//
// 缓存 schema v2（ped.lookup.jbis/v2）：一个名字可以有两个答案（jpn / intl），
// 不再被压成「一名一答」。读取一律走 answerOf(rec, intl)，见文件中部说明。
import { get } from "../sources/http.js";
import { fetchHtmlSoft } from "./fetch.js";
import { parsePedigree } from "./parse-race.js";
import { normalizeHorseName } from "./horse-name.mjs";

const SEARCH_URL = "https://www.jbis.or.jp/horse/result/";
const RESULT_ROW_RE =
  /<a href="\/horse\/(\d{10})\/" class="txt-link">([\s\S]*?)<\/a>([\s\S]*?)(?=<a href="\/horse\/\d{10}\/" class="txt-link">|<div class="pagenation|<footer|$)/g;

const txt = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// 搜索结果页 → 候选行 [{ id, name, birth, sex, stallion, sire, dam }]
function parseResultRows(html) {
  const rows = [];
  for (const m of html.matchAll(RESULT_ROW_RE)) {
    const chunk = m[3] ?? "";
    const birthM = chunk.match(/<div class="jc-center">(\d{4})<\/div>/);
    const sexM = chunk.match(/<div class="txt-[a-z]+ jc-center">([^<]*)<\/div>/);
    const parents = [...chunk.matchAll(/<div class="jc-left[^"]*">\s*<a href="\/horse\/(\d{10})\/"[^>]*>([\s\S]*?)<\/a>/g)];
    rows.push({
      id: m[1],
      name: txt(m[2]),
      birth: birthM ? parseInt(birthM[1], 10) : null,
      sex: sexM ? txt(sexM[1]) : null,
      stallion: chunk.includes("tag-result-stallion"),
      sire: parents[0] ? { id: parents[0][1], name: txt(parents[0][2]) } : null,
      dam: parents[1] ? { id: parents[1][1], name: txt(parents[1][2]) } : null,
    });
  }
  return rows;
}

/**
 * 现役种公马预置别名表（jbis-sire.json 缓存 → Map(归一化名 → {id,name,sire})）。
 * 缓存键 = 出馬表里当过「父」的马 = 现役种公马：同名异马时（如 Declaration Of War 的
 * 同名 2005 老马）以它优先，解析器命中即直接采用，搜索只兜底。
 */
export function preferredMapFromSireCache(jbisSire) {
  const m = new Map();
  for (const rec of Object.values(jbisSire ?? {})) {
    if (!rec?.id) continue;
    const entry = { id: rec.id, name: rec.name ?? null, birth: rec.birth ?? null, sex: rec.sex ?? null, stallion: true, sire: rec.sire ?? null, dam: rec.dam ?? null };
    for (const form of [rec.name, rec.nameEn]) {
      const k = normalizeHorseName(form);
      if (k && !m.has(k)) m.set(k, entry);
    }
  }
  return m;
}

// ---------- 缓存 v2：语境答案 ----------
// 一个名字可能有两个答案，不再被压成一个：
//   rec.answers.jpn  = 日本语境（出馬表里当父/母父）的答案
//   rec.answers.intl = 海外语境（Racing Post 行）的答案
// **intl 是稀疏覆盖**：缺省 = 与 jpn 同解；只有两侧不同（= 人工裁决的同名异马，intl: null）才显式写出。
// 这样 3MB 的缓存不会因为「两条一样的答案」翻倍，也能一眼看出哪几个名字有分歧。
// 读取一律走 answerOf()；v1 旧记录（只有 resolvedId）按「同一答案」处理，向后兼容。

/** 取某语境下的答案：{ id, name, birth, sex, stallion, sire, dam } 或 null */
export function answerOf(rec, intl = false) {
  if (!rec) return null;
  const a = rec.answers;
  if (a) {
    if (intl && "intl" in a) return a.intl ?? null; // 显式覆盖（含「明确无答案」）
    return a.jpn ?? null;
  }
  if (!rec.resolvedId) return null;
  if (intl && rec.adjudicated) return null; // v1 记录 + 裁决表命中：海外语境无答案
  return answerFromLegacy(rec);
}

function answerFromLegacy(rec) {
  return {
    id: rec.resolvedId,
    name: rec.resolvedName ?? rec.name ?? null,
    birth: rec.birth ?? null,
    sex: rec.sex ?? null,
    stallion: Boolean(rec.stallion),
    sire: rec.sire ?? null,
    dam: rec.dam ?? null,
  };
}

// ---------- 「能不能当父」的硬约束 ----------
// 父/母父位只能由牡马担任。JBIS 搜索会命中同名的牝馬/セン馬（Big Picture → ビックピクチャー 牝，
// 父 ディープインパクト），这类错绑不需要人工裁决：性别本身就是反证。
// 性别未知（null）时放行 —— 不拿缺失当反证。
export const SIRE_SEX = "牡";
const sexBlocksSire = (a) => Boolean(a?.sex && a.sex !== SIRE_SEX);

/** 父/母父位的答案：牝馬/セン馬一律视为「不是父」，返回 null */
export function sireAnswerOf(rec, intl = true) {
  const a = answerOf(rec, intl);
  return sexBlocksSire(a) ? null : a;
}

/** 该记录是否已被性别否掉（用于清历史错值，见 enrichSireSire） */
export function sexInvalidAsSire(rec, intl = true) {
  return sexBlocksSire(answerOf(rec, intl));
}

// 记录形状（唯一一套字段，不再镜像旧字段）：
// { schema, key, name, answers:{jpn,intl?}, candidates, hits, via, viaEn, viaPreferred,
//   ambiguous, adjudicated, capturedAt }
// 想拿「这匹马是谁」一律走 answerOf()，不要再读 rec.resolvedId（v1 时代的一名字一答案）。
function finalize(rec) {
  rec.schema = "ped.lookup.jbis/v2";
  return rec;
}

export function createHorseLookup({ cache, delayMs = 1200, minFoaledForSire = null, minBirthForSire = null, preferred = null, homonym = null, log = () => {} }) {
  const THIS_YEAR = new Date().getFullYear();
  const maxBirth = minFoaledForSire ?? THIS_YEAR - 5; // 种公马：最早 3 岁春配种（首产 2yo 上限）
  const minBirth = minBirthForSire ?? THIS_YEAR - 45; // 现代父系年龄下限：现役种公马不可能是 40+ 年前的老马（同名老马排除）

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let lastStatus = 0;
  async function searchOnce(name) {
    const url = `${SEARCH_URL}?sid=horse&items=50&keyword=${encodeURIComponent(name)}`;
    const r = await get(url, { src: "jbis-lookup" }).catch(() => null);
    await sleep(delayMs);
    lastStatus = r?.status ?? 0;
    if (!r || r.status !== 200) return null;
    return parseResultRows(r.text);
  }

  /**
   * 解析一个名字，返回缓存记录（schema ped.lookup.jbis/v2）：
   * { key, name, answers:{jpn,intl}, candidates, hits, via, viaEn, viaPreferred,
   *   ambiguous, adjudicated, capturedAt, 以及同步后的旧字段 resolvedId/resolvedName/birth/... }
   *
   * ambiguous = 答案不是唯一证据得来的（多候选按「種 + 年龄」挑，或走现役种公马缓存没搜过）；
   * 巡检据此排待核对队列。
   *
   * 匹配：JBIS 検索按英文名命中库内英文字段，但结果行显示日文名（ディープインパクト）——
   * 行名精确匹配失败时，对前 5 行补抓马页核对官方英文名（hdg1-search__sub）。
   *
   * intl=true 表示「海外语境」：命中同名异马裁决表时直接返回 null（不搜索、不复用缓存）。
   * asSire=true 表示「这个位置只可能是父/母父」：候选里牝馬/セン馬不参与挑选（性别即反证）。
   *   注意 resolve 只回答「这名字是谁」，缓存命中时如实返回；「能不能当父」由调用方用
   *   sireAnswerOf() 再判一次（这样清历史错值时仍能拿到记录）。
   */
  async function resolve(name, { force = false, intl = false, asSire = false } = {}) {
    const key = normalizeHorseName(name);
    if (!key) return null;

    // ③ 同名异马裁决：海外语境下拒绝按名字绑 JBIS（不进缓存，裁决表改了就立刻生效）
    if (intl && homonym?.blockedForIntl?.(name)) {
      log(`[lookup] ${name} → 同名异马（homonym.json 裁决），海外语境不解析`);
      return null;
    }

    if (!force) {
      const cached = cache.get(key);
      if (cached) return cached;
    }

    const adjudicated = Boolean(homonym?.get?.(name));
    const blockedIntl = Boolean(homonym?.blockedForIntl?.(name));
    // intl 稀疏覆盖：只有裁决为同名异马时才写出 intl: null（= 海外语境明确无答案）
    const mkAnswers = (a) => (blockedIntl ? { jpn: a, intl: null } : { jpn: a });

    // 现役种公马缓存命中：直接采用（同名老马/搜索歧义的根本解，见 preferredMapFromSireCache）
    const known = preferred?.get(key);
    if (known?.id) {
      const answer = {
        id: known.id,
        name: known.name ?? null,
        birth: known.birth ?? null,
        sex: known.sex ?? null,
        stallion: true,
        sire: known.sire ?? null,
        dam: known.dam ?? null,
      };
      const rec = finalize({
        key,
        name: String(name),
        answers: mkAnswers(answer),
        hits: 0,
        via: "preferred",
        viaEn: false,
        viaPreferred: true,
        ambiguous: true, // 没搜过就给了答案
        adjudicated,
        candidates: [],
        capturedAt: new Date().toISOString(),
      });
      cache.set(key, rec);
      log(`[lookup] ${name} → ${known.name ?? "?"} (${known.id}) 父=${known.sire?.name ?? "?"} [现役缓存]`);
      return rec;
    }

    const rows = await searchOnce(name);
    // 403/网络失败 != 「查无此马」：不缓存，留给下次（否则会把限流误判成终态）
    if (!rows && lastStatus !== 200) {
      log(`[lookup] ${name} → JBIS ${lastStatus || "网络失败"}（未缓存，稍后重试）`);
      return null;
    }
    const rec = finalize({
      key,
      name: String(name),
      answers: { jpn: null },
      hits: 0,
      via: "search",
      viaEn: false,
      viaPreferred: false,
      ambiguous: false,
      adjudicated,
      candidates: [],
      capturedAt: new Date().toISOString(),
    });

    if (rows?.length) {
      const ageOk = (x) => x.birth == null || (x.birth <= maxBirth && x.birth >= minBirth);
      const maleOk = (x) => !asSire || !x.sex || x.sex === SIRE_SEX; // 父位不可能是牝/セ
      let cands = rows.filter((x) => normalizeHorseName(x.name) === key);

      // 精确匹配全缺、或全因年龄不合理被否（同名老马，如 Highland Reel 1964）时，
      // 对前 5 行补抓马页核对官方英文名（英文名搜索、日文名显示的场景）
      if (!cands.length || !cands.some(ageOk)) {
        for (const row of rows.slice(0, 5)) {
          if (cands.includes(row)) continue;
          const page = await fetchHtmlSoft(`https://www.jbis.or.jp/horse/${row.id}/`).catch(() => null);
          await sleep(delayMs);
          const ped = page ? parsePedigree(page) : null;
          if (ped?.nameEn && normalizeHorseName(ped.nameEn) === key && ageOk(row) && maleOk(row)) {
            cands = [row];
            rec.viaEn = true;
            break;
          }
        }
      }

      rec.hits = cands.length;
      rec.candidates = cands.slice(0, 8).map((x) => ({ id: x.id, name: x.name, birth: x.birth, sex: x.sex, stallion: x.stallion }));
      rec.ambiguous = cands.length > 1; // 多候选：答案是优先级判断，不是唯一证据

      let pick = null;
      if (cands.length === 1 && ageOk(cands[0]) && maleOk(cands[0])) {
        pick = cands[0];
      } else if (cands.length > 1) {
        const stallions = cands.filter((x) => x.stallion && x.sex === "牡" && x.birth && x.birth <= maxBirth && x.birth >= minBirth);
        if (stallions.length === 1) pick = stallions[0];
      }

      if (pick) {
        rec.answers = mkAnswers({
          id: pick.id,
          name: pick.name,
          birth: pick.birth,
          sex: pick.sex,
          stallion: pick.stallion,
          sire: pick.sire,
          dam: pick.dam,
        });
        finalize(rec);
        log(`[lookup] ${name} → ${pick.name} (${pick.id}${pick.birth ? `, ${pick.birth}` : ""}${pick.stallion ? ", 種" : ""}) 父=${pick.sire?.name ?? "?"}${rec.viaEn ? " [英文名核对]" : ""}`);
      } else {
        const why = cands.length === 1 && !maleOk(cands[0]) ? `性别不符（${cands[0].sex}，不可能是父）` : `${cands.length} 候选`;
        log(`[lookup] ${name} → 未唯一确定（${why}，缓存放空）`);
      }
    } else {
      log(`[lookup] ${name} → 无结果`);
    }

    cache.set(key, rec);
    return rec;
  }

  return { resolve, save: () => cache.save(), size: () => cache.size() };
}
