// Stud Book Argentino（studbook.org.ar，阿根廷官方血统登记）客户端
//
// ## 站点结构（2026-11-17 实测）
// - 搜索接口 `/ejemplares/buscar-resultados?q={NAME}&movil=0` 返回 **HTML 片段表格**
//   （Nombre / Raza / Sexo / Nacimiento / Pelo / Padre / Madre），但必须带：
//     · Cookie（任意一次访问 /ejemplares 拿到的会话）
//     · Referer: https://www.studbook.org.ar/ejemplares
//     · X-Requested-With: XMLHttpRequest
//   三者齐备时不需要任何验证码 —— 这也是它能进 CI 的原因（无头会话即可）。
// - 马匹档案页 `/ejemplares/perfil/{id}/{slug}` 首段就写明三代：
//     「por {父} y {母} por {母父}」——三段都是带 id 的链接，不存在同名歧义。
// - 因此：父/母/母父 1 个请求拿全；「父父」再抓父马档案页 1 个请求；「母母」同理可选。
//
// 与巴西 ABCPCC 的差异：ABCPCC 直接吐 5 代 JSON 树，这里只能逐层抓页面 —— 但仍属免费、
// 免登录、可缓存，是阿根廷（San Isidro / La Plata / Palermo）唯一可批量补齐的官方来源。
import fs from "node:fs";
import path from "node:path";
import { logRequest } from "./reqlog.js";

export const BASE = "https://www.studbook.org.ar";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CACHE_DIR = path.resolve("data", "pedigree", "sba");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const normName = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`´]/g, "'")
    .toUpperCase()
    .replace(/\([A-Z]{2,3}\)\s*$/g, "")
    .replace(/[^A-Z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const slugOf = (s) => normName(s).toLowerCase().replace(/\s+/g, "-");

let cookie = null;

async function req(url, { headers = {}, src = "sba" } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      signal: AbortSignal.timeout(25000),
    });
    const setC = res.headers.getSetCookie?.() ?? [];
    for (const c of setC) {
      const kv = String(c).split(";")[0];
      if (kv.includes("=") && !/deleted/i.test(c)) cookie = kv;
    }
    const text = await res.text();
    logRequest({ src, url, status: res.status, ok: res.ok, ms: Date.now() - t0, bytes: Buffer.byteLength(text) });
    return { status: res.status, text };
  } catch (e) {
    logRequest({ src, url, status: 0, ok: false, ms: Date.now() - t0, err: e.message });
    return { status: 0, text: "", error: e.message };
  }
}

/** 建立会话（拿 Cookie）；后续请求都带上 */
export async function ensureSession() {
  if (cookie) return true;
  const r = await req(`${BASE}/ejemplares`);
  return r.status === 200 && !!cookie;
}

const decode = (s) =>
  String(s ?? "")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");

/** 检索用名：保留重音（西语 Ñ 是独立字母，站方按 Ñ 建索引，「ANO BUENO」查不到「AÑO BUENO」） */
const queryName = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/[’'`´]/g, "'")
    .toUpperCase()
    .replace(/\([A-Z]{2,3}\)\s*$/g, "")
    .replace(/[^A-ZÀ-Ÿ' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** 按名搜索 → [{ id, slug, name, sexRaw, birth, coat, sire, dam }] */
export async function search(name) {
  if (!(await ensureSession())) return { ok: false, list: [] };
  const q = encodeURIComponent(queryName(name));
  const r = await req(`${BASE}/ejemplares/buscar-resultados?q=${q}&movil=0`, {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: `${BASE}/ejemplares` },
  });
  if (r.status !== 200) return { ok: false, list: [] };
  let html = decode(r.text);
  let rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  // 保留重音查不到时再退回去重音（个别马名登记时是纯 ASCII）
  if (!rows.length) {
    const q2 = encodeURIComponent(normName(name));
    if (decodeURIComponent(q2) !== decodeURIComponent(q)) {
      const r2 = await req(`${BASE}/ejemplares/buscar-resultados?q=${q2}&movil=0`, {
        headers: { "X-Requested-With": "XMLHttpRequest", Referer: `${BASE}/ejemplares` },
      });
      if (r2.status === 200) {
        html = decode(r2.text);
        rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
      }
    }
  }
  const list = [];
  for (const row of rows) {
    const link = row.match(/href="\/ejemplares\/perfil\/(\d+)\/([^"]+)"/);
    if (!link) continue;
    const nameM = row.match(/<span title="([^"]+)">/);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const txt = (i) =>
      decode(String(cells[i] ?? ""))
        .replace(/<span class="ejemplar-dato-label"[^>]*>[\s\S]*?<\/span>/g, " ") // 去掉移动端口径的「Sexo / Nacimiento / Pelo」标签
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const progenitors = [...row.matchAll(/<span class="ejemplar-progenitor">[\s\S]*?<span title="([^"]+)"/g)].map((m) => decode(m[1]));
    list.push({
      id: link[1],
      slug: link[2],
      name: decode(nameM?.[1] ?? txt(0)),
      sexRaw: txt(2),
      birth: txt(3),
      coat: txt(4),
      sire: progenitors[0] ?? (cells[5] ? txt(5) : null),
      dam: progenitors[1] ?? (cells[6] ? txt(6) : null),
    });
  }
  return { ok: true, list };
}

/** 档案页 → { id, name, sire, sireId, dam, damId, bms, bmsId } */
export async function profile(id, slug = "") {
  const url = `${BASE}/ejemplares/perfil/${id}${slug ? `/${slug}` : ""}`;
  const r = await req(url);
  if (r.status !== 200) return null;
  const html = decode(r.text);
  // 「por {父} y {母} por {母父}」三段都带 id
  const m = html.match(
    /por\s*<a href="\/ejemplares\/perfil\/(\d+)\/([^"]+)">([^<]+)<\/a>\s*y\s*<a href="\/ejemplares\/perfil\/(\d+)\/([^"]+)">([^<]+)<\/a>\s*por\s*<a href="\/ejemplares\/perfil\/(\d+)\/([^"]+)">([^<]+)<\/a>/
  );
  if (!m) {
    // 部分马（幼驹/未登记母系）只有父：por {父} y {母}（无「por 母父」）
    const m2 = html.match(/por\s*<a href="\/ejemplares\/perfil\/(\d+)\/[^"]*">([^<]+)<\/a>\s*y\s*<a href="\/ejemplares\/perfil\/(\d+)\/[^"]*">([^<]+)<\/a>/);
    if (!m2) return null;
    return {
      id,
      sireId: m2[1], sireSlug: m2[2], sire: decode(m2[3]).trim(),
      damId: m2[4], damSlug: m2[5], dam: decode(m2[6]).trim(),
      bms: null, bmsId: null,
    };
  }
  return {
    id,
    sireId: m[1], sireSlug: m[2], sire: decode(m[3]).trim(),
    damId: m[4], damSlug: m[5], dam: decode(m[6]).trim(),
    bmsId: m[7], bmsSlug: m[8], bms: decode(m[9]).trim(),
  };
}

// ---------- 缓存 ----------
const mem = new Map();
const fileOf = (slug) => path.join(CACHE_DIR, `${slug}.json`);
function readCache(slug) {
  if (mem.has(slug)) return mem.get(slug);
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(slug), "utf8"));
    mem.set(slug, j);
    return j;
  } catch {
    return null;
  }
}
function writeCache(slug, rec) {
  mem.set(slug, rec);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(fileOf(slug), JSON.stringify(rec, null, 1));
}

const SEX_MAP = { Macho: "牡", Hembra: "牝", Castrado: "騸" };
const COAT_MAP = { Zaino: "鹿毛", Castaño: "鹿毛", Colorado: "栗毛", "Tordillo": "芦毛", "Negro": "青毛", "Alazán": "栗毛", "Rosillo": "月毛" };

/**
 * 一匹马的全量档案（父/母/母父 + 父父，可选母母）
 * @param name 马名
 * @param opts.sireSire 是否再抓一层拿「父父」（多 1 请求）
 */
export async function horseProfile(name, { force = false, offline = false, sireSire = true } = {}) {
  const slug = slugOf(name);
  if (!slug) return null;
  if (!force) {
    const hit = readCache(slug);
    if (hit) return hit;
  }
  if (offline) return null;

  const sr = await search(name);
  if (!sr.ok) return { slug, nome: name, failed: true, fetchedAt: new Date().toISOString() };
  const exact = sr.list.filter((c) => normName(c.name) === normName(name));
  if (!exact.length) {
    const miss = { slug, nome: name, missing: true, fetchedAt: new Date().toISOString() };
    writeCache(slug, miss);
    return miss;
  }
  const pick = exact[0];
  const prof = await profile(pick.id, pick.slug);
  let sireSireName = null;
  if (sireSire && prof?.sireId) {
    await sleep(200);
    const sireProf = await profile(prof.sireId, prof.sireSlug ?? "");
    sireSireName = sireProf?.sire ? `${sireProf.sire}` : null;
  }
  const by = String(pick.birth ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const rec = {
    slug,
    id: pick.id,
    name: pick.name,
    sex: SEX_MAP[pick.sexRaw] ?? null,
    sexRaw: pick.sexRaw ?? null,
    birth: by ? `${by[3]}-${by[2]}-${by[1]}` : null,
    color: COAT_MAP[pick.coat] ?? null,
    colorRaw: pick.coat ?? null,
    sire: prof?.sire ?? pick.sire ?? null,
    dam: prof?.dam ?? pick.dam ?? null,
    bms: prof?.bms ?? null,
    sireSire: sireSireName,
    source: `${BASE}/ejemplares/perfil/${pick.id}`,
    fetchedAt: new Date().toISOString(),
  };
  if (!rec.sire || !rec.dam) rec.partial = true;
  if (exact.length > 1) rec.ambiguous = exact.map((c) => `${c.id}:${c.birth}`);
  writeCache(slug, rec);
  return rec;
}

export const cacheDir = CACHE_DIR;
