// 全球重赏收集 · API + 静态服务（探索分支 feat/global-graded）
//
// 端口 9094（四兄弟站 9090-9093 之外单开，见 scripts/hooks 与 docs/GLOBAL-GRADED.md；
// 不动 serve.config.json 的 9093 —— 本分支独立演进，不与主站端口互相牵连）。
//
//   GET  /                    → site/global-graded.html（静态，root = site/）
//   GET  /api/data            → data/global-graded/graded.json
//   POST /api/collect         → 后台跑 node src/global/collect.mjs --fetch（重新检索全部比赛）
//   GET  /api/status          → { running, ... } 轮询用
//   GET  /api/video?race=<id> → 解析比赛视频（YouTube，带缓存；force=1 跳过缓存）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { videoForRace } from "./video.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SITE_DIR = path.join(ROOT, "site");
const OUT_DIR = path.join(ROOT, "data", "global-graded");
const DATA_FILE = path.join(OUT_DIR, "graded.json");
const PORT = 9094;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

// ---------- 采集任务状态（单任务，重入直接拒绝） ----------
let job = { running: false, startedAt: null, finishedAt: null, ok: null, log: "" };

function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; }
}

function startCollect() {
  if (job.running) return { ok: false, error: "采集已在进行中" };
  job = { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, log: "" };
  const child = spawn(process.execPath, [path.join(ROOT, "src", "global", "collect.mjs"), "--fetch"], {
    cwd: ROOT, windowsHide: true,
  });
  const append = (chunk) => {
    job.log += chunk.toString();
    if (job.log.length > 60000) job.log = job.log.slice(-60000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code) => {
    job.running = false;
    job.finishedAt = new Date().toISOString();
    job.ok = code === 0;
  });
  return { ok: true };
}

// ---------- 路由 ----------
async function handle(req, res) {
  const u = new URL(req.url, "http://localhost");
  const send = (code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  if (u.pathname === "/api/data") {
    const data = readJson(DATA_FILE);
    if (!data) return send(404, { error: "graded.json 不存在，先跑 node src/global/collect.mjs" });
    return send(200, data);
  }

  if (req.method === "POST" && u.pathname === "/api/collect") {
    return send(200, startCollect());
  }

  if (u.pathname === "/api/status") {
    return send(200, job);
  }

  if (u.pathname === "/api/video") {
    const raceId = u.searchParams.get("race");
    const force = u.searchParams.get("force") === "1";
    if (!raceId) return send(400, { error: "缺 race 参数" });
    const data = readJson(DATA_FILE);
    const race = data?.races?.find((r) => r.id === raceId);
    if (!race) return send(404, { error: `比赛不存在: ${raceId}` });
    try {
      const v = await videoForRace(race, { force });
      return send(200, v);
    } catch (e) {
      return send(502, { error: e.message });
    }
  }

  // 静态：仅 site/（数据一律走 /api/data；site/global-graded-data.json 为兜底副本）
  const rel = u.pathname === "/" ? "/global-graded.html" : u.pathname;
  const fp = path.normalize(path.join(SITE_DIR, rel));
  if (!fp.startsWith(SITE_DIR)) return send(403, "forbidden", "text/plain");
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    return send(404, "not found: " + u.pathname, "text/plain; charset=utf-8");
  }
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(fp).pipe(res);
}

http.createServer((req, res) => handle(req, res).catch((e) => {
  res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("internal error: " + e.message);
})).listen(PORT, "127.0.0.1", () => {
  console.log(`[global] http://127.0.0.1:${PORT}/global-graded.html`);
});
