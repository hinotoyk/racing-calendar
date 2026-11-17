// 巴西出走表血统/性别回填：ABCPCC Stud Book（online，带磁盘缓存）
//
// 背景：TurfeOnline 的节目页只有「马号 / 马名 / 骑手 / 负磅 / 闸位」，父/母/母父/父父/性别
// 全缺；结果页只给冠军一匹的血统。巴西纯血马全部登记在 ABCPCC 的 Stud Book Brasileiro，
// 该站详情接口是纯 JSON（见 src/lib/abcpcc.mjs 顶部注释），按马名即可查到：
//   父 / 母 / 父父 / 母父 / 母母 / 父母 + 性别 + 出生日 + 繁育者 + 马主
//
// 用法：
//   node src/backfill-bra-ped.js                  # 补齐所有已落盘的巴西卡片（缓存命中不发请求）
//   node src/backfill-bra-ped.js --date 2026-11-17
//   node src/backfill-bra-ped.js --dry --limit 20  # 只报告不写盘
//   node src/backfill-bra-ped.js --force           # 忽略马匹缓存重抓（缓存损坏/改名时用）
// 幂等：只填缺失字段（默认不覆盖已有值）；无变化不写盘。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { horseProfile, cacheDir } from "./lib/abcpcc.mjs";

const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const val = (k, d = null) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const DRY = has("dry");
const FORCE = has("force");
const ONLY_DATE = val("date");
const LIMIT = Number(val("limit", "0")) || 0;
const CONC = Number(val("concurrency", "4")) || 4;

const RACES = path.resolve("data", "races");

// ---------- 扫盘 ----------
function targetFiles() {
  const out = [];
  for (const day of fs.readdirSync(RACES).sort()) {
    if (ONLY_DATE && day !== ONLY_DATE) continue;
    const dir = path.join(RACES, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(".json.gz")) continue;
      if (!/^tol-/.test(f)) continue; // 目前只有 TurfeOnline 缺血统；其它巴西源接入后在此放开
      out.push({ day, file: path.join(dir, f) });
    }
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

function readDoc(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
}

// ---------- 抓取（按马名去重，并发 CONC） ----------
async function fetchAll(names, yearOfName) {
  const prof = new Map();
  const list = [...names];
  let done = 0;
  let miss = 0;
  const worker = async () => {
    while (list.length) {
      const name = list.shift();
      const rec = await horseProfile(name, { force: FORCE, yearHint: yearOfName.get(name) ?? null }).catch(() => null);
      prof.set(name, rec);
      done++;
      if (!rec || rec.missing) miss++;
      if (done % 10 === 0 || done === names.size) console.log(`  ... ${done}/${names.size}（未命中 ${miss}）`);
      await new Promise((r) => setTimeout(r, 150)); // 礼貌节流（并发 4 × 150ms ≈ 26 req/s 上限）
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, list.length || 1) }, worker));
  return prof;
}

// ---------- 打补丁 ----------
const yearOf = (iso) => Number(String(iso ?? "").slice(0, 4)) || null;
const ageAt = (birth, raceDate) => {
  const b = yearOf(birth);
  const y = yearOf(raceDate);
  return b && y && y >= b ? y - b : null;
};

function patch(doc, prof) {
  const stat = { sex: 0, age: 0, sire: 0, dam: 0, bms: 0, sireSire: 0, owner: 0, breeder: 0, other: 0 };
  let changed = 0;
  for (const race of doc.races ?? []) {
    for (const r of race.runners ?? []) {
      const name = r.horse?.name;
      const p = prof.get(name);
      if (!p || p.missing) continue;
      let touched = false;
      const set = (k, v, counter) => {
        if (v == null || v === "" || r[k] === v) return;
        if (r[k] != null && !FORCE) return; // 已有值不动
        r[k] = v;
        stat[counter]++;
        touched = true;
      };
      set("sex", p.sex, "sex");
      set("age", ageAt(p.birth, doc.date), "age");
      set("sire", p.sire ? { id: null, name: p.sire } : null, "sire");
      set("dam", p.dam ? { id: null, name: p.dam } : null, "dam");
      set("bms", p.bms ? { id: null, name: p.bms } : null, "bms");
      set("sireSire", p.sireSire ? { id: null, name: p.sireSire } : null, "sireSire");
      set("owner", p.owner ? { id: null, name: p.owner } : null, "owner");
      set("breeder", p.breeder ? { id: null, name: p.breeder } : null, "breeder");
      // 三代附加血统挂在源命名空间下（前端暂不展示，供后续筛选直接用）
      if (p.damDam || p.sireDam || p.bmsSire) {
        const br = (r.tol ??= {});
        const ped = (br.ped3 ??= {});
        for (const [k, v] of [["damDam", p.damDam], ["sireDam", p.sireDam], ["bmsSire", p.bmsSire]]) {
          if (v && !ped[k]) {
            ped[k] = v;
            stat.other++;
            touched = true;
          }
        }
      }
      if (p.id?.startsWith("0.") && !r.horse.country) {
        r.horse.country = "BR";
        touched = true;
      }
      if (p.registro && !r.horse?.abcpcc) {
        r.horse.abcpcc = p.registro;
        touched = true;
      }
      if (touched) changed++;
    }
  }
  return { changed, ...stat };
}

// ---------- 主流程 ----------
async function main() {
  const files = targetFiles();
  console.log(`[backfill-bra-ped] 目标 ${files.length} 个卡片文件（cache: ${path.relative(process.cwd(), cacheDir)}）`);
  if (!files.length) return;

  const docs = files.map(({ day, file }) => ({ day, file, doc: readDoc(file) }));
  // 名字 → 比赛年份（同名不同马裁决用：取该马出现的最新年份）
  const names = new Map();
  for (const { doc } of docs) {
    for (const race of doc.races ?? []) {
      for (const r of race.runners ?? []) {
        const n = r.horse?.name;
        if (!n) continue;
        const y = yearOf(doc.date);
        if (!names.has(n) || (y && y > names.get(n))) names.set(n, y);
      }
    }
  }
  console.log(`[backfill-bra-ped] 唯一马名 ${names.size} 匹`);
  const prof = await fetchAll(new Set(names.keys()), names);

  let hit = 0;
  for (const [n, p] of prof) if (p && !p.missing) hit++;
  const totals = { files: 0, changed: 0, sex: 0, age: 0, sire: 0, dam: 0, bms: 0, sireSire: 0, owner: 0, breeder: 0 };
  const missed = [];
  for (const [n, p] of prof) if (!p || p.missing) missed.push(n);

  for (const { day, file, doc } of docs) {
    const stat = patch(doc, prof);
    if (stat.changed) {
      if (!DRY) fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 }));
      totals.files++;
      console.log(
        `${day}/${path.basename(file)}: 马 ${stat.changed} 匹｜性 ${stat.sex} 龄 ${stat.age} 父 ${stat.sire} 母 ${stat.dam} 母父 ${stat.bms} 父父 ${stat.sireSire} 主 ${stat.owner}`
      );
    }
    for (const k of Object.keys(totals)) if (k !== "files" && k !== "changed") totals[k] += stat[k] ?? 0;
    totals.changed += stat.changed;
  }

  console.log(
    `\n[backfill-bra-ped] ${DRY ? "（dry-run，未写盘）" : ""}命中 ${hit}/${names.size}（未收录 ${missed.length}）｜` +
      `改动 ${totals.files} 文件 / ${totals.changed} 行：` +
      `性 ${totals.sex} · 龄 ${totals.age} · 父 ${totals.sire} · 母 ${totals.dam} · 母父 ${totals.bms} · 父父 ${totals.sireSire} · 主 ${totals.owner}`
  );
  if (missed.length) console.log(`未收录马名（Stud Book 查无此名，可人工核对）：\n  ${missed.slice(0, 40).join(" / ")}`);
}

main();
