// 请求日志（JSONL）：所有出站 HTTP 请求逐条追加到 data/logs/requests-YYYYMMDD.jsonl
// 目的：抓取链路可回溯（哪个源、哪个 URL、状态、耗时、字节数、失败原因）。
// 关闭：RC_REQLOG=0；改目录：RC_REQLOG_DIR=/path
import fs from "node:fs";
import path from "node:path";

const ENABLED = process.env.RC_REQLOG !== "0";
const DIR = process.env.RC_REQLOG_DIR ? path.resolve(process.env.RC_REQLOG_DIR) : path.resolve("data", "logs");

let cachedDay = null;
let file = null;

function jstDay() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}${g("month")}${g("day")}`;
}

function fileOf() {
  const day = jstDay();
  if (day !== cachedDay) {
    fs.mkdirSync(DIR, { recursive: true });
    file = path.join(DIR, `requests-${day}.jsonl`);
    cachedDay = day;
  }
  return file;
}

const stats = { total: 0, ok: 0, notFound: 0, error: 0, bytes: 0, bySrc: {} };

// rec: { src, url, status, ok, ms, bytes, note?, err? }
export function logRequest(rec) {
  if (!ENABLED) return;
  const line = {
    ts: new Date().toISOString(),
    src: rec.src ?? null,
    method: rec.method ?? "GET",
    url: rec.url,
    status: rec.status ?? 0,
    ok: !!rec.ok,
    ms: rec.ms ?? null,
    bytes: rec.bytes ?? 0,
    ...(rec.note ? { note: rec.note } : {}),
    ...(rec.err ? { err: String(rec.err).slice(0, 300) } : {}),
  };
  stats.total++;
  if (line.ok) stats.ok++;
  else if (line.status === 404) stats.notFound++;
  else stats.error++;
  stats.bytes += line.bytes;
  const s = (stats.bySrc[line.src] ??= { n: 0, ok: 0, err: 0 });
  s.n++;
  line.ok ? s.ok++ : s.err++;
  try {
    fs.appendFileSync(fileOf(), JSON.stringify(line) + "\n");
  } catch {
    /* 日志失败不影响抓取 */
  }
}

export function reqStats() {
  return { ...stats, file: file };
}
