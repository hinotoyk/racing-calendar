// 重建单日智利卡片（Teletrak volante）：绕过首页「本周节目」轮换，直接从 PDF 重解
//
// ## 为什么
// teletrak.collect() 只按首页当周的 programa 卡列表抓 —— 一旦跨周（或当天 PDF 被 403），
// 历史日就无法「重collect」。而 raceKey / runner 解析规则修订后，历史卡片需要按新规则重解，
// 否则结果层 join 不上（raceKey 变了）或出馬数被旧解析截断。
//
// ## 用法
//   node src/rebuild-tk-card.js --date 2026-11-16 --track chs      # PDF 走卡片里记的 sourceUrl
//   node src/rebuild-tk-card.js --date 2026-11-16 --track chs --pdf https://…/16-11-2026.pdf
//   node src/rebuild-tk-card.js --date 2026-11-16 --track chs --pdf .workbuddy/tmp/volante.pdf  # 本地 PDF（0 网络请求）
//   …可再加 --source-url <官方节目页/PDF 地址>：本地 PDF 重建时 sourceUrl 不再被写成 tmp 路径，
//     否则 build.js 兜底会把该相对路径带进前端 raceUrl → 点击跳到 127.0.0.1 临时文件。
//   node src/rebuild-tk-card.js --date 2026-11-16 --track chs --dry
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { BROWSER_UA } from "./lib/fetch.js";
import { buildRace, pdfToText, splitVolante } from "./sources/teletrak.js";

const TZ = "America/Santiago";
const DATA_DIR = path.resolve("data", "races");

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DATE = val("--date");
const TRACK = (val("--track", "chs") ?? "chs").toLowerCase();
const DRY = has("--dry");
const FORCE = has("--force");

const VENUE = {
  chs: "Club Hípico de Santiago",
  chc: "Club Hípico de Concepción",
  hch: "Hipódromo Chile",
  vsc: "Valparaíso Sporting Club",
};

if (!DATE) {
  console.error("用法: node src/rebuild-tk-card.js --date YYYY-MM-DD [--track chs] [--pdf URL] [--source-url 官方URL] [--dry]");
  process.exit(1);
}

const [dd, mm, yyyy] = [DATE.slice(8, 10), DATE.slice(5, 7), DATE.slice(0, 4)];
const defaultPdf = `https://static.clubhipico.cl/archivos/volantes/${dd}-${mm}-${yyyy}.pdf`;

function readCard() {
  const base = path.join(DATA_DIR, DATE, `tk-${TRACK}`);
  for (const p of [`${base}.json.gz`, `${base}.json`]) {
    if (!fs.existsSync(p)) continue;
    const raw = p.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(p)) : fs.readFileSync(p);
    return { doc: JSON.parse(String(raw)), file: p };
  }
  return null;
}

async function fetchPdf(url) {
  // 本地路径直接读文件（离线重解 / PDF 已提前下载的场景，0 网络请求）
  if (!/^https?:/.test(url)) {
    if (fs.existsSync(url)) return fs.readFileSync(url);
    console.warn(`[pdf] 本地文件不存在: ${url}`);
    return null;
  }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/pdf,*/*" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const ab = await res.arrayBuffer();
      if (ab.byteLength < 1000) throw new Error("short pdf");
      return Buffer.from(ab);
    } catch (e) {
      if (i === 2) {
        console.warn(`[pdf] ${url} → ${e.message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

async function main() {
  const prev = readCard();
  // sourceUrl 必须是可公开访问的官方地址（前端 raceUrl 兜底直接用它）；本地 tmp 路径
  // 会被 build.js 原样带进前端链接 → 点击跳 127.0.0.1。--source-url 显式覆盖。
  const sourceUrlArg = val("--source-url");
  const pdfUrl = val("--pdf") ?? prev?.doc?.sourceUrl ?? defaultPdf;
  const sourceUrl = sourceUrlArg ?? (/^https?:/.test(pdfUrl) ? pdfUrl : prev?.doc?.sourceUrl);
  console.log(`[pdf] ${pdfUrl}${sourceUrl && sourceUrl !== pdfUrl ? `\n[src] ${sourceUrl}` : ""}`);
  const buf = await fetchPdf(pdfUrl);
  if (!buf) process.exit(2);
  const text = await pdfToText(buf);
  if (!text) {
    console.error("[pdf] 文本提取失败（检查 PDF_PYTHON / PyMuPDF）");
    process.exit(3);
  }
  const { format, races: chunks } = splitVolante(text);
  if (!format) {
    console.error("[pdf] 无法识别 volante 版式");
    process.exit(4);
  }
  const races = chunks.map((r) => ({ ...buildRace(r, format, DATE, TZ), raceKey: `tk-${TRACK}-${r.no}` }));
  const heads = races.reduce((n, r) => n + r.runners.length, 0);
  const doc = {
    ...(prev?.doc ?? {}),
    schema: "race.card/v2",
    source: "teletrak",
    fetchLayer: "teletrak.cl",
    sourceKey: `teletrak:${TRACK}`,
    date: DATE,
    track: TRACK,
    trackId: prev?.doc?.trackId ?? null,
    venue: prev?.doc?.venue ?? VENUE[TRACK] ?? TRACK,
    country: "CHI",
    countryLong: "Chile",
    scope: "overseas",
    timeZone: TZ,
    localTimeZone: TZ,
    going: prev?.doc?.going ?? null,
    surfaceRaw: prev?.doc?.surfaceRaw ?? null,
    sourceUrl: sourceUrl ?? pdfUrl,
    capturedAt: prev?.doc?.capturedAt ?? new Date().toISOString(),
    rebuiltAt: new Date().toISOString(),
    races,
    teletrak: { ...(prev?.doc?.teletrak ?? {}), format, pdfUrl },
  };
  console.log(`[out] ${races.length} R / ${heads} 頭 / format=${format} / 平均 ${(heads / races.length).toFixed(1)} 頭`);
  console.log(`      每场头数：${races.map((r) => `${r.no}:${r.runners.length}`).join(" ")}`);
  if (DRY) return;
  const out = path.join(DATA_DIR, DATE, `tk-${TRACK}.json.gz`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(doc)));
  console.log(`[ok]  ${path.relative(process.cwd(), out)}${prev && !FORCE ? "（已覆盖）" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
