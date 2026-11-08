// 本地静态服务：端口 / 服务根 / 绑址单源 = 项目根 serve.config.json（docs/DESIGN.md §10）
//   yunji-web 9090 / kzn-web 9091 / jbis-sire-rank-history 9092 / 本站 9093
// 端口被占用时直接报错退出（不自动顺延，也没有 --port 临时覆盖）：宿主站云迹 entries.html 把本站
// 端口硬编码成 9093，任何漂移都是静默失配。换端口只改 serve.config.json + 同步宿主。
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { SITE, SERVE, ROOT_DIR } from "./config.js";

const ROOT = path.resolve(ROOT_DIR, SERVE.root);
const ENTRY = SERVE.open || "index.html";
const HOST = SERVE.host || "127.0.0.1";
const PORT = SITE.port;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const CACHEABLE = new Set([".png", ".gif", ".jpg", ".jpeg", ".webp", ".ico", ".svg", ".woff2"]);

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url.endsWith("/")) url += ENTRY;
  const fp = path.normalize(path.join(ROOT, url));
  if (!fp.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      return res.end("not found: " + url);
    }
    // CORS *：与线上 GitHub Pages 对齐（GH Pages 全站带 ACAO *）。embed 组件（embed/entries-table.js）
    // 在兄弟站宿主页里跨站 fetch 本站 derived/*.json，本地联调必须有 CORS 头，否则浏览器拦截。
    // Cache-Control: no-cache：本地开发防陈旧 JS/CSS（无 ETag/Last-Modified，启发式缓存会让浏览器
    // 一直用旧脚本——用户「看不到新功能」的元凶）。图片/字体允许缓存。
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": CACHEABLE.has(ext) ? "public, max-age=3600" : "no-cache",
    });
    fs.createReadStream(fp).pipe(res);
  });
});

function die(msg) {
  console.error("[serve] " + msg);
  process.exit(1);
}

/** 真·占用检测：本机已有监听则 connect 立刻成功（不靠 bind，避开 SO_REUSEADDR/TIME_WAIT 干扰） */
function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    die(`服务根不存在：${ROOT}\n        产物没建出来，先执行：npm run build`);
  }
  if (!fs.existsSync(path.join(ROOT, ENTRY))) {
    die(`入口不存在：${path.join(ROOT, ENTRY)}\n        产物不完整，先执行：npm run build`);
  }
  if (await portBusy(PORT)) {
    die(`端口 ${PORT} 已被占用（本站约定端口，见 serve.config.json）。\n` +
      `        查占用：netstat -ano | findstr :${PORT} → taskkill /PID <pid> /F\n` +
      `        换端口只改 serve.config.json，并同步宿主站（yunji entries.html 的 RC_LOCAL）。`);
  }

  server.once("error", (e) => die(`无法监听 ${HOST}:${PORT} —— ${e.message}`));
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/${ENTRY}`;
    console.log(`[serve] serving ${ROOT}`);
    console.log(`[serve] open: ${url}`);
    if (!process.argv.includes("--no-open")) {
      try {
        if (process.platform === "win32") {
          spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", [url], { stdio: "ignore", detached: true }).unref();
        } else {
          spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
        }
      } catch { /* 打开浏览器失败不影响服务 */ }
    }
  });
}

main();
