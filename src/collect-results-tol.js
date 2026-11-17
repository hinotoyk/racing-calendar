// TurfeOnline 赛果（巴西）采集：resultados 索引 → 单篇结果文章 → data/results/{date}/tol-{venue}.json
//
// ## 为什么需要它
// 巴西出馬表（src/sources/turfeonline.js）只发布赛前节目，**没有着顺**；
// 官方结果发布在同一站点的 `/resultados` 文章里，格式为（2026-11-17 实测，Gávea 16/11）：
//   1º   PÁREO – 1.400m – GP*:
//   1º USAK (R$ 3,40 – J.Aparecido – L.Esteves-CT – M.C.3a.RS – Alpha e Jenny Holzer por Cape Town – …),
//   2º Pigrone, 3º Fantasma Da Ópera, 4º Nice Movie Star, 5º Poderoso Chefão. T: 1m25s56s.
//   Ordem de Chegada: 6-5-1-7-4.
// 「Ordem de Chegada」= 按 **mandil（马牌号）** 排列的过线顺序，与出馬表 runner.num 同源，
// 所以对齐不靠马名、不靠闸位 —— 数字直接就是马号（USAK 为 6 号，首段括注也印证）。
// 也只发前 5 名（巴西惯列），故 finish 只落 1–5，其余留空（宁缺勿错）。
//
// ## 用法
//   node src/collect-results-tol.js --days 7            # 回补过去一周（默认）
//   node src/collect-results-tol.js --dates 2026-11-16  # 指定日
//   node src/collect-results-tol.js --dry               # 只打印不写盘
// 无本地出馬表卡片（data/races/{date}/tol-{venue}.json.gz）的场次直接跳过：
// 结果层按 raceKey|马号 与卡片 join，没卡片就没有 join 对象，落了也是死数据。
import fs from "node:fs";
import path from "node:path";
import { readGz } from "./lib/bundle.js";
import { fetchHtmlSoft, BROWSER_UA } from "./lib/fetch.js";

const BASE = "https://www.turfeonline.com.br";
const TZ = "America/Sao_Paulo";
const DATA_DIR = path.resolve("data", "races");
const RESULTS_DIR = path.resolve("data", "results");

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DRY = has("--dry");
const FORCE = has("--force");
const DAYS = parseInt(val("--days", "7"), 10);
const DELAY = parseInt(val("--delay", "1200"), 10);
const DATES = (val("--dates", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const PAGES = parseInt(val("--pages", "5"), 10); // 索引翻页上限（每页 20 篇）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");
const slugOf = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function todayInTz() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const targets = DATES.length
  ? new Set(DATES)
  : new Set(Array.from({ length: DAYS }, (_, i) => addDays(todayInTz(), -i)));

// ---------- 抓取 ----------
async function fetchTo(url, src) {
  return fetchHtmlSoft(url, { src, ua: BROWSER_UA, retries: 2 }).catch(() => null);
}

/** 结果索引页 → [{ url, venue, date }]（标题形如「Resultados Gávea (16/11/2026)」） */
export function parseResultIndex(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html ?? "").matchAll(/<a[^>]+href="([^"]*\/resultados\/\d+[^"]*)"[^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const url = m[1].startsWith("http") ? m[1] : BASE + m[1];
    const title = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const t = title.match(/^Resultados\s+(.+?)\s*\((\d{1,2})º?\/(\d{1,2})\/(\d{4})\)/i);
    if (!t || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, venue: t[1].trim(), date: `${t[4]}-${pad2(+t[3])}-${pad2(+t[2])}`, title });
  }
  return out;
}

/** 结果正文 → races[]（每场：场次号 / 冠军 / 前 5 名马名 / 过线顺序（马号）/ 用时） */
export function parseResults(html) {
  // 每场一个 <td>（正文用无表格样式排版，<td> 即场次块）；退化为按 <p> 切
  const blocks = String(html ?? "").match(/<td[\s\S]*?<\/td>/gi) ?? String(html ?? "").split(/<p[\s>]/i);
  const races = [];
  for (const raw of blocks) {
    const text = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const hdr = text.match(/(\d{1,2})º\s*PÁREO/i);
    if (!hdr) continue;
    const no = +hdr[1];

    // 前 5 名：1º NAME, 2º NAME, …
    const finishers = [];
    for (const m of text.matchAll(/(\d)º\s+([A-ZÀ-Ÿ][A-Za-zÀ-ÿ'´’`.\- ]{1,40}?)(?=[,.)]|\s*$|\s+T:)/g)) {
      const pos = +m[1];
      if (pos < 1 || pos > 5) continue;
      if (finishers.some((f) => f.pos === pos)) continue;
      finishers.push({ pos, name: m[2].trim() });
    }

    // 过线顺序 = 马号序列
    const ord = text.match(/Ordem de Chegada:\s*([\d\s\-–.]+)/i);
    const nums = ord ? (ord[1].match(/\d+/g) ?? []).map(Number).filter((n) => n > 0 && n < 30) : [];

    const timeM = text.match(/\bT:\s*([0-9mhs,.:]+)/i);
    const ncM = text.match(/N\/C:([^.]{0,120})/i);
    const ncNums = ncM ? (ncM[1].match(/\((\d{1,2})\)/g) ?? []).map((s) => +s.replace(/\D/g, "")) : [];

    if (!nums.length && !finishers.length) continue;
    races.push({ no, finishers, order: nums, time: timeM?.[1]?.replace(/[,\s]+$/, "") ?? null, nonRunners: ncNums });
  }
  return races;
}

function readDoc(base) {
  const gz = `${base}.gz`; // base 已含 .json（与 collect-sources 落盘口径一致）
  if (fs.existsSync(gz)) {
    try {
      return JSON.parse(readGz(gz));
    } catch {
      return null;
    }
  }
  if (fs.existsSync(base)) {
    try {
      return JSON.parse(fs.readFileSync(base, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

// ---------- 主流程 ----------
async function main() {
  // 1) 索引：翻页收集目标日期的结果文章
  const picked = new Map(); // `${date}|${venue}` → item
  for (let p = 0; p < PAGES; p++) {
    const url = p ? `${BASE}/resultados?start=${p * 20}` : `${BASE}/resultados`;
    const html = await fetchTo(url, "tol-res-index");
    await sleep(DELAY);
    if (!html) {
      console.log(`[index] 第 ${p + 1} 页抓取失败 → 停止翻页`);
      break;
    }
    const items = parseResultIndex(html);
    if (!items.length) break;
    let hit = 0;
    for (const it of items) {
      if (!targets.has(it.date)) continue;
      const k = `${it.date}|${it.venue}`;
      if (!picked.has(k)) {
        picked.set(k, it);
        hit++;
      }
    }
    console.log(`[index] 第 ${p + 1} 页 ${items.length} 篇，命中目标日 ${hit} 篇`);
    const oldest = items.at(-1)?.date;
    if (oldest && [...targets].every((d) => d > oldest)) break; // 已翻过最早目标日
  }
  if (!picked.size) {
    console.log(`[index] 目标日期（${[...targets].sort().join(",")}）无结果文章`);
    return;
  }

  // 2) 逐篇解析 → 落盘
  let written = 0;
  let skipped = 0;
  for (const it of [...picked.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const track = slugOf(it.venue);
    const cardBase = path.join(DATA_DIR, it.date, `tol-${track}.json`);
    const card = readDoc(cardBase);
    if (!card) {
      console.log(`[skip] ${it.date} ${it.venue} 无本地出馬表卡片 → 跳过`);
      skipped++;
      continue;
    }
    // 卡片场次索引：no → runner 马号集合（用于校验 Ordem de Chegada 确有对应马）
    const byNo = new Map((card.races ?? []).map((r) => [r.no, r]));

    const html = await fetchTo(it.url, "tol-result");
    await sleep(DELAY);
    if (!html) {
      console.log(`[race] ${it.date} ${it.venue} 结果页抓取失败 → 跳过`);
      continue;
    }
    const parsed = parseResults(html);
    if (!parsed.length) {
      console.log(`[race] ${it.date} ${it.venue} 解析 0 场（版式变更？）→ 跳过`);
      continue;
    }

    const races = [];
    let matched = 0;
    for (const p of parsed) {
      const cardRace = byNo.get(p.no);
      if (!cardRace) continue;
      const nums = new Set((cardRace.runners ?? []).map((x) => x.num));
      const runners = p.order
        .filter((n) => nums.has(n))
        .map((n, i) => ({
          num: n,
          finish: i + 1,
          // 过线序号 → 前 5 名的马名（顺序与 order 一致，源两侧同源可交叉校验）
          horse: { name: p.finishers.find((f) => f.pos === i + 1)?.name ?? cardRace.runners.find((x) => x.num === n)?.horse?.name ?? null },
          time: i === 0 ? p.time : null,
          margin: null,
          pop: null,
          winOdds: null,
          last3f: null,
          bodyWeight: null,
        }))
        .sort((a, b) => a.finish - b.finish);
      if (!runners.length) continue;
      matched += runners.length;
      races.push({
        no: p.no,
        raceKey: cardRace.raceKey,
        status: "result",
        heads: cardRace.heads ?? null,
        resultHeads: p.order.length,
        joined: runners.length,
        linked: runners.length,
        startTime: cardRace.startTime ?? null,
        sourceUrl: it.url,
        nonRunners: p.nonRunners.length ? p.nonRunners : undefined,
        runners,
      });
    }
    if (!races.length) {
      console.log(`[race] ${it.date} ${it.venue} 无法与卡片对齐（0 场）→ 跳过`);
      continue;
    }

    const doc = {
      schema: "jbis.race.result/v1",
      date: it.date,
      track,
      venue: it.venue,
      scope: "overseas",
      source: "turfeonline",
      sourceUrl: it.url,
      updatedAt: new Date().toISOString(),
      races,
    };
    const outFile = path.join(RESULTS_DIR, it.date, `tol-${track}.json`);
    if (DRY) {
      console.log(`[dry] ${it.date} ${it.venue} → ${races.length} 场 / 着顺 ${matched} 行`);
      continue;
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
    if (prev && !FORCE) {
      const before = prev.races?.reduce((n, r) => n + (r.runners?.length ?? 0), 0) ?? 0;
      if (before >= matched) {
        console.log(`[same] ${it.date} ${it.venue} 已有 ${before} 行着顺 ≥ 本次 ${matched} → 跳过`);
        skipped++;
        continue;
      }
    }
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 1));
    console.log(`[ok]   ${it.date} ${it.venue} → results/tol-${track}.json（${races.length} 场 / 着顺 ${matched} 行）`);
    written++;
  }
  console.log(`== 完成：写入 ${written} 篇 / 跳过 ${skipped} 篇（目标日 ${[...targets].sort().join(",")}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
