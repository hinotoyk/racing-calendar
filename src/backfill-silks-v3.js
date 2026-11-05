// 彩衣全量重爬 v3（2026-11-03，用户设计）：马名搜索 → 马主 netkeibaId → owner.id 做 key 缓存 → URL 直构
//
// 与 v2 的区别：v2 缓存 key 是「归一马主名」（受 JBIS/netkeiba 写法差异、法人尾缀、空格错误干扰）；
// v3 改为用户指出的正路——马名是统一稳定的，搜索行自带马主 netkeibaId，直接用它做缓存 key：
//   runner(马名+age) → ajax_horse_search（word=EUC-JP）→ 唯一命中（归一名+出生年匹配）
//     → owner.id（netkeibaId，与马页完全一致，实测验证）→ nk-owner-v3.json[id] 缓存
//     → colours/{id}.png|gif 直构下载（png=320x240 高清优先；双 404 = 无登记终态）
//
// 重新覆盖语义：无视 runner.silk 现值，全部按 v3 缓存重挂（修正历史 owner 错配 + 覆盖率最大化）。
// 断点续跑：马主缓存落盘后重跑跳过；--dates/--tracks 可分批。
// 用法：node src/backfill-silks-v3.js [--delay 1200] [--fresh-owner]（--fresh-owner 忽略 owner 缓存重下）
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { fetchNkHtml } from "./lib/fetch.js";
import { pedCache } from "./lib/ped-cache.js";
import { parseNkSearchRows, nkNameKey } from "./lib/parse-netkeiba.js";
import { nkOwnerKey } from "./lib/silks.js"; // 马名归一复用 nkNameKey；owner key 不再用

const DATA_DIR = path.resolve("data", "races");
const SILKS_DIR = path.resolve("data", "silks");
const PED_DIR = path.resolve("data", "pedigree");
const ownerStore = pedCache(path.join(PED_DIR, "nk-owner-v3.json")); // key=netkeibaId → { name, colours, miss? }
const mapStore = pedCache(path.join(PED_DIR, "nk-map.json")); // 复用 v2 马名映射（nkId/birthYear）

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const DATES = argOf("--dates")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const TRACKS = argOf("--tracks")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const FRESH_OWNER = argv.includes("--fresh-owner");
const DELAY = parseInt(argOf("--delay") ?? "1200", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- EUC-JP 编码（零依赖反查表，同 lib/silks.js） ----------
let EUC_REV = null;
function eucQuery(str) {
  if (!EUC_REV) {
    EUC_REV = new Map();
    const dec = new TextDecoder("euc-jp");
    const buf = new Uint8Array(2);
    for (let hi = 0xa1; hi <= 0xfe; hi++)
      for (let lo = 0xa1; lo <= 0xfe; lo++) {
        buf[0] = hi;
        buf[1] = lo;
        const s = dec.decode(buf);
        if (s !== "\uFFFD") EUC_REV.set(s, [hi, lo]);
      }
    buf[0] = 0x8e;
    for (let lo = 0xa1; lo <= 0xdf; lo++) {
      buf[1] = lo;
      const s = dec.decode(buf);
      if (s !== "\uFFFD") EUC_REV.set(s, [0x8e, lo]);
    }
  }
  const bytes = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      bytes.push(cp);
      continue;
    }
    const b = EUC_REV.get(ch);
    if (!b) return null;
    bytes.push(...b);
  }
  return bytes.map((x) => "%" + x.toString(16).toUpperCase().padStart(2, "0")).join("");
}

// ---------- 彩衣下载：按 owner.id 直构，png（320x240）优先 ----------
async function downloadSilk(ownerId) {
  for (const e2 of ["png", "gif"]) {
    if (fs.existsSync(path.join(SILKS_DIR, `${ownerId}.${e2}`))) return `data/silks/${ownerId}.${e2}`;
  }
  for (const ext of ["png", "gif"]) {
    const res = await fetch(`https://cdnv2.netkeiba.com/img/db/colours/${ownerId}.${ext}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Accept: "image/*,*/*;q=0.8",
      },
    }).catch(() => null);
    if (res?.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length >= 100 && /^image\//.test(res.headers.get("content-type") ?? "")) {
        fs.mkdirSync(SILKS_DIR, { recursive: true });
        fs.writeFileSync(path.join(SILKS_DIR, `${ownerId}.${ext}`), buf);
        return `data/silks/${ownerId}.${ext}`;
      }
    }
    await sleep(250);
  }
  return null;
}

// ---------- 马名搜索：唯一命中 → { nkId, owner }（终态缓存 nk-map） ----------
async function searchHorse(name, birthYear) {
  const key = `${nkNameKey(name)}|${birthYear ?? "?"}`;
  const cached = mapStore.get(key);
  if (cached) return cached; // { nkId, owner } | { miss:1, n } | { ambiguous:1 }

  const q = eucQuery(nkNameKey(name));
  if (!q) {
    mapStore.set(key, { miss: 1, n: 0 });
    return null;
  }
  const html = await fetchNkHtml(
    `https://db.netkeiba.com/horse/ajax_horse_search.html?func=whole&word=${q}&match=b&limit=10`
  ).catch(() => null);
  await sleep(DELAY);
  const rows = parseNkSearchRows(html ?? "");
  let cands = rows.filter((r) => nkNameKey(r.name) === nkNameKey(name));
  const byYear = birthYear ? cands.filter((r) => r.birthYear === birthYear) : [];
  if (byYear.length) cands = byYear;
  if (cands.length !== 1) {
    mapStore.set(key, cands.length > 1 ? { ambiguous: 1, n: cands.length } : { miss: 1, n: cands.length });
    return null;
  }
  const rec = { nkId: cands[0].id, owner: cands[0].owner ?? null };
  mapStore.set(key, rec);
  return rec;
}

// ---------- 马主解析：netkeibaId 做 key ----------
async function resolveOwner(ownerId, fallbackName) {
  const cached = ownerStore.get(ownerId);
  if (cached && !FRESH_OWNER) return cached; // { name, colours } | { miss:1 }
  const colours = await downloadSilk(ownerId);
  const rec = colours ? { name: fallbackName, colours } : { miss: 1, name: fallbackName };
  ownerStore.set(ownerId, rec);
  return rec;
}

// ---------- 主流程 ----------
const dates = DATES ?? fs.readdirSync(DATA_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
let totalHorses = 0, totalSilked = 0, searches = 0, ownerFetches = 0;
const t0 = Date.now();

for (const date of dates) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json.gz")).sort()) {
    if (f.startsWith("rp-")) continue; // 海外源
    if (TRACKS && !TRACKS.includes(f.replace(".json.gz", ""))) continue;
    const file = path.join(dir, f);
    let doc;
    try {
      doc = JSON.parse(readGz(file));
    } catch (e) {
      console.log(`[err] ${date}/${f}: ${e.message}`);
      continue;
    }
    const year = parseInt(date.slice(0, 4), 10);
    let touched = 0;
    const runners = doc.races.flatMap((r) => r.runners ?? []);
    totalHorses += runners.length;

    for (const r of runners) {
      if (!r.horse?.name || !r.owner?.name) continue;
      const birthYear = r.age != null ? year - r.age : null;

      // 1) 马名搜索（缓存命中 0 请求）
      searches++;
      let hit = await searchHorse(r.horse.name, birthYear);
      if (hit) {
        // 2) 马主 netkeibaId 缓存 → 下载
        if (hit.owner?.id) {
          const before = ownerStore.get(hit.owner.id);
          if (!before || FRESH_OWNER) ownerFetches++;
          const owner = await resolveOwner(hit.owner.id, hit.owner.name);
          if (owner?.colours) {
            const silk = { url: owner.colours, owner: { id: hit.owner.id, name: owner.name } };
            if (JSON.stringify(r.silk) !== JSON.stringify(silk)) touched++;
            r.silk = silk;
            totalSilked++;
            continue;
          }
        } else {
          // 搜索命中但行内无 owner（未出道马等）：马页兜底一次（终态进 map 缓存）
          if (!("horsePageTried" in hit)) {
            const page = await fetchNkHtml(`https://db.netkeiba.com/horse/${hit.nkId}/`).catch(() => null);
            await sleep(DELAY);
            const i = page?.indexOf("<th>馬主</th>") ?? -1;
            const seg = i >= 0 ? page.slice(i, i + 1500) : "";
            const om = seg.match(/\/owner\/(\d{4,8})\/?"[^>]*>([^<]+)</);
            hit.owner = om ? { id: om[1], name: om[2].trim() } : null;
            hit.horsePageTried = 1;
            mapStore.set(`${nkNameKey(r.horse.name)}|${birthYear ?? "?"}`, hit);
          }
          if (hit.owner?.id) {
            const owner = await resolveOwner(hit.owner.id, hit.owner.name);
            if (owner?.colours) {
              const silk = { url: owner.colours, owner: { id: hit.owner.id, name: owner.name } };
              if (JSON.stringify(r.silk) !== JSON.stringify(silk)) touched++;
              r.silk = silk;
              totalSilked++;
              continue;
            }
          }
        }
      }
      // 3) 无彩衣：清掉旧值（v3 语义：以本次判定为准）
      if (r.silk) {
        delete r.silk;
        touched++;
      }
    }
    // 写盘（有变化才写）
    if (touched) writeGz(file, JSON.stringify(doc));
    console.log(`[doc] ${date}/${f.replace(".json.gz", "")}: silk ${runners.filter((x) => x.silk).length}/${runners.length}（改${touched}）`);
  }
  // 每天落盘缓存
  ownerStore.save();
  mapStore.save();
}

ownerStore.save();
mapStore.save();
const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`done: 马次=${totalHorses} 挂彩衣=${totalSilked} 搜索请求≈${searches} 马主解析=${ownerFetches} owner缓存=${ownerStore.size()} 耗时=${mins}min`);
