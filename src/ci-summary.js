// CI 运行摘要（零依赖）：把 data/logs/requests-*.jsonl 聚合成一眼可读的诊断，
// 直接打印到 GitHub Actions 的 step 日志（无需下载 artifact 也能判断成败），
// 同时写 test-logs/summary.log / summary.json / verdict.txt 供 artifact 留存。
//
// 判定：FAIL = 明确跑挂（无任何请求 / 大面积网络失败 / build 未产出 / 无有效出馬表数据）
//       WARN = 有异常但不致命（403 限流、5xx、欧美 0 请求、JRA 彩衣非 100%、彩衣缺图）
//       OK   = 正常
// 退出码恒为 0，由 workflow 末尾的 gate 步骤读 verdict.txt 决定 job 成败，
// 保证即使 FAIL 也能走到 artifact 上传。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const LOG_DIR = path.resolve(argOf("--logs-dir") ?? path.resolve("data", "logs"));
const OUT_DIR = path.resolve(argOf("--out-dir") ?? "test-logs");
const RACE_DIR = path.resolve("data", "races");
const SILK_DIR = path.resolve("data", "silks");
const SINCE_MIN = parseInt(argOf("--since-minutes") ?? "0", 10);
const FULL_RUN = argv.includes("--rp"); // 全量档 update-data.yml（北京 02:00）/ 手动 dispatch：应包含欧美请求

fs.mkdirSync(OUT_DIR, { recursive: true });
const lines = [];
const say = (s = "") => { lines.push(s); console.log(s); };

// ---------- 1) JSONL 请求日志 ----------
const files = fs.existsSync(LOG_DIR)
  ? fs.readdirSync(LOG_DIR).filter((f) => /^requests-\d{8}\.jsonl$/.test(f))
      .filter((f) => !SINCE_MIN || Date.now() - fs.statSync(path.join(LOG_DIR, f)).mtimeMs <= SINCE_MIN * 60_000)
      .map((f) => path.join(LOG_DIR, f)).sort()
  : [];
const req = { total: 0, ok: 0, err: 0, status: {}, bySrc: {}, errSamples: [], firstTs: null, lastTs: null, bytes: 0 };
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    req.total++;
    r.ok ? req.ok++ : req.err++;
    bump(req.status, String(r.status ?? 0));
    req.bytes += r.bytes ?? 0;
    const s = (req.bySrc[r.src ?? "?"] ??= { n: 0, ok: 0, err: 0, "403": 0, "404": 0, "5xx": 0 });
    s.n++;
    r.ok ? s.ok++ : s.err++;
    if (r.status === 403) s["403"]++;
    if (r.status === 404) s["404"]++;
    if (r.status >= 500) s["5xx"]++;
    if (!r.ok && req.errSamples.length < 12 && r.status !== 404) {
      req.errSamples.push(`${r.src}/${r.status} ${String(r.url ?? "").slice(0, 110)} ${String(r.err ?? "").slice(0, 80)}`);
    }
    if (!req.firstTs || r.ts < req.firstTs) req.firstTs = r.ts;
    if (!req.lastTs || r.ts > req.lastTs) req.lastTs = r.ts;
  }
}
const statusOf = (n) => req.status[String(n)] ?? 0;
const n403 = statusOf(403) + statusOf(429);
const n5xx = Object.entries(req.status).filter(([k]) => +k >= 500).reduce((a, [, v]) => a + v, 0);
const nNetErr = statusOf(0);
const slRequests = Object.entries(req.bySrc).filter(([k]) => /sportinglife|sl-silk/.test(k)).reduce((a, [, v]) => a + v.n, 0);
const jbisRequests = Object.entries(req.bySrc).filter(([k]) => /jbis/.test(k)).reduce((a, [, v]) => a + v.n, 0);

// ---------- 2) 数据覆盖（彩衣 / 马名权威化） ----------
const cov = { docs: 0, docsWithRunners: 0, rows: 0, silk: 0, central: 0, centralSilk: 0, local: 0, localSilk: 0,
  jbisRows: 0, nameOk: 0, rpRows: 0, rpSilk: 0, silkRefs: new Set(), silkMissing: new Set() };
if (fs.existsSync(RACE_DIR)) {
  for (const d of fs.readdirSync(RACE_DIR).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))) {
    const dp = path.join(RACE_DIR, d);
    for (const f of fs.readdirSync(dp).filter((x) => x.endsWith(".json.gz"))) {
      let doc; try { doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dp, f))).toString()); } catch { continue; }
      const runners = (doc.races ?? []).flatMap((r) => r.runners ?? []);
      cov.docs++;
      if (runners.length) cov.docsWithRunners++;
      const isRp = f.startsWith("rp-");
      for (const r of runners) {
        cov.rows++;
        const h = r.horse ?? {};
        const url = r.silk?.url ?? null;
        if (url) {
          cov.silk++;
          cov.silkRefs.add(url);
          if (!fs.existsSync(path.resolve(url)) && !cov.silkMissing.has(url)) cov.silkMissing.add(url);
        }
        if (!isRp) {
          cov.jbisRows++;
          if (h.foaled || h.nameJp) cov.nameOk++;
          if (h.country === "JPN") {
            if (doc.scope === "central") { cov.central++; if (url) cov.centralSilk++; }
            else if (doc.scope === "local") { cov.local++; if (url) cov.localSilk++; }
          }
        } else { cov.rpRows++; if (url) cov.rpSilk++; }
      }
    }
  }
}
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "n/a");

// ---------- 3) build 是否产出 ----------
const buildLog = path.join(OUT_DIR, "build.log");
const buildText = fs.existsSync(buildLog) ? fs.readFileSync(buildLog, "utf8") : "";
const buildOk = /\[build\] dates=\d+ rows=\d+/.test(buildText);
const siteRows = Number(buildText.match(/\[build\] dates=\d+ rows=(\d+)/)?.[1] ?? 0);
const logErrors = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".log") && f !== "summary.log")
  .flatMap((f) => fs.readFileSync(path.join(OUT_DIR, f), "utf8").split("\n")
    .filter((l) => /\[err\]|::error|⚠|Error:/.test(l)).slice(0, 5).map((l) => `${f}: ${l.trim().slice(0, 160)}`));

// ---------- 4) 报告 ----------
say("========== CI 运行摘要 ==========");
say(`日志: ${files.length} 个 jsonl 文件 ${files.map((f) => path.basename(f)).join(", ") || "(无)"}`);
say(`窗口: ${req.firstTs ?? "-"} → ${req.lastTs ?? "-"}（${req.firstTs && req.lastTs ? ((new Date(req.lastTs) - new Date(req.firstTs)) / 60000).toFixed(1) + " min" : "n/a"}）`);
say(`请求: 总 ${req.total} / 成功 ${req.ok} / 失败 ${req.err} / 字节 ${(req.bytes / 1048576).toFixed(1)} MB`);
say(`状态: 403/429=${n403}  404=${statusOf(404)}  5xx=${n5xx}  网络异常(0)=${nNetErr}`);
say("按源:");
for (const [k, v] of Object.entries(req.bySrc).sort((a, b) => b[1].n - a[1].n)) {
  say(`  ${k.padEnd(16)} n=${String(v.n).padStart(5)} ok=${String(v.ok).padStart(5)} 403=${String(v["403"]).padStart(3)} 404=${String(v["404"]).padStart(3)} 5xx=${String(v["5xx"]).padStart(3)}`);
}
if (req.errSamples.length) { say("失败样本:"); for (const s of req.errSamples) say(`  ${s}`); }
say(`数据: docs=${cov.docs} (有出走马 ${cov.docsWithRunners}) rows=${cov.rows}`);
say(`彩衣: 全站 ${cov.silk}/${cov.rows} = ${pct(cov.silk, cov.rows)} | JRA ${cov.centralSilk}/${cov.central} = ${pct(cov.centralSilk, cov.central)} | NAR ${cov.localSilk}/${cov.local} = ${pct(cov.localSilk, cov.local)} | 欧美 ${cov.rpSilk}/${cov.rpRows} = ${pct(cov.rpSilk, cov.rpRows)}`);
say(`马名权威化: ${cov.nameOk}/${cov.jbisRows} = ${pct(cov.nameOk, cov.jbisRows)}（JBIS 马页 foaled/nameJp）`);
say(`彩衣图: 引用 ${cov.silkRefs.size} 张，磁盘缺失 ${cov.silkMissing.size} 张${cov.silkMissing.size ? " → " + [...cov.silkMissing].slice(0, 3).join(", ") : ""}`);
say(`build: ${buildOk ? "OK" : "未成功"} ${siteRows ? `(rows=${siteRows})` : ""}`);
if (logErrors.length) { say("采集日志异常行:"); for (const l of logErrors.slice(0, 10)) say(`  ${l}`); }

// ---------- 5) 判定 ----------
const warnings = [];
const fatals = [];
if (req.total === 0) fatals.push("无任何出站请求（采集脚本未启动或日志被关闭）");
if (req.total >= 20 && req.err / req.total > 0.6) fatals.push(`请求失败率 ${pct(req.err, req.total)} > 60%`);
if (cov.docsWithRunners === 0) fatals.push("没有任何含出走马的快照文档");
if (!buildOk) fatals.push("build 未产出 [build] dates/rows 标志");
if (n403 > 0) warnings.push(`JBIS/SL 限流 403/429 共 ${n403} 次（看按源分布判断影响面）`);
if (n5xx > 0) warnings.push(`服务端 5xx 共 ${n5xx} 次`);
if (nNetErr > 0) warnings.push(`网络层异常 ${nNetErr} 次`);
if (jbisRequests === 0) warnings.push("JBIS 相关请求为 0");
if (FULL_RUN && slRequests === 0) warnings.push("全量档但 Sporting Life 请求为 0（欧美卡未采）");
if (cov.central > 0 && cov.centralSilk < cov.central) warnings.push(`JRA 彩衣 ${cov.centralSilk}/${cov.central} 未满`);
if (cov.nameOk < cov.jbisRows) warnings.push(`马名权威化缺 ${cov.jbisRows - cov.nameOk} 行`);
if (cov.silkMissing.size) warnings.push(`彩衣引用缺图 ${cov.silkMissing.size} 张`);
if (logErrors.length) warnings.push(`采集日志有 ${logErrors.length} 条异常行`);
const verdict = fatals.length ? "FAIL" : warnings.length ? "WARN" : "OK";
say(`判定: ${verdict}`);
for (const x of fatals) { say(`  [FATAL] ${x}`); console.log(`::error::${x}`); }
for (const x of warnings) { say(`  [warn]  ${x}`); console.log(`::warning::${x}`); }
say("================================");

fs.writeFileSync(path.join(OUT_DIR, "summary.log"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(OUT_DIR, "verdict.txt"), verdict + "\n");
fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({
  verdict, runAt: new Date().toISOString(), files: files.map((f) => path.basename(f)),
  window: { firstTs: req.firstTs, lastTs: req.lastTs },
  requests: { total: req.total, ok: req.ok, err: req.err, status: req.status, bySrc: req.bySrc,
    n403, n5xx, nNetErr, jbisRequests, slRequests, bytes: req.bytes },
  coverage: { ...cov, silkRefs: cov.silkRefs.size, silkMissing: [...cov.silkMissing] },
  buildOk, siteRows, fatals, warnings, errSamples: req.errSamples, logErrors,
}, null, 2));
