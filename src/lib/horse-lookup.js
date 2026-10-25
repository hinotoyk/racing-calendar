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

export function createHorseLookup({ cache, delayMs = 1200, minFoaledForSire = null, minBirthForSire = null, preferred = null, log = () => {} }) {
  const THIS_YEAR = new Date().getFullYear();
  const maxBirth = minFoaledForSire ?? THIS_YEAR - 5; // 种公马：最早 3 岁春配种（首产 2yo 上限）
  const minBirth = minBirthForSire ?? THIS_YEAR - 45; // 现代父系年龄下限：现役种公马不可能是 40+ 年前的老马（同名老马排除）

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function searchOnce(name) {
    const url = `${SEARCH_URL}?sid=horse&items=50&keyword=${encodeURIComponent(name)}`;
    const r = await get(url).catch(() => null);
    await sleep(delayMs);
    if (!r || r.status !== 200) return null;
    return parseResultRows(r.text);
  }

  /**
   * 解析一个名字。返回缓存记录：
   * { key, name, resolvedId, resolvedName, birth, sex, stallion, sire, dam, hits, viaEn, candidates, capturedAt }
   * resolvedId = null 表示未能唯一确定（0 命中或歧义），同样缓存（避免每日重复搜索）。
   *
   * 匹配：JBIS 検索按英文名命中库内英文字段，但结果行显示日文名（ディープインパクト）——
   * 行名精确匹配失败时，对前 3 行补抓马页核对官方英文名（hdg1-search__sub）。
   */
  async function resolve(name, { force = false } = {}) {
    const key = normalizeHorseName(name);
    if (!key) return null;
    if (!force) {
      const cached = cache.get(key);
      if (cached) return cached;
    }

    // 现役种公马缓存命中：直接采用（同名老马/搜索歧义的根本解，见 preferredMapFromSireCache）
    const known = preferred?.get(key);
    if (known?.id) {
      const rec = {
        schema: "ped.lookup.jbis/v1",
        key,
        name: String(name),
        resolvedId: known.id,
        resolvedName: known.name ?? null,
        birth: known.birth ?? null,
        sex: known.sex ?? null,
        stallion: true,
        sire: known.sire ?? null,
        dam: known.dam ?? null,
        hits: 0,
        viaEn: false,
        viaPreferred: true,
        candidates: [],
        capturedAt: new Date().toISOString(),
      };
      cache.set(key, rec);
      log(`[lookup] ${name} → ${known.name ?? "?"} (${known.id}) 父=${known.sire?.name ?? "?"} [现役缓存]`);
      return rec;
    }

    const rows = await searchOnce(name);
    const rec = {
      schema: "ped.lookup.jbis/v1",
      key,
      name: String(name),
      resolvedId: null,
      resolvedName: null,
      birth: null,
      sex: null,
      stallion: false,
      sire: null,
      dam: null,
      hits: 0,
      viaEn: false,
      candidates: [],
      capturedAt: new Date().toISOString(),
    };

    if (rows?.length) {
      const ageOk = (x) => x.birth == null || (x.birth <= maxBirth && x.birth >= minBirth);
      let cands = rows.filter((x) => normalizeHorseName(x.name) === key);

      // 精确匹配全缺、或全因年龄不合理被否（同名老马，如 Highland Reel 1964）时，
      // 对前 5 行补抓马页核对官方英文名（英文名搜索、日文名显示的场景）
      if (!cands.length || !cands.some(ageOk)) {
        for (const row of rows.slice(0, 5)) {
          if (cands.includes(row)) continue;
          const page = await fetchHtmlSoft(`https://www.jbis.or.jp/horse/${row.id}/`).catch(() => null);
          await sleep(delayMs);
          const ped = page ? parsePedigree(page) : null;
          if (ped?.nameEn && normalizeHorseName(ped.nameEn) === key && ageOk(row)) {
            cands = [row];
            rec.viaEn = true;
            break;
          }
        }
      }

      rec.hits = cands.length;
      rec.candidates = cands.slice(0, 8).map((x) => ({ id: x.id, name: x.name, birth: x.birth, sex: x.sex, stallion: x.stallion }));

      let pick = null;
      if (cands.length === 1 && ageOk(cands[0])) {
        pick = cands[0];
      } else if (cands.length > 1) {
        const stallions = cands.filter((x) => x.stallion && x.sex === "牡" && x.birth && x.birth <= maxBirth && x.birth >= minBirth);
        if (stallions.length === 1) pick = stallions[0];
      }

      if (pick) {
        rec.resolvedId = pick.id;
        rec.resolvedName = pick.name;
        rec.birth = pick.birth;
        rec.sex = pick.sex;
        rec.stallion = pick.stallion;
        rec.sire = pick.sire;
        rec.dam = pick.dam;
        log(`[lookup] ${name} → ${pick.name} (${pick.id}${pick.birth ? `, ${pick.birth}` : ""}${pick.stallion ? ", 種" : ""}) 父=${pick.sire?.name ?? "?"}${rec.viaEn ? " [英文名核对]" : ""}`);
      } else {
        log(`[lookup] ${name} → 未唯一确定（${cands.length} 候选，缓存放空）`);
      }
    } else {
      log(`[lookup] ${name} → 无结果`);
    }

    cache.set(key, rec);
    return rec;
  }

  return { resolve, save: () => cache.save(), size: () => cache.size() };
}
