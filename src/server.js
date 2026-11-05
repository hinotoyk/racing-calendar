// 本地静态服务（默认端口 9090，见 src/config.js）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SITE } from "./config.js";

const ROOT = path.resolve("_site");
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
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url.endsWith("/")) url += "index.html";
  const fp = path.normalize(path.join(ROOT, url));
  if (!fp.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("not found: " + url);
    }
    // CORS *：与线上 GitHub Pages 对齐（GH Pages 全站带 ACAO *）。embed 组件（embed/entries-table.js）
    // 在兄弟站宿主页里跨站 fetch 本站 derived/*.json，本地 ?rcdev=1 联调必须有 CORS 头，否则浏览器拦截。
    // Cache-Control: no-cache：本地开发防陈旧 JS/CSS（无 ETag/Last-Modified，启发式缓存会让浏览器
    // 一直用旧脚本——用户「看不到新功能」的元凶）。图片允许缓存。
    const ext = path.extname(fp).toLowerCase();
    const isImg = [".png", ".gif", ".jpg", ".jpeg", ".svg", ".woff2"].includes(ext);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": isImg ? "public, max-age=3600" : "no-cache",
    });
    fs.createReadStream(fp).pipe(res);
  });
});

function listen(port, attempt = 0) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && attempt < 5) {
      console.log(`port ${port} busy, trying ${port + 1}...`);
      listen(port + 1, attempt + 1);
    } else {
      console.error("server error:", e.message);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`serving ${ROOT}`);
    console.log(`open: ${url}`);
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

const PORT_ARG = (() => {
  const i = process.argv.indexOf("--port");
  if (i > 0) return Number(process.argv[i + 1]);
  return process.env.PORT ? Number(process.env.PORT) : null;
})();

listen(PORT_ARG || SITE.port);
