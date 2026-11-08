// 前走人气回填：JBIS 馬頁「競走成績」（/horse/{id}/record/）→ data/recent-pop.json
//   ─ 为什么另开一份缓存：出馬表只给「前3走」的着順/タイム/馬体重，**没有人気**；
//     人気只在馬頁的競走成績表里（实测表头含「人気」，每行比赛名直链 /race/result/{raceKey}/）。
//   ─ 为什么按种马圈定而不是全量：全站 20 天窗口有 2 万匹在跑，全量抓是 6 小时级；
//     而「前走」列只出现在兄弟站 embed（按种马筛产驹），所以按 --sire 圈定产驹集合，
//     一次 200~400 匹（约 5 分钟），周增量只碰新出走的马。
//
// 用法：
//   node src/collect-recent-pop.js --sire コントレイル            # 只补缺失/过期的
//   node src/collect-recent-pop.js --sire コントレイル --sire キズナ
//   node src/collect-recent-pop.js --sire コントレイル --force     # 无视缓存全重抓
//   node src/collect-recent-pop.js --sire コントレイル --limit 5 --dry
//
// 落盘：data/recent-pop.json
//   { schema:"jbis.recent-pop/v1", updatedAt, horses: { "<jbisId>": {
//       fetchedAt:"2026-11-08T12:00:00.000Z", seenDate:"2026-11-08",   // seenDate = 该马在本仓竞赛数据里的最近出场日
//       last: { date:"2026-08-30", raceKey:"20260830/101/02", raceName:"サラ系２歳 未勝利", pop:13, rank:"10" } } } }
//   last 为 null = 该马无出走记录（新馬未出走 / 页面无成绩表）
import fs from "node:fs";
import path from "node:path";
import { readGz } from "./lib/bundle.js";
import { fetchHtml } from "./lib/fetch.js";
import { SITE } from "./config.js";

const argVal = (k) => process.argv.reduce((acc, a, i) => (a === k ? [...acc, process.argv[i + 1]] : acc), []);
const has = (k) => process.argv.includes(k);

const SIRES = argVal("--sire");
const ALL = has("--all");
const FORCE = has("--force");
const DRY = has("--dry");
const LIMIT = Number(argVal("--limit")[0] || 0);
const DATA_DIR = path.resolve("data", "races");
const CACHE = path.resolve("data", "recent-pop.json");
const DELAY = Number(argVal("--delay")[0] || SITE.delayMs);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. 圈定产驹：扫本仓竞赛数据，只留指定种马的产驹 ----------
function collectTargets() {
  const targets = new Map(); // jbisId → { id, name, seenDate }
  if (!fs.existsSync(DATA_DIR)) return targets;
  const dates = fs.readdirSync(DATA_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  for (const date of dates) {
    for (const f of fs.readdirSync(path.join(DATA_DIR, date))) {
      if (!f.endsWith(".json") && !f.endsWith(".json.gz")) continue;
      if (f === "manifest.json") continue;
      const p = path.join(DATA_DIR, date, f);
      let doc;
      try {
        doc = JSON.parse(f.endsWith(".gz") ? readGz(p) : fs.readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      for (const race of doc.races ?? []) {
        for (const r of race.runners ?? []) {
          const id = r.horse?.id;
          if (!id || !/^\d{10}$/.test(id)) continue;      // 海外源 id 带 rp: 前缀 → 无 JBIS 馬頁，跳过
          if (SIRES.length && !SIRES.some((s) => String(r.sire?.name ?? "").includes(s))) continue;
          const cur = targets.get(id);
          if (!cur) targets.set(id, { id, name: r.horse?.name ?? "", seenDate: date });
          else if (date > cur.seenDate) cur.seenDate = date;
        }
      }
    }
  }
  return targets;
}

// ---------- 2. 解析競走成績页：取最近一场（页面默认日付降順，仍按日期取最大兜底） ----------
function normRank(v) {
  const t = String(v ?? "").trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return t;                 // 「10」= 10 着
  if (/^[除中失取止]$/.test(t)) return t;         // 除外/中止/失格/取消/競走中止
  return null;                                    // 「**」等占位标记：当无成绩处理
}

export function parseRecordPage(html) {
  const rows = [];
  const re =
    /<div>\s*<div>(\d{4})\.(\d{2})\.(\d{2})<\/div>\s*<div>([^<]*)<\/div>\s*<div class="data-6__tag">\s*<a href="\/race\/result\/([^"]+)\/"[^>]*>([^<]*)<\/a>\s*<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    const venue = m[4].trim();
    const raceKey = m[5];
    const raceName = m[6].trim();
    // 行内后续：着順（number-4）→ 芝ダ/距離/馬場/頭数/馬番 → 人気
    const from = m.index + m[0].length;
    const tail = html.slice(from, from + 1200);
    const rankM = tail.match(/<span class="number-4">\s*([^<]*?)\s*<\/span>/);
    const popM = tail.match(/(\d+)\s*人気/);
    rows.push({
      date,
      raceKey,
      raceName,
      venue,
      pop: popM ? Number(popM[1]) : null,
      rank: rankM ? normRank(rankM[1]) : null,
    });
  }
  if (!rows.length) return [];
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows.slice(0, 3);   // 最近 3 场：够覆盖「本场」与「最近一周」两种行的前走
}

// ---------- 3. 主流程 ----------
if (!SIRES.length && !ALL) {
  console.error(
    "[recent-pop] 拒绝执行：必须显式圈定范围。\n" +
      "  --sire <种马日文名>   只抓该种马的产驹（兄弟站 embed 的口径，推荐）\n" +
      "  --all                 全站窗口内所有马（约 9000 匹 = 3 小时，慎用）",
  );
  process.exit(2);
}

const targets = collectTargets();
if (!targets.size) {
  console.error(`[recent-pop] 没有命中任何目标马（--sire ${SIRES.join(" / ")}），检查种马名写法是否与数据里一致`);
  process.exit(2);
}

const cache = fs.existsSync(CACHE)
  ? JSON.parse(fs.readFileSync(CACHE, "utf8"))
  : { schema: "jbis.recent-pop/v1", updatedAt: null, horses: {} };
cache.horses ??= {};

const TTL = 12 * 3600 * 1000;             // 12h 内抓过的不重复抓（防同日反复跑）
const todo = [...targets.values()].filter((t) => {
  const hit = cache.horses[t.id];
  if (!hit) return true;
  if (FORCE) return true;
  if (Date.now() - Date.parse(hit.fetchedAt ?? 0) < TTL) return false;
  // 该马在本仓数据里又出场（或在出场日之前抓的）→ 前走已变，需重抓
  return String(hit.seenDate ?? "") < t.seenDate || String(hit.fetchedAt ?? "").slice(0, 10) <= t.seenDate;
});

console.log(
  `[recent-pop] 目标 ${targets.size} 匹 / 缓存已有 ${Object.keys(cache.horses).length} / 待抓 ${todo.length}` +
    (LIMIT ? ` / 本次限 ${LIMIT}` : "") + (DRY ? "（dry-run）" : ""),
);

let done = 0, ok = 0, fail = 0;
const queue = LIMIT ? todo.slice(0, LIMIT) : todo;
for (const t of queue) {
  done++;
  const url = `https://www.jbis.or.jp/horse/${t.id}/record/`;
  try {
    const html = await fetchHtml(url, { src: "jbis", retries: 2 });
    const runs = parseRecordPage(html);
    cache.horses[t.id] = { fetchedAt: new Date().toISOString(), seenDate: t.seenDate, runs };
    ok++;
    if (done % 10 === 0 || done <= 3) {
      const r = runs[0];
      const s = r ? `${r.date} ${r.raceName} ${r.pop ?? "—"}人気 ${r.rank ?? "—"}着` : "无成绩";
      console.log(`  [${done}/${queue.length}] ${t.id} ${t.name} → ${s}`);
    }
  } catch (e) {
    fail++;
    console.warn(`  [${done}/${queue.length}] ${t.id} ${t.name} 失败：${e.message}`);
  }
  if (!DRY && done % 25 === 0) save(cache);       // 中途落盘，断点可续
  if (done < queue.length) await sleep(DELAY);
}

function save(obj) {
  obj.updatedAt = new Date().toISOString();
  fs.writeFileSync(CACHE, JSON.stringify(obj) + "\n");
}

if (DRY) {
  console.log(`[recent-pop] dry-run：ok=${ok} fail=${fail}（未落盘）`);
} else {
  save(cache);
  const withLast = Object.values(cache.horses).filter((h) => (h.runs ?? []).length).length;
  console.log(`[recent-pop] ok=${ok} fail=${fail} → ${path.relative(process.cwd(), CACHE)}（有成绩 ${withLast} 匹）`);
}
