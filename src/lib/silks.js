// 彩衣（勝負服）解析与缓存——collect-races.js 与 backfill-silks.js 共用（2026-11-03）
// 链路（v2 重构：按马主缓存 + URL 直构，砍掉马页抓取）：
//   1) 马主级缓存：归一马主名 → { owner, colours }，同马主多马/跨日期 0 请求
//   2) NAR：netkeiba 出馬表（race_id = YYYY+jyo+MM+DD+RR）取 马名→nk马号 映射
//      —— 现在只为拿到马的 nkId 时顺带行内 owner 链接（无则后续搜索兜底）
//   3) 兜底（中央 / 出馬表未命中）：netkeiba 马名搜索 ajax（word 需 EUC-JP 编码），
//      结果行自带 owner id + 名 → 直接构造彩衣 URL 下载，无需访问马页
//   4) 彩衣 URL 规律：https://cdnv2.netkeiba.com/img/db/colours/{ownerId}.{gif|png}
//      png 为 320x240 高清版；无彩衣马主两个扩展名均 404
// 缓存（入库 data/pedigree/，CI 增量复用）：
//   nk-owner.json  key=归一马主名 → { owner, colours(本地路径|null), miss? }
//   nk-horse.json  key=nk马号 → { owner, colours(本地路径|null) }（历史链路保留，供回溯）
//   nk-map.json    key=归一马名|出生年 → { nkId } | { miss:1 }（搜索结果终态）
import path from "node:path";
import fs from "node:fs";
import { fetchNkHtml, fetchBuffer } from "./fetch.js";
import { pedCache } from "./ped-cache.js";
import { parseNkShutuba, parseNkSearchRows, nkNameKey } from "./parse-netkeiba.js";
import { resolveWfSilk, saveWfCaches, wfStats } from "./winfinal.js";
import { NK_JYO } from "../race-config.js";

const SILKS_DIR = path.resolve("data", "silks");
const PED_DIR = path.resolve("data", "pedigree");
const nkHorseStore = pedCache(path.join(PED_DIR, "nk-horse.json"));
const nkMapStore = pedCache(path.join(PED_DIR, "nk-map.json"));
const nkOwnerStore = pedCache(path.join(PED_DIR, "nk-owner.json")); // 马主级缓存（v2 新增）

let DELAY = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function setSilkDelay(ms) {
  DELAY = ms;
}

export function saveSilkCaches() {
  nkHorseStore.save();
  nkMapStore.save();
  nkOwnerStore.save();
  saveWfCaches();
}

export function silkStats() {
  return { nkHorse: nkHorseStore.size(), nkMap: nkMapStore.size(), nkOwner: nkOwnerStore.size(), wf: wfStats() };
}

// ---------- EUC-JP 编码（零依赖：用 TextDecoder 反查表） ----------
// netkeiba db.* 全站 EUC-JP，搜索接口的 word 参数必须按 EUC-JP 百分号编码；
// Node 只有 TextDecoder（解码）没有对应 Encoder，故首次调用时遍历全部双字节组合
// 建「字符 → EUC-JP 字节」反查表（JIS X 0208 ≈ 3.5k 项，一次性构建 <10ms）。
let EUC_REV = null;
function eucJpEncode(str) {
  if (!EUC_REV) {
    EUC_REV = new Map();
    const dec = new TextDecoder("euc-jp");
    const buf = new Uint8Array(2);
    for (let hi = 0xa1; hi <= 0xfe; hi++) {
      for (let lo = 0xa1; lo <= 0xfe; lo++) {
        buf[0] = hi;
        buf[1] = lo;
        const s = dec.decode(buf);
        if (s !== "\uFFFD") EUC_REV.set(s, [hi, lo]); // 解码失败（replacement char）跳过
      }
    }
    buf[0] = 0x8e; // 半角片假名：0x8E + 0xA1..0xDF
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
    if (!b) return null; // JIS X 0208 外字符（无法编码）→ 调用方跳过该马
    bytes.push(...b);
  }
  return bytes;
}

const eucQuery = (s) => {
  const b = eucJpEncode(s);
  return b ? b.map((x) => "%" + x.toString(16).toUpperCase().padStart(2, "0")).join("") : null;
};

// ---------- 马主名归一 ----------
// JBIS 与 netkeiba 的马主名写法差异（(同)/(株)/(有) 法人后缀、全半角、空白）。
// 实测 2709 已挂 silk 的马：归一后同名马主对应多个 netkeiba id 仅 3 例（0.1%），
// 彩衣图本身按马主登记且唯一 → 名字归一作 key 足够。
export function nkOwnerKey(owner) {
  if (!owner) return null;
  const name = typeof owner === "string" ? owner : owner.name;
  if (!name) return null;
  return (
    name
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角→半角
      .replace(/\s+/g, "")
      .replace(/^同[）)]?/, "")
      .replace(/[（(]同[）)]/g, "")
      .replace(/[（(](?:株|有|財|社|特|法|名|資)[）)]/g, "") // 法人形态括注
      .replace(/[（(]/g, "")
      .replace(/[）)]/g, "")
      .toUpperCase()
  );
}

// ---------- 彩衣图下载（URL 直构） ----------
// https://cdnv2.netkeiba.com/img/db/colours/{ownerId}.{png|gif}：png=320x240 高清版。
// 无彩衣马主两个扩展名均 404 → 直接当终态缓存 miss。
async function downloadSilkByOwner(ownerId) {
  const base = `https://cdnv2.netkeiba.com/img/db/colours/${ownerId}`;
  for (const ext of ["png", "gif"]) {
    // 本地已有任意扩展名 → 直接复用
    for (const e2 of ["png", "gif"]) {
      if (fs.existsSync(path.join(SILKS_DIR, `${ownerId}.${e2}`))) {
        return `data/silks/${ownerId}.${e2}`;
      }
    }
    const got = await fetchBuffer(`${base}.${ext}`, { src: "netkeiba-img" }).catch(() => null);
    if (got && /^image\//.test(got.contentType ?? "")) {
      if (got.buf.length >= 100) {
        fs.mkdirSync(SILKS_DIR, { recursive: true });
        fs.writeFileSync(path.join(SILKS_DIR, `${ownerId}.${ext}`), got.buf);
        return `data/silks/${ownerId}.${ext}`;
      }
    }
    await sleep(200); // 扩展名重试间稍等
  }
  return null; // 两扩展名均无 → 无彩衣
}

// ---------- 马主级解析（核心路径） ----------
// 输入：JBIS 马主（runner.owner，名字可能带法人后缀）+ 可选的 netkeiba owner（搜索行/出馬表带出）
// 输出：{ owner, colours } | { miss: 1 }（终态无彩衣）| undefined（无马主名，不缓存）
async function resolveOwnerSilk(jbisOwner, nkOwnerHint) {
  const key = nkOwnerKey(jbisOwner);
  if (!key) return undefined; // 无马主名 → 不缓存，也不解析（没有线索）
  const cached = nkOwnerStore.get(key);
  if (cached) return cached.miss ? null : cached;

  // 线索优先级：netkeiba 搜索行带出的 owner id > JBIS id（两套体系，直接构 URL）
  let ownerId = nkOwnerHint?.id ?? null;
  let ownerName = nkOwnerHint?.name ?? (typeof jbisOwner === "object" ? jbisOwner.name : jbisOwner);
  if (!ownerId && typeof jbisOwner === "object" && /^J?\d+$/.test(String(jbisOwner.id ?? ""))) {
    // JBIS 地方马主 id 是纯数字（0720040001），JRA 是 J 开头（J012063）——不是 netkeiba id，不能直构
    ownerId = null;
  }
  if (!ownerId) {
    // 无 netkeiba owner id 线索 → 用马主名搜 netkeiba 马主页（owner/list.html?word=）：
    // 命中时页面 canonical 即 /owner/{hashOrId}/，正文含数字 owner id（彩衣 URL 用）；
    // 首搜带全名（含法人前缀/尾缀），无结果时逐级剥尾缀重试（JBIS 写法常带 R/HD/牧場 等尾巴，
    // netkeiba 登记名不带，如 ノルマンディーサラブレッドR vs netkeiba「ノルマンディーサラブレッド」）。
    // 全部失败 → 写 miss 终态（此时已穷尽搜索手段，可判定）
    ownerId = await searchOwnerIdByName(ownerName);
    if (!ownerId) {
      nkOwnerStore.set(key, { miss: 1, via: "owner-search" });
      return null;
    }
  }
  const colours = await downloadSilkByOwner(ownerId);
  const rec = colours ? { owner: { id: ownerId, name: ownerName }, colours } : { miss: 1, via: "url-404" };
  nkOwnerStore.set(key, rec);
  return colours ? rec : null;
}

// ---------- 马主名搜索（owner/list.html，EUC-JP） ----------
// 返回数字 owner id 或 null。搜索页 title 命中马主名 + canonical /owner/{hash}/；
// 访问 canonical 页取数字 id（彩衣 CDN 用数字 id）。
// 剥尾缀重试：JBIS 法人/クラブ名常带 R/HD/株/牧場 等尾巴而 netkeiba 登记名不带。
async function searchOwnerIdByName(name) {
  const tries = [name];
  const stripped = name.replace(/[A-Za-z]{1,4}$/, "").trim(); // 英文尾缀（レッドR/ホールディングスHD 的短尾）
  if (stripped && stripped !== name && stripped.length >= 4) tries.push(stripped);
  for (const word of tries) {
    const q = eucQuery(word);
    if (!q) continue;
    const html = await fetchNkHtml(`https://db.netkeiba.com/owner/list.html?word=${q}`).catch(() => null);
    await sleep(DELAY);
    if (!html) continue;
    const can = html.match(/canonical" href="https:\/\/db\.netkeiba\.com\/owner\/([^"\/]+)\//)?.[1];
    if (!can) continue;
    // 数字 id 已在搜索页（同名多马主时可能多条，取 title 精确匹配的那条）
    const direct = html.match(new RegExp(`owner/(\\d{4,8})/[^>]*title="${word}"`));
    if (direct) return direct[1];
    const page = await fetchNkHtml(`https://db.netkeiba.com/owner/${can}/`).catch(() => null);
    await sleep(DELAY);
    if (!page) continue;
    if (!page.includes(`${word}のプロフィール`)) continue; // 搜索页可能模糊命中别的马主
    const id = page.match(/\/owner\/(\d{4,8})\//)?.[1];
    if (id) return id;
  }
  return null;
}

// ---------- 马名搜索 → nk马号 + owner（中央 / 出馬表未命中的兜底） ----------
// birthYear = 赛事年份 - age（日本马龄制：1月1日统一加歳，差值即出生年）
async function resolveNkIdByName(name, birthYear) {
  const key = `${nkNameKey(name)}|${birthYear ?? "?"}`;
  const cached = nkMapStore.get(key);
  if (cached) return cached.miss ? null : cached.nkId;

  const q = eucQuery(nkNameKey(name));
  if (!q) {
    nkMapStore.set(key, { miss: 1 }); // 马名含 JIS X 0208 外字符，搜索不可用
    return null;
  }
  const html = await fetchNkHtml(
    `https://db.netkeiba.com/horse/ajax_horse_search.html?func=whole&word=${q}&match=b&limit=10`
  ).catch(() => null);
  await sleep(DELAY);
  const rows = parseNkSearchRows(html);
  // 精确匹配：归一马名一致 + 出生年一致；年未知时要求唯一
  let cands = rows.filter((r) => nkNameKey(r.name) === nkNameKey(name));
  const byYear = birthYear ? cands.filter((r) => r.birthYear === birthYear) : [];
  if (byYear.length) cands = byYear;
  if (cands.length !== 1) {
    nkMapStore.set(key, { miss: 1, n: cands.length }); // 0 = 查无此马；>1 = 同名同年无法分辨
    return null;
  }
  nkMapStore.set(key, { nkId: cands[0].id, owner: cands[0].owner ?? null });
  return cands[0].id;
}

// ---------- 出走马 → silk（供采集/回填共用） ----------
// 链路（2026-11-04 起）：netkeiba 优先（马名+生年唯一性）→ 未命中走 winfinal（同口径唯一性）。
// 马名用 JBIS 马页的登录名（jbis-name 缓存），不用出馬表带尾缀的显示名。
async function netkeibaSilk(runner, nkId, birthYear) {
  const jbisOwner = runner.owner;
  // 1) 马主级缓存命中 → 直接挂（同马主多马 0 请求）
  const key = nkOwnerKey(jbisOwner);
  if (key) {
    const cached = nkOwnerStore.get(key);
    if (cached && !cached.miss && cached.colours) {
      return { url: cached.colours, owner: cached.owner, via: "netkeiba-owner" };
    }
    if (cached?.miss) return null; // 终态：该马主无登记彩衣（或无线索）→ 交给 winfinal
  }
  // 2) 马名搜索：拿 nkId + 搜索行 owner 线索（缓存未命中才走）
  const id = nkId ?? (await resolveNkIdByName(runner.horse.name, birthYear));
  let ownerHint = null;
  if (id) {
    const mapRec = nkMapStore.get(`${nkNameKey(runner.horse.name)}|${birthYear ?? "?"}`);
    ownerHint = mapRec?.owner ?? null;
  }
  // 3) 马主解析（缓存 → URL 直构下载）
  const resolved = await resolveOwnerSilk(jbisOwner, ownerHint);
  return resolved?.colours ? { url: resolved.colours, owner: resolved.owner, via: "netkeiba" } : null;
}

export async function resolveRunnerSilk(runner, nkId = null) {
  if (!runner?.horse?.name || runner.silk) return;
  const year = runner._silkYear;
  // 生年：JBIS 马页 foaled（精确）优先；否则赛事年 − age
  const birthYear = runner.horse.foaled
    ? parseInt(runner.horse.foaled.slice(0, 4), 10)
    : runner.age != null && year
      ? year - runner.age
      : null;

  const nk = await netkeibaSilk(runner, nkId, birthYear);
  if (nk) {
    runner.silk = nk;
    return;
  }
  // 兜底：winfinal 勝負服データベース（馬名完全一致 + 生年）
  const name = runner.horse.nameJp ?? runner.horse.name;
  const wf = await resolveWfSilk(name, birthYear, { delayMs: DELAY });
  if (wf?.colours) runner.silk = { url: wf.colours, owner: wf.owner, via: "winfinal" };
}

// ---------- 单场：NAR 出馬表捷径 + 逐马兜底 ----------
export async function enrichSilks(date, track, rec) {
  if (!rec.runners?.length) return;
  const ymd8 = date.replace(/-/g, "");
  const jyo = NK_JYO[track];
  let nameToId = null;
  if (jyo) {
    const raceId = `${ymd8.slice(0, 4)}${jyo}${ymd8.slice(4, 6)}${ymd8.slice(6, 8)}${String(rec.no).padStart(2, "0")}`;
    try {
      const shutuba = await fetchNkHtml(`https://nar.netkeiba.com/race/shutuba.html?race_id=${raceId}`).catch(() => null);
      await sleep(DELAY);
      if (shutuba) nameToId = parseNkShutuba(shutuba);
    } catch {
      /* netkeiba 未出表/无该场 → 逐马兜底 */
    }
  }
  let n = 0;
  for (const r of rec.runners) {
    r._silkYear = parseInt(date.slice(0, 4), 10); // birthYear 计算基准年
    const before = !!r.silk;
    try {
      await resolveRunnerSilk(r, nameToId?.get(nkNameKey(r.horse?.name)) ?? null);
    } catch (e) {
      console.log(`[silk] ${date} ${track} ${rec.no}R ${r.horse?.name}: ${e.message}`);
    }
    delete r._silkYear;
    if (!before && r.silk) n++;
  }
  if (n) console.log(`[silk] ${date} ${track} ${rec.no}R: ${n}/${rec.runners.length} 頭`);
}
