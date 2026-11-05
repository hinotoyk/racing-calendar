// winfinal 勝負服データベース（fuku.winfinal.com）——彩衣兜底源（2026-11-04）
//
// netkeiba 未登记的彩衣（尤其地方马主、外国产马）在此有收录：
//   https://fuku.winfinal.com/?action=horse_name&q={馬名}   ← 馬名完全一致検索
// 结果卡（result-card）含：馬名 / 英字 / 性・毛色 / 生年月日 / 馬主名 / 服色图 img/xxxx.gif
// 唯一性判定与 netkeiba 同口径：馬名完全一致 + 生年月日年份一致（生年来自 JBIS 马页，精确到日）。
//
// 缓存（data/pedigree/）：
//   wf-horse.json  key = `${馬名}|${生年}` → { owner, colours } | { miss:1, n }
//   wf-owner.json  key = 馬主名 → { colours } | { miss:1 }（同一马主多马 0 请求）
// 图落 data/silks/wf-{图片基名}.gif
import fs from "node:fs";
import path from "node:path";
import { fetchBuffer } from "./fetch.js";
import { pedCache } from "./ped-cache.js";

const SILKS_DIR = path.resolve("data", "silks");
const PED_DIR = path.resolve("data", "pedigree");
const horseStore = pedCache(path.join(PED_DIR, "wf-horse.json"));
const ownerStore = pedCache(path.join(PED_DIR, "wf-owner.json"));
const BASE = "https://fuku.winfinal.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").replace(/[\s\u3000]+/g, "").trim();

export function saveWfCaches() {
  horseStore.save();
  ownerStore.save();
}

export function wfStats() {
  return { horse: horseStore.size(), owner: ownerStore.size() };
}

function stripTags(s) {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// 解析结果卡：返回 [{ name, nameEn, birthDate, owner, img }]
export function parseWfResults(html) {
  if (!html || /該当.*ありません|見つかりません/.test(html)) return [];
  const out = [];
  for (const chunk of String(html).split('<div class="result-card">').slice(1)) {
    const name = stripTags(chunk.match(/result-label">馬名<\/div>\s*<div class="result-value">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const nameEn = stripTags(chunk.match(/result-label">英字<\/div>\s*<div class="result-value">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const birthRaw = stripTags(chunk.match(/result-label">生年月日<\/div>\s*<div class="result-value">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const bm = birthRaw.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
    const ownerCell = chunk.match(/result-label">馬主名<\/div>\s*<div class="result-value">([\s\S]*?)<\/div>/)?.[1] ?? "";
    const img = ownerCell.match(/<img[^>]*src="([^"]+)"/)?.[1] ?? null;
    const owner = stripTags(ownerCell.replace(/<img[^>]*>/g, ""));
    if (!name) continue;
    out.push({
      name,
      nameEn,
      birthDate: bm ? `${bm[1]}-${String(bm[2]).padStart(2, "0")}-${String(bm[3]).padStart(2, "0")}` : null,
      birthYear: bm ? parseInt(bm[1], 10) : null,
      owner: owner || null,
      img: img ? (img.startsWith("http") ? img : BASE + "/" + img.replace(/^\/+/, "")) : null,
    });
  }
  return out;
}

// 下载服色图：按图片基名去重（{imgBase}.gif → data/silks/wf-{imgBase}.gif）
async function downloadWfImage(imgUrl) {
  const base = path.basename(String(imgUrl).split("?")[0]).replace(/\.[a-z0-9]+$/i, "");
  if (!base) return null;
  const ext = (String(imgUrl).match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] ?? "gif").toLowerCase();
  const file = `wf-${base}.${ext}`;
  if (fs.existsSync(path.join(SILKS_DIR, file))) return `data/silks/${file}`;
  const got = await fetchBuffer(imgUrl, { src: "winfinal-img" }).catch(() => null);
  if (!got) return null;
  fs.mkdirSync(SILKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SILKS_DIR, file), got.buf);
  return `data/silks/${file}`;
}

/**
 * 按马名 + 生年查彩衣。
 * @param {string} nameJp 日文登录名（无则英文名）
 * @param {number|null} birthYear 生年（JBIS 马页 foaled 优先）
 * @returns {Promise<{owner:{name:string},colours:string,via:"winfinal"}|null>}
 */
export async function resolveWfSilk(nameJp, birthYear, { delayMs = 1200, log = () => {} } = {}) {
  const name = norm(nameJp);
  if (!name) return null;
  const key = `${name}|${birthYear ?? "?"}`;
  const cached = horseStore.get(key);
  if (cached) return cached.miss ? null : cached;

  const url = `${BASE}/?action=horse_name&q=${encodeURIComponent(name)}`;
  const html = await fetchBuffer(url, { src: "winfinal", accept: "text/html,*/*;q=0.8" })
    .then((x) => (x ? x.buf.toString("utf8") : null))
    .catch(() => null);
  await sleep(delayMs);
  if (!html) {
    horseStore.set(key, { miss: 1, via: "winfinal", reason: "fetch" });
    return null;
  }

  const rows = parseWfResults(html).filter((r) => norm(r.name) === name);
  const byYear = birthYear ? rows.filter((r) => r.birthYear === birthYear) : rows;
  const cands = birthYear ? byYear : rows;
  if (cands.length !== 1) {
    horseStore.set(key, { miss: 1, via: "winfinal", n: cands.length, rows: rows.length });
    log(`[wf] ${name} (${birthYear ?? "?"}) → 命中 ${cands.length}/${rows.length}，无法唯一确定`);
    return null;
  }

  const hit = cands[0];
  if (!hit.img || !hit.owner) {
    horseStore.set(key, { miss: 1, via: "winfinal", reason: "no-image" });
    return null;
  }
  const ownerKey = norm(hit.owner);
  const ownerCached = ownerStore.get(ownerKey);
  let colours = ownerCached && !ownerCached.miss ? ownerCached.colours : null;
  if (!colours) {
    colours = await downloadWfImage(hit.img);
    ownerStore.set(ownerKey, colours ? { colours } : { miss: 1 });
  }
  if (!colours) {
    horseStore.set(key, { miss: 1, via: "winfinal", reason: "img-fail" });
    return null;
  }
  const rec = { owner: { name: hit.owner }, colours, via: "winfinal" };
  horseStore.set(key, rec);
  log(`[wf] ${name} (${birthYear ?? "?"}) → ${hit.owner} ${colours}`);
  return rec;
}
