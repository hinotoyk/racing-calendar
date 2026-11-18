// Teletrak（teletrak.cl，智利四大赛场节目聚合）比赛源适配器（docs/DESIGN.md §8）
//
// ## 站点结构（2026-11-17 实测）
// - 首页 "Semana de carreras" 栏目：7 天块（LUN 16 … DOM 22），每块内若干「programa」卡
//   （赛场名 + Descargar programa PDF 链接）。PDF 链接三种来源：
//     CHS: static.clubhipico.cl/archivos/volantes/{DD-MM-YYYY}.pdf（日期可预测）
//     CHC/VSC/HCH: teletrak.cl/wp-content/uploads/{yyyy}/{mm}/{随机名}.pdf（须从页面解析）
// - PDF 文本经 src/lib/pdftext.py（PyMuPDF 子进程）提取；Python 环境可用性见 resolvePdfPython()。
//
// ## 三种 volante 版式（同一信息，列序不同 —— 2026-11 实测）
//   CHS（Club Hípico de Santiago，旧版）：场次头带「PREMIO: X.」「RETR: 4423.」「1ª / 12:30 / ARENA - 1.000 mts」，
//        runner 行：num / NAME - SIRE / 负磅 / 年龄 / 骑师(可带 "(ap) …" 减磅) / 练马师 / Ind / 3 段 LLEGADAS / …
//   CHC（Concepción 等，新版）：场次头「(HH:MM) Hrs. Premio : "X" … N metros.」，
//        runner 行：num / NAME (SIRE) / B/W 码 / Ed / kg Jockey / Preparador / Fecha / Llegó(4-3) / PF / Serie / Dist / Cpos / Tiempo / Div / Stud
//   VSC（Valparaíso）：场次头「13:30 aprox. 1.100 Mts. (4.441) Premio: X … HANDICAP 7a. Serie … Pista: ARENA」，
//        runner 行：num / NAME- SIRE / "kg gate" / "Ed Jockey - Trainer" / 3×llegada+fecha+dist / Serie / Cpos / Tiempo / "Div PF serie Stud"
// - volante 只给父系（Padrillo），**无母系** → dam/bms/sireSire 留空（宁缺勿错），
//   血统母系后续可借其他源按马名补。
//
// ## 时区
// America/Santiago（智利 DST 仍在：4–9 月 UTC-4，9–4 月 UTC-3，由 normalize 层消解）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";
import { instantFromZoned, isoInZone, sexFromConditionEs } from "./normalize.js";

export const id = "teletrak";
export const label = "Teletrak (Chile)";
export const homeUrl = "https://teletrak.cl/";

const BASE = "https://teletrak.cl";
const TZ = "America/Santiago";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAG = "tk";

// ---------- 文本工具 ----------
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
const norm = (s) => decodeEntities(String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
const num = (s) => {
  const m = String(s ?? "").replace(/\s/g, "").match(/\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
};

const SURFACE = { ARENA: "ダ", GRAMA: "芝", PASTO: "芝", CÉSPED: "芝", CESPED: "芝" };
const COLOUR = { A: "栗毛", Z: "青鹿毛", T: "芦毛", R: "駁毛", N: "青毛", C: "栗毛", B: "青鹿毛", W: null };
// Chilean llegadas「12°cn1」「6va」「4」→ 名次
function ranksOf(chs, chc, vsc) {
  const out = [];
  const push = (n) => {
    if (n != null && n >= 1) out.push({ rank: `${n}着` });
  };
  for (const t of String(chs ?? "").split(/\s+/)) {
    const m = t.match(/^\*?(\d{1,2})[º°]/);
    if (m) push(+m[1]);
  }
  for (const t of String(chc ?? "").split("-")) push(num(t));
  for (const t of String(vsc ?? "").split(/\s+/)) {
    const m = t.match(/^(\d{1,2})va$/);
    if (m) push(+m[1]);
  }
  return out;
}

// ---------- PDF → 文本（PyMuPDF 子进程） ----------
let pdfPython = null;
export function resolvePdfPython({ log = console.log } = {}) {
  if (pdfPython !== null) return pdfPython;
  // [cmd, preArgs…]：Windows 常见多版本共存，py 启动器可点版本号
  const candidates = [
    ...(process.env.PDF_PYTHON ? [[process.env.PDF_PYTHON]] : []),
    ["py", "-3"],
    ["python"],
    ["python3"],
  ];
  for (const [cmd, ...pre] of candidates) {
    try {
      const r = spawnSync(cmd, [...pre, "-c", "import fitz"], { timeout: 30000 });
      if (r.status === 0) {
        pdfPython = { cmd, pre };
        return pdfPython;
      }
    } catch {}
  }
  pdfPython = false;
  log(`[pdf] 未找到带 PyMuPDF 的 Python（可用环境变量 PDF_PYTHON 指定），PDF 解析不可用`);
  return false;
}

/** PDF Buffer → 文本（临时文件 + pdftext.py）；失败返回 null */
export async function pdfToText(buf, { log = console.log } = {}) {
  const py = resolvePdfPython({ log });
  if (!py) return null;
  const tmp = path.join(os.tmpdir(), `tk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    const r = spawnSync(py.cmd, [...py.pre, path.resolve("src/lib/pdftext.py"), tmp], { encoding: "utf8", timeout: 120000 });
    if (r.status !== 0 || !r.stdout) {
      log(`[pdf] 文本提取失败（exit=${r.status}${r.stderr ? `: ${String(r.stderr).slice(0, 120)}` : ""}）`);
      return null;
    }
    return r.stdout;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- 首页「Semana de carreras」解析 ----------
/** 首页 HTML → [{ date, trackKey, trackName, pdfUrl }] */
export function parseSemana(html, { today } = {}) {
  const text = String(html ?? "");
  const out = [];
  // 7 天块：day header 到下一个 day header 之间
  const days = [...text.matchAll(/(LUN|MAR|MIÉ|MIE|JUE|VIE|SÁB|SAB|DOM)<\/span>\s*<span class="dia-numero">(\d{1,2})/g)];
  for (let i = 0; i < days.length; i++) {
    const seg = text.slice(days[i].index, i + 1 < days.length ? days[i + 1].index : undefined);
    const dayNum = +days[i][2];
    // 日期 = 当前月份的 dayNum（周跨月：dayNum 远小于今天 → 下个月）
    const now = today ? new Date(today + "T12:00:00Z") : new Date();
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12));
    let date = null;
    for (const dm of [0, 1, -1]) {
      const cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + dm, dayNum, 12));
      const diff = Math.abs(cand - anchor) / 864e5;
      if (diff <= 20) {
        date = cand.toISOString().slice(0, 10);
        break;
      }
    }
    // 每张 program 卡：赛场名 + 紧随的 PDF 链接
    const cards = [...seg.matchAll(/<a[^>]+href="([^"]+\.pdf)"[^>]*>/gi)];
    for (const c of cards) {
      // 向前找最近的赛场名（logo alt/文字）
      const before = seg.slice(Math.max(0, c.index - 1500), c.index);
      const nameM = before.match(/(Club H[íi]pico de Santiago|Club H[íi]pico de Concepci[oó]n|Hip[oó]dromo Chile|Valpara[íi]so Sporting Club)/i);
      const trackName = nameM ? norm(nameM[1]) : null;
      out.push({ date, trackName, pdfUrl: c[1] });
    }
  }
  return out;
}

export const TRACK_KEYS = {
  "club hípico de santiago": { key: "chs", venue: "Club Hípico de Santiago" },
  "club hipico de santiago": { key: "chs", venue: "Club Hípico de Santiago" },
  "club hípico de concepción": { key: "chc", venue: "Club Hípico de Concepción" },
  "club hipico de concepcion": { key: "chc", venue: "Club Hípico de Concepción" },
  "hipódromo chile": { key: "hch", venue: "Hipódromo Chile" },
  "hipodromo chile": { key: "hch", venue: "Hipódromo Chile" },
  "valparaíso sporting club": { key: "vsc", venue: "Valparaíso Sporting Club" },
  "valparaiso sporting club": { key: "vsc", venue: "Valparaíso Sporting Club" },
};
export function trackKeyOf(name) {
  const k = norm(name ?? "").toLowerCase();
  return TRACK_KEYS[k] ?? null;
}

// ---------- volante 文本 → 场次切块 ----------
/** 按版式切块：返回 { format, races: [{ head, lines }] } */
export function splitVolante(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim());
  const t = String(text ?? "");
  const races = [];
  let format = null;
  // CHS：「1ª」独立行 + 「PREMIO:」行
  const chsHeads = [...t.matchAll(/^(\d{1,2})ª\s*$/gm)];
  // CHC/VSC：「(HH:MM) Hrs. Premio :」/「HH:MM aprox. … Premio:」
  const chcHeads = [...t.matchAll(/^\((\d{1,2}:\d{2})\) Hrs\. Premio\s*:/gm)];
  const vscHeads = [...t.matchAll(/^(\d{1,2}:\d{2}) aprox\./gm)];
  if (chcHeads.length) format = "chc";
  else if (vscHeads.length || /Pista:\s*(ARENA|GRAMA|PASTO)/i.test(t)) format = "vsc";
  else if (chsHeads.length >= 2) format = "chs";
  else return { format: null, races: [] };

  // 场次边界：VSC 用「Nª」行（每场独立行）优先于「HH:MM aprox.」（后者不一定每场都有）
  let heads, useNo;
  if (format === "chs") {
    heads = chsHeads;
    useNo = true;
  } else if (format === "chc") {
    heads = chcHeads;
    useNo = false;
  } else {
    if (vscHeads.length >= chsHeads.length) {
      heads = vscHeads;
      useNo = false;
    } else {
      heads = chsHeads;
      useNo = true;
    }
  }
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i].index;
    const to = i + 1 < heads.length ? heads[i + 1].index : t.length;
    races.push({ no: useNo ? +heads[i][1] : i + 1, headRaw: t.slice(from, to), chunk: t.slice(from, to).split("\n").map((l) => l.trim()) });
  }
  return { format, races };
}

// ---------- 三版式 runner 解析 ----------
/**
 * runner 切块通用法：块内行以「马号整数行」起始、下一马号（或块尾）结束；
 * 字段用正则在中段猎取，剩余原文存 tk.raw。
 */
export function parseVolanteChunk(chunk, format) {
  const lines = chunk;
  // runner 起始行两种形态（CHS 实测：1–9 号「号独占一行」，10 号起排版压成「10 GRAN KURU - Exaggerator」）：
  //   a) 纯数字行 → 下一行是「马名 - 父系」
  //   b) 「号 + 空格 + 马名…」同行 → 只认带父系分隔或括号的形态，避免误吃年龄/赔率等数字行
  const starts = [];
  const inline = new Set(); // 起始行本身即「号 + 马名」的行号
  let expect = 1; // 马号顺序计数器：块内散落的整数行（年龄/Cpos 等）不是起点
  // 马名行形态校验 —— 过滤「上一匹的数字行 + 彩衣行」被误认成下一匹起点
  // （2026-11-18 VSC 实测：赔率行「3」+ 彩衣行「481 33 Chino Emperador - Amar,estrells,rojo …」
  //   → 幽灵马，真 3 号 HOOTEROAD 反被吞掉）。
  // 注意只检查「父系段」不能含彩衣关键词/多逗号，且名字段不能以数字开头；
  // 马名本身可能出现彩衣词（真马 LABANDAVERDE 含 banda），不能对整行检查。
  // 另外拒绝人名缩写签名行（"N. Rojas - A. Norambuena"、"Jn.A. Campos"）——
  // 骑师行的行首数字若恰好等于马号计数器（expect），会被内联规则误认成
  // 「号 + 马名」起点（2026-11-18 VSC 1R 5号马 GIPSYVANNER 的骑师行「6 N. Rojas」实测踩坑）。
  const silkRe = /banda|gorra|mangas|estrell|lunares|brazal|celest/i;
  const nameOk = (l) => {
    const m = String(l).match(/^(.*?)\s*[-–]\s*(.+)$/);
    const namePart = m ? m[1] : String(l);
    const sirePart = m ? m[2] : "";
    if (!/^[A-ZÁÉÍÓÚÑ]/.test(namePart)) return false;
    if (namePart.includes(":")) return false; // 赛事注记行（"MISS MARIOLY: encajonado(a)…"），非马名
    // 人名（骑师/练马师）非马名：单字母缩写（"R. Perez"）与混写缩写（"Fdo. Moreno"、"Seb. Gonzalez"）——
    // 混写形态若不拒，年龄行「3」+「Fdo. Moreno (-4)…」会被误认成 3 号马起点
    // （2026-11-16 CHS 7R CINE WIKEN 实测踩坑）
    if (/^[A-ZÁÉÍÓÚÑ]{1,3}\.\s|^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*\.\s/.test(namePart)) return false;
    if (silkRe.test(sirePart) || (sirePart.match(/,/g) ?? []).length >= 2) return false;
    return true;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const same = l.match(/^(\d{1,2})\s+([^\d\s].*)$/);
    if (same && +same[1] === expect && +same[1] <= 20 && nameOk(same[2]) && (/\s[-–]\s|\([^)]+\)/.test(same[2]) || /^[A-ZÁÉÍÓÚÑ]{2,}/.test(same[2]))) {
      starts.push(i);
      inline.add(i);
      expect++;
      continue;
    }
    if (/^\d{1,2}$/.test(l) && +l === expect && +l <= 20) {
      // 起点行后的下一行必须是「马名 - 父系」形态（含 " - " 或父系括号）——
      // 排除「年龄行 + 骑师名行」这类同形态误配（CHS 实测踩坑）
      if (i + 1 < lines.length && nameOk(lines[i + 1]) && /\s[-–]\s|\([^)]+\)|-\s|[A-Za-z]\)/.test(lines[i + 1])) {
        starts.push(i);
        expect++;
      }
    }
  }
  const runners = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    if (inline.has(from)) {
      const m = lines[from].match(/^(\d{1,2})\s+(.*)$/);
      runners.push(parseRunner(m[1], [m[2], ...lines.slice(from + 1, to)], format));
    } else {
      runners.push(parseRunner(lines[from], lines.slice(from + 1, to), format));
    }
  }
  return runners;
}

function parseRunner(numLine, body, format) {
  const numVal = +numLine;
  const raw = body.join(" | ");
  // 马名 + 父系：CHS「KOLETTE - Exaggerator」CHC「ASTROAZURRO (Good Samaritan)」VSC「PRINCESATROYANA- Rydilluc」
  const first = body[0] ?? "";
  let name = null;
  let sire = null;
  let sireCountry = null;
  let preWeight = null; // 粘连行末尾的负磅（声明顺序先于 weight）
  let preAge = null; // 粘连行末尾的年龄（「Lookin At Lucky 56*** 3」）
  let rest = "";
  let m;
  if ((m = first.match(/^(.+?)\s*[-–]\s*(.+)$/))) {
    name = norm(m[1]);
    rest = norm(m[2]);
    // CHS 形态B变体（2026-11-16 实测）：「Lookin At Lucky 56*** 3」负磅+获胜星号+年龄整段粘尾
    const st = rest.match(/^(.*?)\s*(\d{2})\*+\s+(\d{1,2})$/);
    if (st) {
      sire = norm(st[1]);
      preWeight = +st[2];
      preAge = +st[3];
    } else {
    // 粘连行：「Mustaaqeem (aus)54」→ 父 Mustaaqeem / 国码 AUS / 末尾数字 = 负磅；
    // VSC 形态B（2026-11-18 实测）：「IMPERIO BABILONICO - Classic Empire (usa)  58 9」
    // —— 负磅+马号整段粘进马名行尾，只取前两位数字为负磅
    const sc = rest.match(/^(.*?)\s*\(([a-z]{2,3})\)\s*(\d{2}(?:\s+\d{1,2})?)?\s*$/i);
    if (sc) {
      sire = norm(sc[1]);
      sireCountry = sc[2].toUpperCase();
      if (sc[3]) preWeight = +String(sc[3]).split(/\s/)[0];
    } else {
      const wm = rest.match(/^(.*?)\s*(\d{2})(?:\s+\d{1,2})?\s*$/);
      if (wm && !sire) {
        sire = norm(wm[1]);
        preWeight = +wm[2];
      } else sire = rest || null;
    }
    }
  } else if ((m = first.match(/^(.+?)\s*\(([^)]+)\)\s*(\d{2})?\s*$/))) {
    // CHC「SUPER MARTINA** - Mustaaqeem (aus)54」可能整行合并 → 先按括号父系
    name = norm(m[1]);
    sire = norm(m[2]);
    sireCountry = null;
    rest = m[3] ?? "";
  } else {
    name = norm(first) || null;
  }
  name = name?.replace(/\*+$/, "").trim() || null;

  // 猎取字段
  const joined = body.join("\n");
  let weight = preWeight;
  let age = preAge;
  let jockey = null;
  let trainer = null;
  let colour = null;
  let formRaw = null;
  let stud = null;

  if (format === "chs") {
    // 行序（负磅粘连进马名行时前移）：负磅 / 年龄 / 骑师 / 练马师（可能「(ap) Jn. C. Silva S.」形态）/ Ind / llegadas…
    const lines2 = body.map((l) => l.trim()).filter(Boolean);
    const isName = (l) => /^[A-ZÁÉÍÓÚÑ](?:[a-záéíóúñ]*[A-ZÁÉÍÓÚÑ]?\.){1,2}\s/.test(l) || /^\(ap\)\s*[A-ZÁÉÍÓÚÑ]/.test(l);
    const cleanName = (n) => norm(String(n ?? "").replace(/^\(ap\)\s*/, "").replace(/\s+\d+$/, ""));
    if (weight == null) {
      const wl = lines2.find((l) => /^\d{2}$/.test(l));
      if (wl) weight = +wl;
    }
    if (age == null) {
      // 年龄与骑师同行（"10 R. S. Dores"，下一行是练马师人名行）→ 拆开取出，
      // 并把这两行从候选中移除，避免 names 重复吃（2026-11-16 CHS GRIEZMANN 实测）
      const aj = lines2.findIndex((l, i) => /^\d{1,2}\s+[A-ZÁÉÍÓÚÑ].+$/.test(l) && isName(lines2[i + 1] ?? "") && (() => { const mm = l.match(/^(\d{1,2})\s/); return mm && +mm[1] <= 14; })());
      if (aj >= 0) {
        const mm = lines2[aj].match(/^(\d{1,2})\s+(.+)$/);
        age = +mm[1];
        jockey = norm(mm[2]);
        trainer = isName(lines2[aj + 1] ?? "") ? cleanName(lines2[aj + 1]) : null;
        lines2.splice(aj, 2);
      }
    }
    if (age == null) {
      // 负磅行带获胜星号且年龄粘尾（"56*** 3"）→ 负磅+年龄同行
      const star = lines2.find((l) => /^(\d{2})\*+\s+(\d{1,2})$/.test(l));
      if (star) {
        const sm = star.match(/^(\d{2})\*+\s+(\d{1,2})$/);
        if (weight == null) weight = +sm[1];
        age = +sm[2];
      } else {
        const wi = lines2.findIndex((l) => /^\d{2}$/.test(l));
        if (wi >= 0 && /^\d{1,2}$/.test(lines2[wi + 1] ?? "")) age = +lines2[wi + 1];
        else {
          // 负磅粘连进马名行（"(aus)54"）时没有独立负磅行 → 年龄是紧随其后的
          // 独立 1-2 位数字行（≤14，且下一行是人名行）（2026-11-16 CHS 实测 26 頭踩坑）
          const ai = lines2.findIndex((l, i) => /^\d{1,2}$/.test(l) && +l <= 14 && isName(lines2[i + 1] ?? ""));
          if (ai >= 0) age = +lines2[ai];
        }
      }
    }
    // 骑师/练马师：按出现次序取前两个「人名行」（缩写. 开头；练马师可能带 (ap) 前缀）
    // 人名签名兼容缩写连写（"L.G. Soto"）与短码（"Jn.A. Campos"）
    const names = lines2.filter((l) => isName(l) && !/°|cn\d|vn\d|cb\d/.test(l)).slice(0, 2);
    jockey = jockey ?? (names[0] ? cleanName(names[0]) : null);
    trainer = trainer ?? (names[1] ? cleanName(names[1]) : null);
    // 骑师带让磅标注且练马师同行（"Fdo. Moreno (-4) Js. Inda De La C."）→ 在 (-N) 处拆分
    if (!trainer) {
      const cm = String(jockey ?? "").match(/^(.*?)\s*\(-\d+\)\s+(.+)$/);
      if (cm) {
        jockey = norm(cm[1].replace(/\(-\d+\)\s*$/, "").trim());
        trainer = norm(cm[2]);
      } else if (/\(-\d+\)/.test(jockey ?? "")) {
        jockey = norm(String(jockey).replace(/\(-\d+\)\s*$/, "").trim());
      }
    }
    formRaw = (joined.match(/(\d{1,2}°(?:cn|vn|cb)\d\s*){2,}/) ?? [null])[0]?.trim() ?? null;
    // stud 行：PF 数字 + STUD - COLORES（行尾）
    const studM = joined.match(/\d{3}\s+([A-ZÁÉÍÓÚÑ][^\n|]*?)\s*-\s*[A-ZÁÉÍÓÚÑ]/);
    stud = studM ? norm(studM[1]) : null;
  } else if (format === "chc") {
    // 行序（标准）：num / NAME (SIRE) / B(W 码) / Ed / 「kg Jockey」 / Preparador / Fecha / Llegó(4-3) / PF / Serie / Dist / Cpos / Tiempo / Div / Stud
    // 毛色码行经常整行缺席（2026-11-17 实测 SONRIELE / LA RECAUDADORA / EL CATIMBA 等都没有），
    // Ed 位置随之漂移 → 旧的固定 body[2]=Ed 全体错位（年龄缺 66%）。
    // 改扫描式：以「kg Jockey」行为锚，向前回溯最近的纯数字行 = 年龄，再前一位单字母 = 毛色。
    const linesC = body.map((l) => l.trim()).filter(Boolean);
    const wi = linesC.findIndex((l) => /^\d{2}\s+[A-ZÁÉÍÓÚÑ]/.test(l));
    if (wi >= 0) {
      const wjm = linesC[wi].match(/^(\d{2})\s+(.+)$/);
      if (wjm) {
        weight = +wjm[1];
        jockey = norm(wjm[2]);
      }
      for (let i = wi - 1; i >= Math.max(0, wi - 3); i--) {
        if (/^\d{1,2}$/.test(linesC[i])) {
          age = +linesC[i];
          const cm = (linesC[i - 1] ?? "").match(/^([AZTRNCBW])$/);
          if (cm && i - 1 >= 0) colour = cm[1];
          break;
        }
      }
    }
    // 人名行签名兼容缩写连写（"L.G. Soto"）；排除 kg 行（^\d{2}\s）与骑师重复
    const isPerson = (l) => /^[A-ZÁÉÍÓÚÑ](?:[a-záéíóúñ]*[A-ZÁÉÍÓÚÑ]?\.){1,2}\s/.test(l);
    trainer = body.find((l) => isPerson(l) && !/^\d{2}\s/.test(l) && l !== jockey) ?? null;
    formRaw = (joined.match(/\b(\d{1,2}-\d{1,2}(?:-\d{1,2})?|REAP\.)\b/) ?? [null])[0] ?? null;
    stud = body.filter(Boolean).at(-1) ?? null;
  } else {
    // VSC 行序（标准）：body[0]=NAME- SIRE / body[1]=「kg num」/ body[2]=「Ed Jockey - Trainer」/ llegadas…
    // 但 PDF 抽文常把行合并（2026-11-18 实测三种形态），固定 body[1]/body[2] 一错全丢：
    //   形态A：「kg num Ed Jockey - Trainer」压成一行（"58 10 4 R. Fournet - J. Araya"）
    //   形态B：「kg num」粘进马名行尾（已在上面的 first 处理里剥为 preWeight）
    //   形态C：上一匹数字行+彩衣行误认起点（parseVolanteChunk 已过滤幽灵马）
    // → 全部改扫描式：在 body 内逐行猎取，不再依赖固定位置。
    const linesV = body.map((l) => l.trim()).filter(Boolean);
    // 形态D（整行全合并）：「NAME- SIRE (c) kg num Ed Jockey - Trainer」压进一行
    // （2026-11-18 VSC 2R 实测 "VERDURITAFRESCA- Modernist (usa)   57 12 3 F. Tapia - B. Toledo"）。
    // first 处理会把父系解析成带数字尾巴的垃圾 → 这里整体重推。
    const d = (body[0] ?? "").match(
      /^(.+?)\s*[-–]\s*(.+?)\s*(?:\(([a-z]{2,3})\))?\s*(\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+([A-ZÁÉÍÓÚÑ].*?)\s*[-–]\s*(.+)$/i
    );
    if (d) {
      name = norm(d[1]).replace(/\*+$/, "").trim() || name;
      sire = norm(d[2]) || sire;
      sireCountry = d[3] ? d[3].toUpperCase() : sireCountry;
      weight = +d[4];
      age = +d[6];
      jockey = norm(d[7]);
      trainer = norm(d[8]);
    }
    for (const l of linesV) {
      // 形态A：kg num age jockey - trainer（age ≤ 14 防误吃）
      const a = l.match(/^(\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+(.+?)\s*[-–]\s*(.+)$/);
      if (a && +a[3] <= 14) {
        if (weight == null) weight = +a[1];
        if (age == null) age = +a[3];
        if (jockey == null) jockey = norm(a[4]);
        if (trainer == null) trainer = norm(a[5]);
        break;
      }
      // 标准：「Ed Jockey - Trainer」（Ed ≤ 14；3 位数字的彩衣行/马体重行天然不匹配）；
      // 负磅与骑师名之间可无空格（"12D. Carvacho - R. Olivares"，PDF 抽文粘连）
      const t = l.match(/^(\d{1,2})\s*([A-ZÁÉÍÓÚÑ].*?)\s*[-–]\s*(.+)$/);
      if (t && +t[1] <= 14) {
        if (age == null) age = +t[1];
        if (jockey == null) jockey = norm(t[2]);
        if (trainer == null) trainer = norm(t[3]);
        break;
      }
    }
    if (weight == null) {
      // 「58 1」独立行 / 形态A行首「58 10 …」；3 位数字行（彩衣 454 7 …）天然不匹配
      const wl = linesV.find((l) => /^(\d{2})\s+\d{1,2}(?:\s|$)/.test(l));
      if (wl) weight = +wl.match(/^(\d{2})/)[1];
    }
    formRaw = (body.join(" ").match(/(\d{1,2}va\s+){2,}/) ?? [null])[0]?.trim() ?? null;
    stud = body.filter(Boolean).at(-1) ?? null;
  }

  return {
    num: numVal,
    frame: null, // 智利 mandil 是马牌号，不是日本枠番（枠只在 JRA/NAR 存在）
    horse: { id: null, name },
    sex: null,
    age: age,
    color: null, // 智利毛色码在 volante 里非每场齐全 → raw 留 tk
    jockey: { id: null, name: jockey },
    weight: weight,
    weightRaw: weight != null ? String(weight) : null,
    weightOver: null,
    trainer: { id: null, name: trainer },
    owner: null,
    breeder: null,
    sire: sire ? { id: null, name: sire, country: sireCountry } : null,
    dam: null, // volante 无母系
    bms: null,
    sireSire: null,
    recent: ranksOf(format === "chs" ? formRaw : null, format === "chc" ? formRaw : null, format === "vsc" ? formRaw : null),
    silk: null,
    tk: { format, raw: raw.slice(0, 500), formRaw, stud, colour },
  };
}

// ---------- 场次头解析 ----------
export function parseVolanteRaceHead(race, format) {
  const head = race.chunk.slice(0, 30).join("\n");
  let time = null;
  let distance = null;
  let surface = null;
  let name = null;
  let purse = null;
  if (format === "chs") {
    time = (head.match(/\b(\d{1,2}:\d{2})\b/) ?? [])[1] ?? null;
    const dm = head.match(/(ARENA|GRAMA|PASTO)\s*-\s*([\d.]+)\s*mts/i);
    if (dm) {
      surface = dm[1].toUpperCase();
      distance = +dm[2].replace(/\./g, ""); // 千分位 1.000 → 1000
    }
    name = norm(head.match(/^PREMIO:\s*(.+)$/m)?.[1] ?? "") || null;
    purse = num(head.match(/BOLSA DE PREMIOS: 1° \$(\d[\d.,]*)/)?.[1] ?? null);
  } else if (format === "chc") {
    time = (head.match(/\((\d{1,2}:\d{2})\)\s*Hrs/) ?? [])[1] ?? null;
    const prem = head.match(/Premio\s*:\s*"([^"]+)"/i);
    name = prem ? norm(prem[1]) : null;
    distance = num(head.match(/(\d{3,4})\s*metros/i)?.[1] ?? null);
    purse = num(head.match(/\$\s?([\d.]+)\s+al 1°/)?.[1] ?? null);
  } else {
    time = (head.match(/^(\d{1,2}:\d{2})\s*aprox/) ?? [])[1] ?? null;
    const vm = head.match(/([\d.]{5,7}|\d{3,4})\s*Mts/i);
    distance = vm ? +vm[1].replace(/\./g, "") : null; // 1.100 → 1100
    name = norm(head.match(/Premio:\s*([A-ZÁÉÍÓÚÑ][^$]*?)\s*\$/)?.[1] ?? "") || null;
    surface = (head.match(/Pista:\s*(ARENA|GRAMA|PASTO)/i)?.[1] ?? "").toUpperCase() || null;
    purse = num(head.match(/\$(\d[\d.]*)\s*al 1ro/i)?.[1] ?? null);
  }
  return { time, distance, surface, name, purse };
}

/** 单场 volante → canonical race（不含外壳） */
export function buildRace(race, format, dateIso, tz) {
  const head = parseVolanteRaceHead(race, format);
  const runners = parseVolanteChunk(race.chunk, format);
  const hhmm = head.time?.match(/(\d{1,2}):(\d{2})/);
  const [y, m, d] = dateIso.split("-").map(Number);
  const inst = hhmm ? new Date(instantFromZoned(y, m, d, +hhmm[1], +hhmm[2], tz)) : null;
  const graded = head.name?.match(/\bG\s*([123])\b/i);
  return {
    no: race.no,
    startTime: hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null,
    startTimeTz: tz,
    startTimeInstant: inst ? isoInZone(inst, tz) : null,
    startTimeLocal: hhmm ? `${String(+hhmm[1]).padStart(2, "0")}:${hhmm[2]}` : null,
    name: head.name,
    surface: head.surface ? SURFACE[head.surface] ?? null : null,
    distance: head.distance,
    distanceRaw: head.distance ? `${head.distance} mts` : null,
    heads: runners.length,
    klass: graded ? `G${"ⅠⅡⅢ"[+graded[1] - 1]}` : head.name && /HANDICAP/i.test(head.name) ? "Handicap" : "一般",
    klassGroup: graded ? "重賞" : "一般",
    gradeTag: graded ? `G${"ⅠⅡⅢ"[+graded[1] - 1]}` : null,
    raceClass: null,
    raceType: "FLAT",
    raceKey: race.headRaw.slice(0, 60) || null,
    status: runners.length ? "entries" : "pending",
    // volante 不逐马标性别；场次头条件文本（Para caballos/yeguas/potros…）限定单性组时推断
    runners: runners.map((x) => (x.sex ? x : { ...x, sex: sexFromConditionEs(race.headRaw) })),
    tk: { format, purse: head.purse, headRaw: race.headRaw.slice(0, 300) },
  };
}

// ---------- 采集 ----------
const todayInTz = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/**
 * @param {object} o
 * @param {string[]} o.dates  比赛日（YYYY-MM-DD，智利当地）；缺省 = 今天 + 明天
 * @param {string[]} o.tracks 场地过滤（chs/chc/hch/vsc / 赛场名，小写比对）
 * @returns [{ date, file, doc }]
 */
export async function collect({ dates = null, tracks = null, limit = 0, delayMs = 1500, pedigree = false, log = console.log } = {}) {
  const days = new Set(dates?.length ? dates : [todayInTz()]);
  const html = await fetchHtmlSoft(BASE, { src: "tk-home", ua: BROWSER_UA }).catch(() => null);
  if (!html) {
    log(`[index] 首页抓取失败`);
    return [];
  }
  const cards = parseSemana(html, { today: todayInTz() }).map((c) => {
    const tk = trackKeyOf(c.trackName);
    return { ...c, key: tk?.key ?? null, venue: tk?.venue ?? c.trackName };
  });
  const picked = cards.filter((c) => c.date && days.has(c.date) && (!tracks || tracks.some((t) => t === c.key || norm(t).toLowerCase() === norm(c.trackName ?? "").toLowerCase())));
  log(`[index] Semana 卡片 ${cards.length} 张 → 命中目标日期 ${picked.length} 张（${picked.map((c) => `${c.date}:${c.key}`).join(", ") || "-"})`);

  const out = [];
  let fetched = 0;
  for (const card of picked) {
    if (limit && fetched >= limit) break;
    if (!card.key) {
      log(`[race] ${card.date} 未知赛场「${card.trackName}」→ 跳过`);
      continue;
    }
    // PDF 下载（fetchHtmlSoft 只给文本 → 用 fetch buffer）
    const buf = await fetchBufferSoft(card.pdfUrl);
    if (!buf) {
      log(`[race] ${card.date} ${card.venue} PDF 下载失败 → 跳过`);
      continue;
    }
    const text = await pdfToText(buf, { log });
    await sleep(delayMs);
    if (!text) {
      log(`[race] ${card.date} ${card.venue} PDF 文本提取失败 → 跳过`);
      continue;
    }
    if (/CARRERAS INTERNACIONALES/i.test(text)) {
      log(`[race] ${card.date} ${card.venue} 国际转播赛（simulcast）→ 跳过`);
      continue;
    }
    fetched++;
    const { format, races: chunks } = splitVolante(text);
    if (!format) {
      log(`[race] ${card.date} ${card.venue} 无法识别 volante 版式 → 跳过`);
      continue;
    }
    // raceKey 必须场次级且带场地：volante 的场次头原文（含换行/PREMIO）做键会让前端分页与
    // 结果 join 全部错位；统一 `tk-{track}-{no}`，与 tol-/laplata- 命名口径一致。
    const races = chunks.map((r) => ({ ...buildRace(r, format, card.date, TZ), raceKey: `${TAG}-${card.key}-${r.no}` }));
    const heads = races.reduce((n, r) => n + r.heads, 0);
    const doc = {
      schema: "race.card/v2",
      source: "teletrak",
      fetchLayer: "teletrak.cl",
      sourceKey: `teletrak:${card.key}`,
      date: card.date,
      track: card.key,
      trackId: null,
      venue: card.venue,
      country: "CHI",
      countryLong: "Chile",
      scope: "overseas",
      timeZone: TZ,
      localTimeZone: TZ,
      going: null,
      surfaceRaw: null,
      sourceUrl: card.pdfUrl,
      capturedAt: new Date().toISOString(),
      races,
      teletrak: { format, pdfUrl: card.pdfUrl },
    };
    log(`[race] ${card.date} ${card.venue} ${races.length} R / ${heads} 頭 / format=${format}`);
    out.push({ date: card.date, file: `${TAG}-${card.key}.json`, doc });
  }
  return out;
}

async function fetchBufferSoft(url, { retries = 2 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/pdf,*/*" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const ab = await res.arrayBuffer();
      if (ab.byteLength < 1000) throw new Error("short pdf");
      return Buffer.from(ab);
    } catch (e) {
      if (i === retries) {
        console.warn(`[pdf] ${url} → ${e.message}`);
        return null;
      }
      await sleep(2000);
    }
  }
  return null;
}

export async function probe() {
  const html = await fetchHtmlSoft(BASE, { src: "tk-probe", ua: BROWSER_UA }).catch(() => null);
  const cards = html ? parseSemana(html, { today: todayInTz() }) : [];
  return {
    home: { ok: Boolean(html), cards: cards.length },
    pdfPython: resolvePdfPython({ log: () => {} }) || null,
    tracks: [...new Set(cards.map((c) => c.trackName).filter(Boolean))],
  };
}
