// 彩衣全量重爬 v4（2026-11-04）：netkeiba 优先 → winfinal 兜底
//
// 与 v3 的差别：
//   1) 马名用 JBIS 马页登录名（horse.name = 日文名，horse.foaled 精确生日），不再用出馬表带「 B」尾缀的显示名
//   2) 生年优先取 horse.foaled，其次 赛事年 − age
//   3) netkeiba 判无（搜索 0 命中 / 马主无登记 / 双 404）后，走 fuku.winfinal.com 馬名完全一致検索，
//      以「馬名 + 生年月日」唯一命中 → 馬主名 + 服色图
//
// 缓存：nk-map / nk-owner-v3 / wf-horse / wf-owner（均入库，重跑 0 网络）
// 用法：node src/backfill-silks-v4.js [--dates ...] [--tracks 236,105] [--delay 1200] [--no-clear]
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { fetchNkHtml, fetchBuffer } from "./lib/fetch.js";
import { pedCache } from "./lib/ped-cache.js";
import { parseNkSearchRows, nkNameKey } from "./lib/parse-netkeiba.js";
import { resolveWfSilk, saveWfCaches } from "./lib/winfinal.js";
import { reqStats } from "./lib/reqlog.js";

const DATA_DIR = path.resolve("data", "races");
const SILKS_DIR = path.resolve("data", "silks");
const PED_DIR = path.resolve("data", "pedigree");
const ownerStore = pedCache(path.join(PED_DIR, "nk-owner-v3.json")); // key=netkeibaId → { name, colours, miss? }
const mapStore = pedCache(path.join(PED_DIR, "nk-map.json")); // key=馬名|生年 → { nkId, owner } | { miss }

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const DATES = argOf("--dates")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const TRACKS = argOf("--tracks")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const DELAY = parseInt(argOf("--delay") ?? "1200", 10);
const NO_CLEAR = argv.includes("--no-clear");
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

async function downloadSilk(ownerId) {
  for (const e2 of ["png", "gif"]) {
    if (fs.existsSync(path.join(SILKS_DIR, `${ownerId}.${e2}`))) return `data/silks/${ownerId}.${e2}`;
  }
  for (const ext of ["png", "gif"]) {
    const got = await fetchBuffer(`https://cdnv2.netkeiba.com/img/db/colours/${ownerId}.${ext}`, {
      src: "netkeiba-img",
    }).catch(() => null);
    if (got && /^image\//.test(got.contentType ?? "") && got.buf.length >= 100) {
      fs.mkdirSync(SILKS_DIR, { recursive: true });
      fs.writeFileSync(path.join(SILKS_DIR, `${ownerId}.${ext}`), got.buf);
      return `data/silks/${ownerId}.${ext}`;
    }
    await sleep(250);
  }
  return null;
}

// 马名搜索：唯一命中 → { nkId, owner }（终态缓存 nk-map；key 用归一马名|生年）
async function searchHorse(name, birthYear) {
  const key = `${nkNameKey(name)}|${birthYear ?? "?"}`;
  const cached = mapStore.get(key);
  if (cached) return cached;

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

async function resolveOwner(ownerId, fallbackName) {
  const cached = ownerStore.get(ownerId);
  if (cached) return cached;
  const colours = await downloadSilk(ownerId);
  const rec = colours ? { name: fallbackName, colours } : { miss: 1, name: fallbackName };
  ownerStore.set(ownerId, rec);
  return rec;
}

const dates =
  DATES ??
  fs
    .readdirSync(DATA_DIR)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();

let totalHorses = 0, nkHit = 0, wfHit = 0, searches = 0;
const via = { netkeiba: 0, winfinal: 0, none: 0 };
const t0 = Date.now();

for (const date of dates) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json.gz")).sort()) {
    if (f.startsWith("rp-")) continue; // 海外源彩衣走 sportinglife（采集中直接落）
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
    const runners = doc.races.flatMap((r) => r.runners ?? []);
    totalHorses += runners.length;
    const before = JSON.stringify(doc);

    for (const r of runners) {
      const nameJp = r.horse?.nameJp ?? r.horse?.name;
      if (!nameJp) continue;
      const birthYear = r.horse?.foaled ? parseInt(r.horse.foaled.slice(0, 4), 10) : r.age != null ? year - r.age : null;

      // ① netkeiba
      searches++;
      let hit = null;
      const nk = await searchHorse(nameJp, birthYear);
      if (nk?.owner?.id) {
        const owner = await resolveOwner(nk.owner.id, nk.owner.name);
        if (owner?.colours) hit = { url: owner.colours, owner: { id: nk.owner.id, name: owner.name }, via: "netkeiba" };
      } else if (nk && !("horsePageTried" in nk)) {
        // 搜索命中但行内无 owner（未出道马）：马页兜底一次
        const page = await fetchNkHtml(`https://db.netkeiba.com/horse/${nk.nkId}/`).catch(() => null);
        await sleep(DELAY);
        const i = page?.indexOf("<th>馬主</th>") ?? -1;
        const seg = i >= 0 ? page.slice(i, i + 1500) : "";
        const om = seg.match(/\/owner\/(\d{4,8})\/?"[^>]*>([^<]+)</);
        nk.owner = om ? { id: om[1], name: om[2].trim() } : null;
        nk.horsePageTried = 1;
        mapStore.set(`${nkNameKey(nameJp)}|${birthYear ?? "?"}`, nk);
        if (nk.owner?.id) {
          const owner = await resolveOwner(nk.owner.id, nk.owner.name);
          if (owner?.colours) hit = { url: owner.colours, owner: { id: nk.owner.id, name: owner.name }, via: "netkeiba" };
        }
      }
      if (hit) {
        nkHit++;
        via.netkeiba++;
      } else {
        // ② winfinal 兜底（馬名完全一致 + 生年唯一）
        const wf = await resolveWfSilk(nameJp, birthYear, { delayMs: DELAY });
        if (wf?.colours) {
          hit = { url: wf.colours, owner: wf.owner, via: "winfinal" };
          wfHit++;
          via.winfinal++;
        } else {
          via.none++;
        }
      }

      if (hit) {
        r.silk = hit;
      } else if (!NO_CLEAR && r.silk) {
        delete r.silk; // 以本次判定为准（与 v3 一致的重新覆盖语义）
      }
    }

    if (JSON.stringify(doc) !== before) writeGz(file, JSON.stringify(doc));
    console.log(
      `[doc] ${date}/${f.replace(".json.gz", "")}: silk ${runners.filter((x) => x.silk).length}/${runners.length}`
    );
  }
  ownerStore.save();
  mapStore.save();
  saveWfCaches();
}

ownerStore.save();
mapStore.save();
saveWfCaches();
const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(
  `done: 馬次=${totalHorses} netkeiba=${nkHit} winfinal=${wfHit} 无=${via.none} 请求=${reqStats().total} 耗时=${mins}min`
);
