// 同名异马巡检：node src/audit-homonym.js [--fix] [--top 20]
//
// 三张表（只读，--fix 才写盘）：
//   ① 本方同名   —— 同一写法对应多个源内 id（两匹不同的 Thunder Bay）。身份层没问题，
//                   但任何「按名字合并」的逻辑都会串，需要时有据可查。
//   ② 血统名同名候选 —— 缓存里 ambiguous 的记录（多候选按「種+年龄」挑，或直接采信现役种公马
//                   缓存没搜过）且海外真的在用、且尚未裁决。这是人工裁决的候选池。
//   ③ 已裁决错绑 —— 裁决表命中、行内还挂着 JBIS 祖父的行；--fix 置 null。
//
// 裁决表 data/pedigree/homonym.json 由人维护；本脚本只负责排队与清账。
// 调参：--top N 每张表显示条数（默认 20）；--all 显示全部。
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { loadHomonym } from "./lib/homonym.js";
import { answerOf, sexInvalidAsSire, sireAnswerOf } from "./lib/horse-lookup.js";
import { normalizeHorseName } from "./lib/horse-name.mjs";
import { recordClears } from "./lib/clears.js";

const argv = process.argv.slice(2);
const FIX = argv.includes("--fix");
const ALL = argv.includes("--all");
const TOP = ALL ? Infinity : Number(argv[argv.indexOf("--top") + 1]) || 20;
const DATA = path.resolve("data");

const homonym = loadHomonym();
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

// 名字 → JBIS id 的「归属」表（口径同 build.js buildAliasDict）
const alias = new Map();
const addAlias = (name, id) => {
  const k = normalizeHorseName(name);
  if (k && id && !alias.has(k)) alias.set(k, id);
};
const lookupRaw = readJson(path.join(DATA, "pedigree", "name-lookup.json")) ?? {};
for (const rec of Object.values(lookupRaw)) {
  const a = answerOf(rec);
  if (!a?.id) continue;
  addAlias(rec.name, a.id);
  addAlias(a.name, a.id);
}
for (const rec of Object.values(readJson(path.join(DATA, "pedigree", "jbis-sire.json")) ?? {})) {
  addAlias(rec.name, rec.id);
  addAlias(rec.nameEn, rec.id);
}

const isJp = (scope) => scope === "central" || scope === "local";
const JP_VENUES = /^(東京|京都|阪神|中山|新潟|小倉|福島|札幌|函館|大井|川崎|船橋|浦和|名古屋|園田|笠松|門別|高知|佐賀|金沢|水沢|盛岡|帯広)/;

// 名字 → 缓存记录（判断「父位能不能用」）
const recByKey = new Map();
for (const [k, rec] of Object.entries(lookupRaw)) recByKey.set(normalizeHorseName(k), rec);

// ---------- 扫描 ----------
const runnerNames = new Map(); // norm → Map(id → { name, scopes:Set, dates:Set })
const intlSireNames = new Map(); // norm → { name, rows, venues:Set, sireSire:Set, examples:[] }
const wrongBinds = [];

const RACES = path.join(DATA, "races");
const dates = fs.existsSync(RACES) ? fs.readdirSync(RACES).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort() : [];

for (const date of dates) {
  for (const f of fs.readdirSync(path.join(RACES, date))) {
    if (!/\.json(\.gz)?$/.test(f)) continue;
    const file = path.join(RACES, date, f);
    let doc;
    try {
      doc = JSON.parse(readGz(file));
    } catch {
      continue;
    }
    const jp = isJp(doc.scope);
    for (const [ri, race] of (doc.races ?? []).entries()) {
      for (const [ni, r] of (race.runners ?? []).entries()) {
        const name = r.horse?.name;
        if (name) {
          const k = normalizeHorseName(name);
          const id = r.horse?.id ?? `${doc.scope}:${k}`;
          const m = runnerNames.get(k) ?? new Map();
          const e = m.get(id) ?? { name, scopes: new Set(), dates: new Set() };
          e.scopes.add(doc.scope);
          e.dates.add(date);
          m.set(id, e);
          runnerNames.set(k, m);
        }
        if (jp) continue; // 以下只看海外行
        for (const key of ["sire", "bms"]) {
          const s = r[key];
          if (!s?.name) continue;
          const k = normalizeHorseName(s.name);
          if (!alias.has(k)) continue; // JBIS 无归属 → 不存在同名歧义
          const e = intlSireNames.get(k) ?? { name: s.name, rows: 0, venues: new Set(), sireSire: new Set(), examples: [] };
          e.rows++;
          e.venues.add(doc.venue);
          if (r.sireSire?.name) e.sireSire.add(r.sireSire.name);
          if (e.examples.length < 3) e.examples.push(r.horse?.name);
          intlSireNames.set(k, e);
        }
        if (r.sire?.name && r.sireSire?.id) {
          const sireKey = normalizeHorseName(r.sire.name);
          const rec = recByKey.get(sireKey) ?? null;
          const reason = homonym.blockedForIntl(r.sire.name)
            ? "同名异马"
            : sexInvalidAsSire(rec, true)
              ? `性别矛盾（${answerOf(rec, true)?.sex}）`
              : null;
          if (reason) {
            wrongBinds.push({ file, date, venue: doc.venue, race: race.no, ri, ni, runner: r, sire: r.sire.name, sireSire: `${r.sireSire.name}(${r.sireSire.id})`, reason });
          }
        }
      }
    }
  }
}

// ---------- ① 本方同名 ----------
const sameName = [...runnerNames].filter(([, m]) => m.size > 1);
console.log(`\n■ ① 同名赛马（同一写法 / 多个源内 id）：${sameName.length} 组`);
console.log(`  信息项：前端从不按马名合并（马名只有自由文本搜索，行 key 用 horseId），所以这些不影响 UI；`);
console.log(`  将来若加「按马名分组」才需要改成 horseId canonical。`);
for (const [, m] of sameName.slice(0, TOP)) {
  const parts = [...m].map(([id, e]) => `${id} [${[...e.scopes].join("/")}] ${e.dates.size}日`);
  console.log(`  ${[...m.values()][0].name}  →  ${parts.join("  |  ")}`);
}

// ---------- ② 血统名同名候选 ----------
// 只列「答案没有唯一证据」的记录（v2 的 ambiguous + 未被裁决），且这个名字在海外文档里真的当过父/母父
const ambiguous = new Map();
for (const [k, rec] of Object.entries(lookupRaw)) {
  if (rec?.ambiguous && answerOf(rec)) ambiguous.set(normalizeHorseName(k), rec);
}
const cands = [...intlSireNames]
  .map(([k, e]) => ({ k, e, rec: ambiguous.get(k) }))
  // 已被性别否掉的（牝/セ）不用人看：那是自动拦截的确定错绑，不是「需要裁决的歧义」
  .filter((x) => x.rec && !homonym.get(x.k) && !sexInvalidAsSire(x.rec, true))
  .sort((a, b) => b.e.rows - a.e.rows || a.k.localeCompare(b.k));
const jpNameRe = /\(JPN\)|^[ぁ-んァ-ヶ一-龥]/;
const suspicious = ({ rec, e }) => jpNameRe.test(answerOf(rec)?.name ?? "") && [...e.venues].every((v) => !JP_VENUES.test(v));
const nSuspicious = cands.filter(suspicious).length;
console.log(`\n■ ② 血统名同名候选（缓存 ambiguous + 海外在用、尚未裁决）：${cands.length} 个，其中「日本马名被用在海外行」${nSuspicious} 个（优先看这些）`);
console.log(`  （量大的多为在日配种/进口的海外种公马后代，属正常；看的是 Silver State 这类真同名）`);
for (const x of cands.slice(0, TOP)) {
  const a = answerOf(x.rec);
  const others = (x.rec.candidates ?? []).filter((c) => c.id !== a.id).map((c) => `${c.name ?? "?"}${c.birth ? "/" + c.birth : ""}`);
  console.log(
    `  ${x.e.name}  → 选中 ${a.name ?? "?"}(${a.id}) [${x.rec.via}]${suspicious(x) ? " ⚠" : ""}  海外行数=${x.e.rows} 场=${[...x.e.venues].slice(0, 3).join(",")}`
  );
  if (others.length) console.log(`      其它同名候选：${others.slice(0, 5).join(" / ")}`);
}

// ---------- ③ 已判定错绑 ----------
const byReason = wrongBinds.reduce((m, w) => ((m[w.reason] = (m[w.reason] ?? 0) + 1), m), {});
console.log(
  `\n■ ③ 已判定错绑（祖父挂在不可能/已裁决的父上）：${wrongBinds.length} 行` +
    (wrongBinds.length ? `（${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(" / ")}）` : "")
);
for (const w of wrongBinds.slice(0, FIX ? Infinity : TOP)) {
  console.log(`  ${w.date} ${w.venue} R${w.race} ${w.runner.num ?? "?"}番 ${w.runner.horse?.name}  父=${w.sire} 祖父=${w.sireSire}  [${w.reason}]`);
}

// ---------- ④ 缓存结构体检 ----------
const recs = Object.values(lookupRaw);
const withIntl = recs.filter((r) => r.answers && "intl" in r.answers);
const unknownSchema = recs.filter((r) => r.schema !== "ped.lookup.jbis/v2");
console.log(
  `\n■ ④ 缓存体检：${recs.length} 条记录 / v2 ${recs.length - unknownSchema.length} / 未迁移 ${unknownSchema.length}` +
    ` / 有 intl 覆盖 ${withIntl.length}（${withIntl.map((r) => `${r.key}=${JSON.stringify(r.answers.intl === null ? "null" : r.answers.intl?.id)}`).join(", ") || "—"}）` +
    ` / 裁决 ${homonym.size()} 个写法`
);
if (unknownSchema.length) console.log(`  未迁移记录可用 node src/migrate-lookup-v2.js 升级`);

if (!FIX) {
  if (wrongBinds.length) console.log(`\n运行 node src/audit-homonym.js --fix 可清掉 ③ 的祖父绑定（只把 sireSire 置 null，不动其它字段）`);
  process.exit(0);
}

// ---------- --fix：清掉已裁决的错绑 ----------
// 用「场次下标 + 马番下标」定位（重新 parse 后的对象引用不等于扫描时的对象），落盘前再核一次身份
const byFile = new Map();
for (const w of wrongBinds) {
  const arr = byFile.get(w.file) ?? [];
  arr.push(w);
  byFile.set(w.file, arr);
}
let fixed = 0;
for (const [file, list] of byFile) {
  const doc = JSON.parse(readGz(file));
  for (const w of list) {
    const r = doc.races?.[w.ri]?.runners?.[w.ni];
    if (!r || r.horse?.name !== w.runner.horse?.name || r.sire?.name !== w.sire) continue;
    if (!r.sireSire) continue;
    r.sireSire = null;
    // 登记「故意清空」：审计恢复逻辑不会把这条错绑再填回来
    const race = doc.races?.[w.ri];
    recordClears([
      {
        key: `${file}|rk:${race?.raceKey ?? race?.no}|h:${r.horse?.id ?? r.num}`,
        field: "sireSire",
        reason: w.reason,
      },
    ]);
    fixed++;
  }
  writeGz(file.replace(/\.gz$/, ""), JSON.stringify(doc));
}
console.log(`\n[fix] 清除 ${fixed} 行的错误祖父绑定（涉及 ${byFile.size} 份文档），已记入 data/clears.json`);
