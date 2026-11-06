// 设计稿预览服务：把 design/ 目录挂到 127.0.0.1:9441，根目录自动列出所有 html
// 用法：node design/serve-preview.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname);
const PORT = 9441;
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".gif": "image/gif", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/" || url.endsWith("/")) {
    const files = fs.readdirSync(ROOT)
      .filter((f) => f.endsWith(".html"))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(ROOT, f));
        return `<li><a href="/${f}">${f}</a><span>${(st.size / 1024).toFixed(0)} KB · ${st.mtime.toLocaleString("zh-CN")}</span></li>`;
      }).join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>设计稿预览 · 9441</title>
<style>body{font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#222;padding:40px;max-width:760px;margin:auto}
h1{font-size:20px}ul{list-style:none;padding:0;margin-top:18px}li{background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
a{color:#0b6b64;font-weight:600;text-decoration:none}span{color:#98a2ac;font-size:12px}p{color:#7c8792;font-size:12px}</style></head>
<body><h1>设计稿预览 · 9441</h1><p>racing-calendar / design — 点击打开（no-cache，改动后直接刷新即可）</p><ul>${files}</ul></body></html>`);
  }
  const fp = path.normalize(path.join(ROOT, url));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found: " + url); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(fp).pipe(res);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`design preview: http://127.0.0.1:${PORT}/`));
