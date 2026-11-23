// ABCPCC Stud Book Brasileiro 客户端（巴西纯血马血统库，免费、免登录、无验证码）
//
// ## 站点结构（2026-11-17 实测，abcpcc.com.br = Laravel 8 + Nuxt 外壳）
// 前端外壳是 SPA（HTML 只有骨架），但**详情接口全部直接吐 JSON**，可以纯 HTTP 打：
//   1) GET /studbook/buscar?nome={NAME}         → [{registro, nome, sexo, nascimento}]
//        · 模糊匹配，返回多条；空 query 返回 `[]`（2 字节）
//   2) GET /studbook/animal?inscricao={registro} → {nome, pai, mae, nascimento, criacao, proprietario}
//        · 注意参数名只认 inscricao（registro/id/codigo 一律报「inscricao obrigatória」）
//   3) GET /consultar-animal/nome/{NAME}         → 302 到 /consultar-animal/{id}/{slug}
//        · id 形如「0.237852」（0=国产 / 1=引进 / 9=海外祖先），去掉前缀即 registro
//   4) GET /consultar-animal/{id}/pedigree       → 完整血统树 JSON（5 代递归，含每匹祖先的
//        毛色 / 出生年 / 生涯战绩），字段：{pai:{id,nome,pelagem,ano,ganhos,campanha,pai,mae}, mae:{…}}
//
// 于是「一匹马 → 父/母/父父/母父/母母/父母」只需 3~4 个请求，可缓存、可 CI 跑。
// 站方无 robots 限制详情页，仍按 1 请求 / 300ms 节流，礼貌抓取。
import fs from "node:fs";
import path from "node:path";
import { logRequest } from "./reqlog.js";

export const BASE = "https://abcpcc.com.br";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CACHE_DIR = path.resolve("data", "pedigree", "abcpcc");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 名称归一 ----------
/** 去重音 / 去国别后缀 / 压空白 / 大写：「Poderoso Chefão (BRZ)」→「PODEROSO CHEFAO」 */
export function normName(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\([A-Z]{2,3}\)\s*$/g, "") // 尾部国别
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}
/** URL slug：norm 后小写 + 连字符（站方 slug 规则一致） */
export const slugOf = (s) => normName(s).toLowerCase().replace(/\s+/g, "-");

// ---------- HTTP ----------
async function req(url, { redirect = "manual", src = "abcpcc" } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect,
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json, text/html;q=0.9,*/*;q=0.8" },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    logRequest({ src, url, status: res.status, ok: res.ok, ms: Date.now() - t0, bytes: Buffer.byteLength(text) });
    return { status: res.status, location: res.headers.get("location"), text };
  } catch (e) {
    logRequest({ src, url, status: 0, ok: false, ms: Date.now() - t0, err: e.message });
    return { status: 0, location: null, text: "", error: e.message };
  }
}

/** 返回 { ok, data }：ok=false 表示网络/限流失败（不可当作「查无此马」缓存）
 *
 * 403/429 处理（2026-11-21 起 CI 实测：站方对 GitHub runner IP 段整段封锁，240×403 + 332×429）：
 *   不再退避重试——重试只会把单日请求量放大 4 倍（143 马 × 4 = 572 次，零产出），
 *   也不会误缓存成「查无此马」。改为记录 blockedUntil（进程级 6h 熔断）：
 *   熔断窗口内后续马名直接短路返回 failed，等下次运行再探测封锁是否解除。
 */
const BLOCK_TTL_MS = 6 * 3600 * 1000;
let blockedUntil = 0;

export function isBlocked() {
  return Date.now() < blockedUntil;
}

async function getJson(url, { retries = 3 } = {}) {
  if (isBlocked()) return { ok: false, data: null, why: "blocked" };
  for (let i = 0; i <= retries; i++) {
    const r = await req(url);
    if (r.status === 200) {
      try {
        return { ok: true, data: JSON.parse(r.text) };
      } catch {
        return { ok: false, data: null, why: "bad-json" };
      }
    }
    if (r.status === 404) return { ok: true, data: null, why: "404" };
    if (r.status === 403 || r.status === 429) {
      // 站方封锁/限流：熔断 6h，本进程内不再发请求
      blockedUntil = Date.now() + BLOCK_TTL_MS;
      console.log(`[abcpcc] HTTP ${r.status}（疑似站方封锁 runner IP），熔断 ${BLOCK_TTL_MS / 3600000}h，本次运行剩余马名跳过`);
      return { ok: false, data: null, why: "blocked" };
    }
    // 5xx/0：抖动，退避重试
    await sleep(1200 * (i + 1));
  }
  return { ok: false, data: null, why: "http" };
}

// ---------- 缓存 ----------
const mem = new Map(); // slug → record（进程内，避免同一匹马在多个场次重复打）

function cacheFile(slug) {
  return path.join(CACHE_DIR, `${slug}.json`);
}
const MISS_TTL_MS = 3 * 24 * 3600 * 1000; // 「查无此马」负缓存 3 天

function readCache(slug) {
  if (mem.has(slug)) return mem.get(slug);
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(slug), "utf8"));
    if (j.missing && Date.now() - Date.parse(j.fetchedAt ?? 0) > MISS_TTL_MS) return null; // 过期重试
    mem.set(slug, j);
    return j;
  } catch {
    return null;
  }
}
function writeCache(slug, rec) {
  mem.set(slug, rec);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(slug), JSON.stringify(rec, null, 1));
}

// ---------- 公开接口 ----------
/** 按名搜索（模糊）：{ ok, list:[{registro, nome, sexo, nascimento}] } */
export async function searchName(name) {
  const { ok, data } = await getJson(`${BASE}/studbook/buscar?nome=${encodeURIComponent(normName(name))}`);
  return { ok, list: Array.isArray(data) ? data : [] };
}

/** 按 registro 取基本档案（父/母/繁育者/马主）；查无返回 null */
export async function animalByRegistro(registro) {
  const { data } = await getJson(`${BASE}/studbook/animal?inscricao=${encodeURIComponent(registro)}`);
  return data && typeof data === "object" && !data.error ? data : null;
}

/** 按名解析出站内 id（走 302 拿 Location 里的 id，不做 HTML 解析） */
export async function resolveId(name) {
  const r = await req(`${BASE}/consultar-animal/nome/${encodeURIComponent(normName(name))}`);
  const loc = r.location;
  const m = String(loc ?? "").match(/consultar-animal\/([\d.]+)(?:\/([^/?#]+))?/);
  if (!m) return null;
  return { id: m[1], slug: m[2] ?? null };
}

/** 5 代血统树（原始 JSON）；查无返回 null */
export async function pedigreeTree(id) {
  const { data } = await getJson(`${BASE}/consultar-animal/${encodeURIComponent(id)}/pedigree`);
  return data && typeof data === "object" && !data.erro ? data : null;
}

/** 树裁剪：只留 4 代（16 匹高祖辈），字段压成 name/year/color，控制缓存体积 */
export function trimTree(node, depth = 0, maxDepth = 3) {
  if (!node || !node.nome) return null;
  const out = { n: node.nome, y: node.ano ?? null, c: node.pelagem ?? null };
  if (depth < maxDepth) {
    const s = trimTree(node.pai, depth + 1, maxDepth);
    const d = trimTree(node.mae, depth + 1, maxDepth);
    if (s) out.s = s;
    if (d) out.d = d;
  }
  return out;
}
/** 裁剪树 → 扁平字段（父/母/父父/母父/母母/父母） */
export function flatten(tree) {
  if (!tree) return {};
  const name = (x) => (x?.nome ? String(x.nome).trim() : null);
  return {
    sire: name(tree.pai),
    dam: name(tree.mae),
    sireSire: name(tree.pai?.pai),
    sireDam: name(tree.pai?.mae),
    bms: name(tree.mae?.pai), // 母父
    damDam: name(tree.mae?.mae),
    sireSireSire: name(tree.pai?.pai?.pai),
    bmsSire: name(tree.mae?.pai?.pai), // 母父父（三代）
  };
}

const SEX_MAP = { M: "牡", F: "牝", C: "騸" }; // Macho / Fêmea / (castrado 少见)
const COAT_MAP = {
  CAS: "鹿毛", // Castanho
  ALA: "栗毛", // Alazão
  TOR: "芦毛", // Tordilho
  PRE: "青毛", // Preto
  ZAI: "鹿毛", // Zaino（南美用法，接近 bay）
  BAI: "鹿毛", // Baio（浅栗/淡黄）
  ROS: "月毛", // Rosilho
  OVE: "鹿毛",
};

/**
 * 一匹马的全量血统档案（带磁盘缓存，命中不发请求）：
 *   { registro, id, nome, nameOk, sex, sexRaw, birth, breeder, owner,
 *     sire, dam, sireSire, sireDam, bms, damDam, sireSireSire, bmsSire, source, fetchedAt }
 * @param name 马名（任意大小写 / 带国别后缀 / 带重音）
 * @param opts.yearHint 比赛年份，用于「同名不同马」裁决（1985 年的 OKEYDOKE 不会顶替 2022 年那匹）
 * @param opts.sexHint  "牡" / "牝"，程序表/结果页已知性别时进一步收窄
 * @param opts.force    忽略缓存重抓；opts.offline 只用缓存，不再打网络
 */
export async function horseProfile(name, { force = false, offline = false, yearHint = null, sexHint = null } = {}) {
  const slug = slugOf(name);
  if (!slug) return null;
  if (!force) {
    const hitCache = readCache(slug);
    if (hitCache) return hitCache;
  }
  if (offline) return null;
  if (isBlocked()) return { slug, nome: name, missing: false, failed: true, blocked: true, fetchedAt: new Date().toISOString() };

  const sr = await searchName(name);
  if (!sr.ok) return { slug, nome: name, missing: false, failed: true, blocked: sr.why === "blocked", fetchedAt: new Date().toISOString() };
  const cands = sr.list.filter((c) => normName(c.nome) === normName(name));
  if (!cands.length) {
    // 真·查无此马：负缓存 3 天（站方补充登记后可重试），抓取失败不进缓存
    const miss = { slug, nome: name, missing: true, fetchedAt: new Date().toISOString() };
    writeCache(slug, miss);
    return miss;
  }
  // 「同名不同马」裁决：先按比赛年份收口（存活期 2~20 年），再优先性别相符、出生最近
  const yearOf = (c) => Number(String(c.nascimento ?? "").match(/(\d{4})$/)?.[1] ?? 0);
  let pool = cands;
  if (yearHint) {
    const fit = cands.filter((c) => { const y = yearOf(c); return y && y <= yearHint && y >= yearHint - 20; });
    if (fit.length) pool = fit;
  }
  if (sexHint && pool.length > 1) {
    const bySex = pool.filter((c) => (SEX_MAP[String(c.sexo ?? "").toUpperCase()] ?? null) === sexHint);
    if (bySex.length) pool = bySex;
  }
  pool = pool.slice().sort((a, b) => yearOf(b) - yearOf(a)); // 最近出生优先（现役马）
  const chosen = pool[0];

  const registro = String(chosen.registro);
  // 站内 id 需要「0./1./9.」前缀（0=国产、1=引进、9=海外），前缀不写在搜索结果里 → 逐个探
  let tree = null;
  let usedId = null;
  for (const pre of ["0.", "1.", "9."]) {
    const t = await pedigreeTree(pre + registro);
    if (t && (t.pai || t.mae)) { tree = t; usedId = pre + registro; break; }
    await sleep(200);
  }
  const info = await animalByRegistro(registro);
  const flat = flatten(tree);
  const by = String(chosen.nascimento ?? info?.nascimento ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const rec = {
    slug,
    registro,
    id: usedId,
    nome: chosen.nome ?? name,
    nameOk: true,
    sexRaw: chosen.sexo ?? null,
    sex: SEX_MAP[String(chosen.sexo ?? "").toUpperCase()] ?? null,
    birth: by ? `${by[3]}-${by[2]}-${by[1]}` : null,
    birthRaw: chosen.nascimento ?? null,
    breeder: info?.criacao?.trim() || null,
    owner: info?.proprietario?.trim() || null,
    sireRaw: info?.pai ?? flat.sire ?? null,
    damRaw: info?.mae ?? flat.dam ?? null,
    ...flat,
    source: usedId ? `${BASE}/consultar-animal/${usedId}` : `${BASE}/studbook/animal?inscricao=${registro}`,
    fetchedAt: new Date().toISOString(),
  };
  // tree 的父子关系更准，缺了才用 animal 接口的字符串兜底
  if (!rec.sire && rec.sireRaw) rec.sire = rec.sireRaw;
  if (!rec.dam && rec.damRaw) rec.dam = rec.damRaw;
  if (!tree) rec.partial = true;
  // 同名多候选时记下来，便于日后人工核对
  if (cands.length > 1) rec.ambiguous = cands.map((c) => `${c.registro}:${c.nascimento ?? ""}:${c.sexo ?? ""}`);
  writeCache(slug, rec);
  return rec;
}

// ---------- 展示用：毛色（祖先树里有 pelagem，本体没有 → 从搜索结果补不到，留空） ----------
export const colorJa = (raw) => COAT_MAP[String(raw ?? "").toUpperCase()] ?? null;

export const cacheDir = CACHE_DIR;
