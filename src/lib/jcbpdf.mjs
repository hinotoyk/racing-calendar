// JCB「Programa com Retrospecto」PDF 解析（巴西 Gávea 官方节目表）
//
// ## 为什么需要它
// TurfeOnline 的节目页只给「马号 / 马名 / 骑手 / 负磅 / 闸位」，练马师、性别、血统全无；
// 而 Jockey Club Brasileiro 每个赛日会发一份官方 PDF（programa + retrospecto），每匹马都有：
//
//   2 - RODEIO - CAN THE MAN E EKANS (CRIMSON TIDE) - STUD ETERNAMENTE RIO - M - C - 18/08/20 - RS
//   J.ENICK          ← 骑手
//   58               ← 负磅
//   L.D.REIS         ← 练马师
//   STUD SAI TIRANDO ← 马主
//
// 即「{马号} - {马名} - {父} E {母} ({母父}) - {繁育者} - {性别} - {毛色} - {生日} - {出生州}」
// 一行囊括父/母/母父 + 性别/毛色/生日 + 繁育者，紧随 4 行是骑手/负磅/练马师/马主。
// 一整个赛日只需 1 个 PDF 请求，是 Gávea 场「练马师」的唯一免费来源（ABCPCC 血统库没有练马师）。
//
// ## 发现路径（2026-11-17 实测）
// 门户新闻列表 https://jcb.com.br/home/noticias 里有
//   「Gávea: Programa com retrospecto {WEEKDAY} ({dd}/{mm}/{yyyy})」
// slug 形如 gavea-programa-com-retrospecto-terca-17-11-2026，正文挂 site.jcb.com.br 的
// /repositorio/Repositorio/Programas/{uuid}{dd-mm-yy} - retro.pdf（目录不可列，必须走新闻页）。
//
// 浏览器 UA + 直链即可下载，无验证码；PDF → 文本走 src/lib/pdftext.py（PyMuPDF）。
import fs from "node:fs";
import path from "node:path";
import { fetchHtmlSoft, BROWSER_UA } from "./fetch.js";
import { pdfToText } from "../sources/teletrak.js";

const NEWS = "https://jcb.com.br/home/noticias";
const CACHE = path.resolve("data", "pedigree", "jcb");

const MONTH = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

/** slug 尾部的 dd-mm-yyyy → ISO 日期 */
function dateFromSlug(slug) {
  const m = String(slug).match(/(\d{1,2})-(\d{1,2})-(\d{4})\/?$/);
  return m ? `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}` : null;
}

/**
 * 找到某赛日的节目 PDF。
 * @returns {{ date, postUrl, pdfUrl }|null}
 */
export async function discoverPdf(dateIso, { log = console.log } = {}) {
  let html = null;
  try {
    html = await fetchHtmlSoft(NEWS, { src: "jcb", ua: BROWSER_UA, retries: 2 });
  } catch {
    html = null;
  }
  if (!html) return null;
  const posts = [...html.matchAll(/href="(https:\/\/jcb\.com\.br\/home\/noticias\/\d+\/[^"]*programa[^"]*)"/g)].map((m) => m[1]);
  const uniq = [...new Set(posts)];
  // 优先 slug 日期与目标一致；否则若列表里只有一条节目帖，最后再兜底试它
  const exact = uniq.find((u) => dateFromSlug(u.replace(/\/$/, "")) === dateIso);
  const pick = exact ?? (uniq.length === 1 ? uniq[0] : null);
  if (!pick) return null;
  let post = null;
  try {
    post = await fetchHtmlSoft(pick, { src: "jcb", ua: BROWSER_UA, retries: 2 });
  } catch {
    post = null;
  }
  if (!post) return null;
  const pdf = post.match(/href="(https:\/\/site\.jcb\.com\.br\/[^"]+\.pdf)"/i)?.[1] ?? null;
  if (!pdf) return null;
  return { date: dateIso, postUrl: pick, pdfUrl: pdf };
}

/** 下载 + 抽文本（按赛日缓存，缓存文件即文本，便于复查/回归） */
export async function programText(dateIso, { force = false, log = console.log } = {}) {
  const file = path.join(CACHE, `${dateIso}.txt`);
  if (!force && fs.existsSync(file)) return { text: fs.readFileSync(file, "utf8"), cached: true };
  const hit = await discoverPdf(dateIso, { log });
  if (!hit) return { text: null, why: "no-pdf" };
  const res = await fetch(hit.pdfUrl, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) return { text: null, why: `pdf-http-${res.status}` };
  const text = await pdfToText(Buffer.from(await res.arrayBuffer()), { log });
  if (!text) return { text: null, why: "pdf-text-fail", pdfUrl: hit.pdfUrl };
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(CACHE, `${dateIso}.meta.json`), JSON.stringify(hit, null, 1));
  return { text, pdfUrl: hit.pdfUrl, cached: false };
}

// ---------- 解析 ----------
// 「父 E 母 (母父) - 繁育者 - 性别 - 毛色 - 生日 - 州」；行首可能并上「{号} - {马名} - 」
const PED =
  /^(?:(\d{1,2})\s*-\s*([A-ZÀ-Ý0-9´'’` .\-]+?)\s*-\s*)?(.+?)\s+E\s+(.+?)\s*\((.+?)\)\s*-\s*(.+?)\s*-\s*([MFC])\s*-\s*([A-Z])\s*-\s*(\d{2}\/\d{2}\/\d{2})\s*-\s*([A-Z]{2})$/;
const WEIGHT = /^\d{2}(\/\d{1,2})?(\(\*\))?$/;
const HDR = /^(\d{1,2})\s*-\s*([A-ZÀ-Ý0-9´'’` .\-]+?)\s*-?$/;

const SEX_MAP = { M: "牡", F: "牝", C: "騸" }; // C = castrado（去勢）
const COAT_MAP = { C: "鹿毛", A: "栗毛", T: "芦毛", P: "青毛", Z: "鹿毛", B: "鹿毛", R: "月毛" };

/** 看起来像「练马师 / 马主」的行（不是成绩行、不是日期行、不是彩衣描述） */
const looksName = (s) =>
  !!s &&
  s.length <= 40 &&
  /[A-Za-zÀ-ÿ]/.test(s) &&
  !/[º°:]/.test(s) &&          // 成绩行（1º / RATING:117）不是人名
  !/\d+m\d/.test(s) &&
  !/^(RATING|IND|PF|TOTAL|MEDIA)\b/i.test(s) &&
  !/^\d+\s+\d{2}\/\d{2}\/\d{2}/.test(s);

/**
 * PDF 文本 → 出场马匹数组
 * [{ num, horse, sire, dam, bms, breeder, sexRaw, sex, colorRaw, color, birth, state, jockey, weight, trainer, owner }]
 */
export function parsePrograma(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PED);
    if (!m) continue;
    const [, numRaw, horseInline, sire, dam, bms, breeder, sexRaw, colorRaw, birth, state] = m;
    // 马名：行内并上了就用它，否则向上找「{号} - 马名」头行
    let horse = horseInline?.trim() ?? null;
    let num = numRaw ? Number(numRaw) : null;
    if (!horse) {
      for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
        const h = lines[k].match(HDR);
        if (h && !WEIGHT.test(lines[k])) {
          horse = h[2].trim();
          num = num ?? (h[1] ? Number(h[1]) : null);
          break;
        }
      }
    }
    // 骑手 / 负磅 / 练马师 / 马主：从血统行往下找负磅行，前后各取一行
    let weightIdx = -1;
    for (let k = i + 1; k <= Math.min(lines.length - 1, i + 4); k++) {
      if (WEIGHT.test(lines[k])) {
        weightIdx = k;
        break;
      }
    }
    const jockey = weightIdx > 0 ? lines[weightIdx - 1] ?? null : null;
    const trainer = weightIdx > 0 ? lines[weightIdx + 1] ?? null : null;
    const owner = weightIdx > 0 ? lines[weightIdx + 2] ?? null : null;
    const by = birth.match(/(\d{2})\/(\d{2})\/(\d{2})/);
    out.push({
      num,
      horse,
      sire: sire?.trim() ?? null,
      dam: dam?.trim() ?? null,
      bms: bms?.trim() ?? null,
      breeder: breeder?.trim() ?? null,
      sexRaw: sexRaw,
      sex: SEX_MAP[sexRaw] ?? null,
      colorRaw,
      color: COAT_MAP[colorRaw] ?? null,
      birth: by ? `${by[3].length === 2 ? "20" + by[3] : by[3]}-${by[2]}-${by[1]}` : null,
      birthRaw: birth,
      state,
      jockey: looksName(jockey) ? jockey : null,
      weight: weightIdx > 0 ? lines[weightIdx] : null,
      trainer: looksName(trainer) ? trainer : null,
      owner: looksName(owner) ? owner : null,
    });
  }
  return out;
}

/** 名字 → 条目（同名只保留第一条：一个赛日内马名唯一） */
export function byHorse(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!e.horse) continue;
    const k = e.horse
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’'`´]/g, "'")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!map.has(k)) map.set(k, e);
  }
  return map;
}

export const cacheDir = CACHE;
export { CACHE };
