// 数据降级审计（2026-11-23）
//
// 目的：把「无值覆盖有值」从「事后靠人肉发现」变成「每轮流水线自动拦截」。
//   node src/audit-downgrade.js            # 审计工作区相对 HEAD 的改动（默认）
//   node src/audit-downgrade.js --all      # 审计全库（慢，用于排障）
//   node src/audit-downgrade.js --restore  # 发现降级时用合并结果自动修复（保留新数据 + 补回被洗空的值）
//   node src/audit-downgrade.js --strict   # 存在降级则 exit 1（CI 用）
//   node src/audit-downgrade.js --from <rev> [--restore]  # 历史扫描：把 <rev> 之后被洗掉的字段补回来
//
// 判定口径见 lib/merge-safe.mjs：null / undefined / "" / [] / NaN 视为「无值」。
// 白名单：非日本赛事的 frame —— 海外本就没有枠番，strip-foreign-frame 清它是预期行为。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { diffDowngrades, mergeDocSafe } from "./lib/merge-safe.mjs";
import { loadClears, isClearedDrop } from "./lib/clears.js";

const argv = process.argv.slice(2);
const ALL = argv.includes("--all");
const FROM_IDX = argv.indexOf("--from");
const FROM = FROM_IDX >= 0 ? argv[FROM_IDX + 1] : null;
const RESTORE = argv.includes("--restore");
const STRICT = argv.includes("--strict");
const ROOT = process.cwd();

const DATA_DIRS = ["data/races", "data/results"];
const MAX_REPORT = 40;

const git = (args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 28 }).toString("utf8");

function readWorking(file) {
  try {
    const buf = fs.readFileSync(path.join(ROOT, file));
    const raw = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readHead(file) {
  const rev = FROM ?? "HEAD";
  try {
    const buf = execFileSync("git", ["show", `${rev}:${file}`], {
      cwd: ROOT,
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"], // 新文件不在该 rev：静默跳过
    });
    const raw = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listFiles() {
  if (ALL) {
    const out = [];
    for (const dir of DATA_DIRS) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const d of fs.readdirSync(abs)) {
        const sub = path.join(abs, d);
        if (!fs.statSync(sub).isDirectory()) continue;
        for (const f of fs.readdirSync(sub)) {
          if (/\.json(\.gz)?$/.test(f)) out.push(`${dir}/${d}/${f}`);
        }
      }
    }
    return out;
  }
  const base = FROM ?? "HEAD";
  const changed = git(["diff", "--name-only", base, "--", ...DATA_DIRS]).split("\n").filter(Boolean);
  return changed.filter((f) => /\.json(\.gz)?$/.test(f));
}

/** 海外文档允许 frame 被清空（本来就没有枠） */
function frameAllowed(doc) {
  const country = doc?.country;
  const scope = doc?.scope;
  if (country && country !== "JPN") return true;
  if (scope === "central" || scope === "local") return false;
  return Boolean(doc?.source && doc.source !== "jbis");
}

const isFramePath = (p) => /^races\[[^\]]*\]\[h:[^\]]*\]\.frame$/.test(p) || p === "frame" || /\.frame$/.test(p);

const clears = loadClears();
const files = listFiles();
const findings = [];
let scanned = 0;
let restored = 0;

for (const file of files) {
  const head = readHead(file);
  if (!head) continue; // 新文件 / 不在 HEAD：没有可比对象
  const now = readWorking(file);
  if (!now) {
    findings.push({ file, path: "*", from: "(整份文档)", note: "文档无法解析" });
    continue;
  }
  scanned++;
  const allow = frameAllowed(head);
  const drops = diffDowngrades(head, now).filter(
    (d) => !(allow && isFramePath(d.path)) && !isClearedDrop(clears, file, d.path)
  );
  if (!drops.length) continue;

  if (RESTORE) {
    const { doc } = mergeDocSafe(head, now);
    const target = path.join(ROOT, file);
    const str = JSON.stringify(doc);
    fs.writeFileSync(target, file.endsWith(".gz") ? zlib.gzipSync(Buffer.from(str), { level: 9 }) : str);
    restored++;
  }
  for (const d of drops) findings.push({ file, path: d.path, from: JSON.stringify(d.from) });
}

console.log(`== downgrade audit (${ALL ? "全库" : FROM ? `历史 ${FROM}..HEAD` : "工作区 vs HEAD"})`);
console.log(`扫描 ${scanned} 份已存文档，发现降级点 ${findings.length} 处${RESTORE ? `，已自动修复 ${restored} 份` : ""}`);

const byFile = new Map();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}

let shown = 0;
for (const [file, list] of byFile) {
  if (shown >= MAX_REPORT) {
    console.log(`  … 其余 ${byFile.size - shown} 份文档略`);
    break;
  }
  console.log(`\n  ${file}  降级 ${list.length} 处`);
  for (const f of list.slice(0, 6)) console.log(`    - ${f.path}: ${f.from} → 空`);
  if (list.length > 6) console.log(`    … 及另外 ${list.length - 6} 处`);
  shown++;
}

if (findings.length && !RESTORE) {
  console.log(`\n⚠️ 检测到「无值覆盖有值」：${findings.length} 处。加 --restore 可自动补回（保留本轮新数据）。`);
}

if (STRICT && findings.length && !RESTORE) process.exit(1);
