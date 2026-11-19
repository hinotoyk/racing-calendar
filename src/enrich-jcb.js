// JCB 官方节目 PDF 富化：给巴西 Gávea 卡片补「练马师 / 父 / 母 / 母父 / 性别 / 毛色 / 生日 / 繁育者 / 马主」
//
// 为什么只针对 Gávea：PDF 由 Jockey Club Brasileiro 发布，只覆盖 Gávea 赛场（Cidade Jardim /
// Cristal / Tarumã 分别属 JCSP / JCPelotas 等，没有对应 PDF）。Cidade Jardim 等场次的
// 父/母/母父 由 src/backfill-bra-ped.js 走 ABCPCC 血统库补；练马师则暂无免费来源。
//
// 用法：
//   node src/enrich-jcb.js                    # 处理 data/races 下所有巴西 Gávea 赛日
//   node src/enrich-jcb.js --date 2026-11-17
//   node src/enrich-jcb.js --force            # 忽略 text 缓存，重新下载 PDF
//   node src/enrich-jcb.js --dry
// 幂等：只填缺失字段，不覆盖已有值（ABCPCC 血统树比 PDF 的单行更精确）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { programText, parsePrograma, byHorse } from "./lib/jcbpdf.mjs";
import { resolveAge } from "./lib/age.mjs";

const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const val = (k, d = null) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const DRY = has("dry");
const FORCE = has("force");
const ONLY_DATE = val("date");

const RACES = path.resolve("data", "races");
const key = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`´]/g, "'")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

// ---------- 找 Gávea 巴西卡片 ----------
function gaveaDocs() {
  const out = [];
  for (const day of fs.readdirSync(RACES).sort()) {
    if (ONLY_DATE && day !== ONLY_DATE) continue;
    const dir = path.join(RACES, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(".json.gz")) continue;
      const file = path.join(dir, f);
      const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
      if (doc.country !== "BRA") continue;
      if (!/gavea|gávea/i.test(`${doc.track ?? ""} ${doc.venue ?? ""}`)) continue;
      out.push({ day, file, doc });
    }
  }
  return out;
}

/** 海外场次没有「枠」制度：清掉适配器/旧版遗留的 mandil 号，避免被前端当枠色渲染 */
function stripFrame(doc) {
  let n = 0;
  if (doc.country === "JPN") return 0;
  for (const race of doc.races ?? []) {
    for (const r of race.runners ?? []) {
      if (r.frame != null) {
        r.frame = null;
        n++;
      }
    }
  }
  return n;
}

function patch(doc, map) {
  const stat = { matched: 0, trainer: 0, sire: 0, dam: 0, bms: 0, sex: 0, age: 0, color: 0, owner: 0, breeder: 0, jockey: 0 };
  let changed = 0;
  for (const race of doc.races ?? []) {
    for (const r of race.runners ?? []) {
      const e = map.get(key(r.horse?.name));
      if (!e) continue;
      stat.matched++;
      let touched = false;
      // 空值判定：null / "" / {id:null,name:null}（适配器的占位对象）都算空
      const empty = (v) => v == null || v === "" || (typeof v === "object" && (v.name == null || v.name === ""));
      const set = (k, v, c) => {
        if (v == null || v === "" || !empty(r[k]) || r[k] === v) return;
        r[k] = v;
        stat[c]++;
        touched = true;
      };
      // 练马师是本脚本的主目标；其余字段仅在 ABCPCC 未命中时兜底
      set("trainer", e.trainer ? { id: null, name: e.trainer } : null, "trainer");
      set("sire", e.sire ? { id: null, name: e.sire } : null, "sire");
      set("dam", e.dam ? { id: null, name: e.dam } : null, "dam");
      set("bms", e.bms ? { id: null, name: e.bms } : null, "bms");
      set("sex", e.sex, "sex");
      set("color", e.color, "color");
      set("owner", e.owner ? { id: null, name: e.owner } : null, "owner");
      set("breeder", e.breeder ? { id: null, name: e.breeder } : null, "breeder");
      // 年龄兜底推算：直印值（r.age）优先，没有才按出生年+巴西转岁月(7月1日)算
      set("age", resolveAge({ age: r.age, birth: e.birth, raceDate: doc.date, country: r.horse?.country, venueCountry: doc.country }), "age");
      if (touched) {
        // 来源留痕：便于回溯「这条练马师来自 JCB PDF」
        const jcb = (r.jcb ??= {});
        if (e.trainer && !jcb.trainerSource) jcb.trainerSource = "jcb-programa-pdf";
        changed++;
      }
    }
  }
  return { changed, ...stat };
}

async function main() {
  const docs = gaveaDocs();
  console.log(`[enrich-jcb] Gávea 卡片 ${docs.length} 个`);
  const byDate = new Map();
  for (const d of docs) {
    if (!byDate.has(d.day)) byDate.set(d.day, []);
    byDate.get(d.day).push(d);
  }
  const totals = { files: 0, changed: 0, matched: 0, trainer: 0, sire: 0, dam: 0, bms: 0, sex: 0, age: 0, color: 0, owner: 0 };
  for (const [day, list] of byDate) {
    const { text, why, cached } = await programText(day, { force: FORCE });
    if (!text) {
      console.log(`${day}: 无节目 PDF（${why}），跳过`);
      continue;
    }
    const entries = parsePrograma(text);
    const map = byHorse(entries);
    console.log(`${day}: PDF ${cached ? "缓存" : "新下载"} → 解析 ${entries.length} 匹（练马师 ${entries.filter((e) => e.trainer).length}）`);
    for (const { file, doc } of list) {
      const stripped = stripFrame(doc);
      if (stripped) console.log(`  ${path.basename(file)}: 清除海外伪枠番 ${stripped} 行`);
      const stat = patch(doc, map);
      stat.changed += stripped ? 0 : 0;
      if (stat.changed || stripped) {
        if (!DRY) fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 }));
        totals.files++;
        console.log(
          `  ${path.basename(file)}: 命中 ${stat.matched}/${doc.races.reduce((n, r) => n + r.runners.length, 0)} 匹｜` +
            `练马师 +${stat.trainer} 父 +${stat.sire} 母 +${stat.dam} 母父 +${stat.bms} 性 +${stat.sex} 龄 +${stat.age} 主 +${stat.owner}`
        );
      } else {
        console.log(`  ${path.basename(file)}: 命中 ${stat.matched} 匹，无需改动`);
      }
      for (const k of Object.keys(totals)) if (k !== "files" && k !== "changed" && k !== "matched") totals[k] += stat[k] ?? 0;
      totals.changed += stat.changed;
      totals.matched += stat.matched;
    }
  }
  console.log(
    `\n[enrich-jcb] ${DRY ? "（dry-run，未写盘）" : ""}改动 ${totals.files} 文件 / ${totals.changed} 行：` +
      `练马师 +${totals.trainer} · 父 +${totals.sire} · 母 +${totals.dam} · 母父 +${totals.bms} · 性 +${totals.sex} · 龄 +${totals.age} · 主 +${totals.owner}`
  );
}

main();
