// TurfeOnline 结果页解析 → 冠军段的「练马师 / 马主 / 繁育者 / 血统」回填
//
// 为什么需要：TurfeOnline 的节目（programas）页只有「马号/马名/骑手/负磅/闸位」，
// 但结果（resultados）页每场冠军后面括注了完整履历：
//
//   1º USAK (R$ 3,40 – J.Aparecido – L.Esteves-CT – M.C.3a.RS – Alpha e Jenny Holzer por Cape Town
//            – Criação e Propriedade: Stud Red Rafa), 2º Pigrone, 3º …
//
//   解析口径：{奖金} – {骑手} – {练马师}(-CT 表示寄养在马房) – {性别}.{毛色}.{年龄}a.{州}
//             – {父} e {母} por {母父} – Criação[: X] [e Propriedade: Y]
//
// 覆盖只有「每场冠军 1 匹」——真正的全场血统/练马师走 ABCPCC + JCB PDF（backfill-bra-ped /
// enrich-jcb）。本脚本负责：①非 Gávea 场次（无官方 PDF）的冠军练马师；②结果页与节目页的交叉校验。
//
// 用法：node src/backfill-bra-results.js [--date 2026-11-16] [--dry]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { BROWSER_UA } from "./lib/fetch.js";

const BASE = "https://www.turfeonline.com.br";
const RACES = path.resolve("data", "races");
const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const val = (k, d = null) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const DRY = has("dry");
const ONLY_DATE = val("date");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
    } catch {}
    await sleep(1500 * (i + 1));
  }
  return null;
}

const decode = (s) =>
  String(s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú")
    .replace(/&atilde;/g, "ã")
    .replace(/&otilde;/g, "õ")
    .replace(/&ccedil;/g, "ç")
    .replace(/&ecirc;/g, "ê")
    .replace(/&ocirc;/g, "ô")
    .replace(/&agrave;/g, "à");

/** HTML → 单行纯文本（结果页是 Word 粘出来的满屏 inline style，只能压成一行再正则） */
export function flatten(html) {
  return decode(
    String(html ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

// 冠军括注：… 1º USAK (R$ 3,40 – J.Aparecido – L.Esteves-CT – M.C.3a.RS – Alpha e Jenny Holzer por Cape Town – Criação e Propriedade: Stud Red Rafa)
const WIN =
  /(\d{1,2})º\s+PÁREO[\s\S]{0,400}?1º\s+([A-ZÀ-Ý0-9'´’ .\-]+?)\s*\(R\$\s*[\d.,]+\s*[–-]\s*(.+?)\s*[–-]\s*(.+?)\s*[–-]\s*([MFC])\.([A-Z])\.(\d+)a\.([A-Z]{2})\s*[–-]\s*(.+?)\s+e\s+(.+?)\s+por\s+(.+?)\s*[–-]\s*Criação[^:]*:\s*(.+?)(?:\s*[–-]\s*Propriedade:\s*(.+?))?\)/g;

/** 结果页 HTML → [{ raceNo, horse, jockey, trainer, sexRaw, coatRaw, age, state, sire, dam, bms, breeder, owner }] */
export function parseResults(html) {
  const text = flatten(html);
  const out = [];
  for (const m of text.matchAll(WIN)) {
    const [, raceNo, horse, jockey, trainer, sexRaw, coatRaw, age, state, sire, dam, bms, breeder, owner] = m;
    out.push({
      raceNo: Number(raceNo),
      horse: horse.trim(),
      jockey: jockey.replace(/\s*[–-]\s*$/, "").trim(),
      // 骑手名可能带州码（A.Domingos-PR）会把分隔线吃掉，导致练马师列前移一格 → 这里还原
      trainer: trainer
        .replace(/\s*[–-]\s*$/, "")
        .replace(/^[A-Z]{2}\s*[–-]\s*/, "")
        .replace(/-(CT|SP|RJ|RS|PR|MG|BA|PE|GO|DF)$/i, "") // 寄养马房/州标记，不属姓名
        .trim(),
      sexRaw,
      sex: { M: "牡", F: "牝", C: "騸" }[sexRaw] ?? null,
      coatRaw,
      age: Number(age),
      state,
      sire: sire.replace(/\s*[–-]\s*$/, "").trim(),
      dam: dam.replace(/\s*[–-]\s*$/, "").trim(),
      bms: bms.replace(/\s*[–-]\s*$/, "").trim(),
      breeder: breeder.replace(/\s*[–-]\s*$/, "").trim(),
      owner: (owner ?? breeder).replace(/\s*[–-]\s*$/, "").trim(),
    });
  }
  return out;
}

/** 结果页索引 → [{ url, venue, date }] */
export function parseIndex(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/href="(\/resultados\/[^"]+)"[^>]*>([\s\S]{0,80}?)<\/a>/gi)) {
    const title = decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const t = title.match(/Resultados\s+(.+?)\s*\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/i);
    if (!t) continue;
    out.push({ url: BASE + m[1], venue: t[1].trim(), date: `${t[4]}-${t[3].padStart(2, "0")}-${t[2].padStart(2, "0")}` });
  }
  return [...new Map(out.map((x) => [x.url, x])).values()];
}

// ---------- 回填 ----------
const key = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`´]/g, "'")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

function patchDoc(doc, winners) {
  const stat = { matched: 0, trainer: 0, owner: 0, breeder: 0, sire: 0, dam: 0, bms: 0, sex: 0 };
  let changed = 0;
  const empty = (v) => v == null || v === "" || (typeof v === "object" && (v.name == null || v.name === ""));
  for (const race of doc.races ?? []) {
    const w = winners.get(race.no) ?? winners.get(String(race.no));
    if (!w) continue;
    for (const r of race.runners ?? []) {
      if (key(r.horse?.name) !== key(w.horse)) continue;
      stat.matched++;
      let touched = false;
      const set = (k, v, c) => {
        if (v == null || v === "" || !empty(r[k])) return;
        r[k] = v;
        stat[c]++;
        touched = true;
      };
      set("trainer", { id: null, name: w.trainer }, "trainer");
      set("owner", { id: null, name: w.owner }, "owner");
      set("breeder", { id: null, name: w.breeder }, "breeder");
      set("sire", { id: null, name: w.sire, country: null }, "sire");
      set("dam", { id: null, name: w.dam }, "dam");
      set("bms", { id: null, name: w.bms }, "bms");
      set("sex", w.sex, "sex");
      if (touched) {
        (r.tol ??= {}).resultSource = "turfeonline-resultados";
        changed++;
      }
    }
  }
  return { changed, ...stat };
}

async function main() {
  const idxHtml = await fetchText(`${BASE}/resultados`);
  if (!idxHtml) {
    console.log("[backfill-bra-results] 结果页索引抓取失败");
    return;
  }
  const pages = parseIndex(idxHtml).filter((p) => !ONLY_DATE || p.date === ONLY_DATE);
  console.log(`[backfill-bra-results] 结果页 ${pages.length} 个（${pages.slice(0, 4).map((p) => `${p.venue} ${p.date}`).join(" / ")}${pages.length > 4 ? " …" : ""}）`);

  const totals = { files: 0, changed: 0, trainer: 0, owner: 0, breeder: 0, sire: 0, dam: 0, bms: 0, sex: 0 };
  for (const p of pages) {
    const dir = path.join(RACES, p.date);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz") && /^tol-/.test(f));
    if (!files.length) continue;
    const html = await fetchText(p.url);
    if (!html) {
      console.log(`${p.date} ${p.venue}: 结果页抓取失败`);
      continue;
    }
    const winners = new Map(parseResults(html).map((w) => [w.raceNo, w]));
    if (!winners.size) {
      console.log(`${p.date} ${p.venue}: 未解析出冠军段（版式变化？）`);
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
      if (!new RegExp(p.venue.split(" ")[0], "i").test(`${doc.venue}`)) continue;
      const stat = patchDoc(doc, winners);
      if (!stat.changed) continue;
      if (!DRY) fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 }));
      totals.files++;
      totals.changed += stat.changed;
      for (const k of ["trainer", "owner", "breeder", "sire", "dam", "bms", "sex"]) totals[k] += stat[k] ?? 0;
      console.log(
        `${p.date}/${f}: 冠军命中 ${stat.matched}/${winners.size}｜练马师 +${stat.trainer} 马主 +${stat.owner} 繁育者 +${stat.breeder} 血统 +${stat.sire}/${stat.dam}/${stat.bms}`
      );
    }
  }
  console.log(
    `\n[backfill-bra-results] ${DRY ? "（dry-run）" : ""}改动 ${totals.files} 文件 / ${totals.changed} 行：` +
      `练马师 +${totals.trainer} · 马主 +${totals.owner} · 繁育者 +${totals.breeder} · 父 +${totals.sire} 母 +${totals.dam} 母父 +${totals.bms}`
  );
}

// 允许作为库被其它脚本 import（不触发主流程）
if (!process.env.TOL_LIB_ONLY) main();
