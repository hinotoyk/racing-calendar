// JBIS 马名权威缓存（2026-11-04）
//
// 为什么要有：出馬表的马名带显示用尾缀（装备标记「 B」190 例、国名括注 (USA) 141 例），
// 靠正则剥尾缀迟早误伤（纯 ASCII 名的字母可能就是名字一部分）。改为「只认 JBIS id，
// 登录名从马页读」：/horse/{10位id}/ → h1（日文名）+ hdg1-search__sub（英文名(国籍)）。
//
// 缓存 data/pedigree/jbis-name.json（入库，CI 增量复用）：
//   { "<10位id>": { jp, en, country, foaled, sex, capturedAt } | { miss: 1 } }
//   jp = 日文登录名（无则 null）、en = 英文名（去国籍括注）、country = JPN/USA/…、foaled = YYYY-MM-DD
//
// 同时是彩衣唯一性判定的基础：foaled 精确到日，优于「赛事年 − age」的推算。
import path from "node:path";
import { pedCache } from "./ped-cache.js";
import { fetchHtmlSoft } from "./fetch.js";
import { parseHorseProfile } from "./parse-race.js";

const store = pedCache(path.resolve("data", "pedigree", "jbis-name.json"), { flushEvery: 100 });
const inflight = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JBIS 马页是 WAF 打分拦截：请求头越像真实浏览器越稳（实测只带 UA+Accept 会被判 403）。
const HORSE_HEADERS = {
  "Accept-Language": "ja,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "max-age=0",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
const HORSE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 限流状态：JBIS 对短时高频请求返回 403（整站封禁数十秒）。
// 403 绝不写缓存（否则会把「暂时抓不到」误判成「页面不存在」）。
const state = { blocks: 0, lastBlockAt: 0 };
export function nameFetchState() {
  return { ...state };
}

export function jbisNameOf(id) {
  const rec = store.get(id);
  return rec && !rec.miss ? rec : null;
}

export function saveJbisNames() {
  return store.save();
}

export function jbisNameStats() {
  return { cached: store.size() };
}

// 取单匹马的登录名（缓存优先；并发去重：同一 id 只发一次请求）
export async function resolveJbisName(id, { delayMs = 0 } = {}) {
  if (!id) return null;
  const cached = store.get(id);
  if (cached) return cached.miss ? null : cached;
  if (inflight.has(id)) return inflight.get(id);

  const task = (async () => {
    let html = null;
    let err = null;
    try {
      html = await fetchHtmlSoft(`https://www.jbis.or.jp/horse/${id}/`, {
        src: "jbis-horse",
        ua: HORSE_UA,
        headers: HORSE_HEADERS,
      });
    } catch (e) {
      err = e;
    }
    if (delayMs) await sleep(delayMs);
    if (err) {
      if (err.status === 403) {
        state.blocks++;
        state.lastBlockAt = Date.now();
      }
      return null; // 限流/网络错误：不写缓存，稍后重试
    }
    const info = parseHorseProfile(html);
    if (!info) {
      // 页面确实不存在（404/短响应）：终态，避免每轮重试（马匹 10 位 id 不会复用）
      store.set(id, { miss: 1, reason: html ? "no-profile" : "http-null", capturedAt: new Date().toISOString() });
      return null;
    }
    const rec = {
      jp: info.nameJp ?? null,
      en: info.nameEn ?? null,
      country: info.country ?? null,
      foaled: info.foaled ?? null,
      sex: info.sex ?? null,
      capturedAt: new Date().toISOString(),
    };
    store.set(id, rec);
    return rec;
  })();

  inflight.set(id, task);
  try {
    return await task;
  } finally {
    inflight.delete(id);
  }
}

// 把登录名写回 runner：horse.name 用日文名（无日文名则英文名），另存 nameEn / country / foaled
export function applyHorseName(runner, rec) {
  if (!rec || !runner?.horse) return false;
  const canonical = rec.jp ?? rec.en;
  if (!canonical) return false;
  let changed = false;
  if (runner.horse.name !== canonical) {
    runner.horse.name = canonical;
    changed = true;
  }
  if (rec.jp && runner.horse.nameJp !== rec.jp) {
    runner.horse.nameJp = rec.jp;
    changed = true;
  }
  if (rec.en && runner.horse.nameEn !== rec.en) {
    runner.horse.nameEn = rec.en;
    changed = true;
  }
  if (rec.country && runner.horse.country !== rec.country) {
    runner.horse.country = rec.country;
    changed = true;
  }
  if (rec.foaled && runner.horse.foaled !== rec.foaled) {
    runner.horse.foaled = rec.foaled;
    changed = true;
  }
  return changed;
}

// 批量解析并回写（并发 + 间隔；只对缓存未命中的马发请求）
export async function attachJbisNames(runners, { conc = 1, delayMs = 3500, limit = 0, log = () => {}, pauseMs = 120000 } = {}) {
  const ids = [...new Set(runners.map((r) => r.horse?.id).filter(Boolean))];
  const todo = ids.filter((id) => !store.get(id));
  let fetched = 0;
  let cursor = 0;
  let blocked = false;
  let blockLog = 0;
  const startBlocks = state.blocks;

  const worker = async () => {
    while (cursor < todo.length && !blocked) {
      const id = todo[cursor++];
      if (limit && fetched >= limit) return;
      fetched++;
      const before = state.blocks;
      await resolveJbisName(id, { delayMs });
      // 遇到 403：整批暂停（JBIS WAF 限流），暂停时长指数增长；连续多次则主动收工，留待重跑
      if (state.blocks > before) {
        store.save();
        blockLog++;
        const wait = Math.min(pauseMs * 2 ** (blockLog - 1), 15 * 60 * 1000);
        log(`[name] ⚠ JBIS 403 限流（第 ${blockLog} 次）→ 暂停 ${Math.round(wait / 1000)}s 后继续`);
        await sleep(wait);
        if (blockLog >= 3) {
          blocked = true;
          log(`[name] 连续 ${blockLog} 次限流 → 本轮停止（已抓取结果已缓存，重跑续采）`);
          return;
        }
      }
      if (fetched % 50 === 0) {
        store.save();
        log(`[name] ${fetched}/${todo.length} 已抓取（缓存 ${store.size()}）`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, conc) }, worker));
  store.save();

  let applied = 0;
  for (const r of runners) {
    const rec = jbisNameOf(r.horse?.id);
    if (applyHorseName(r, rec)) applied++;
  }
  return { ids: ids.length, fetched, applied, blocked };
}
