// 站点构建（docs/DESIGN.md §5、§6）
// site/ + data/races → _site；生成派生 JSON（derived/，字典包）与每周 Excel（excel/）
import fs from "node:fs";
import path from "node:path";
import { buildXlsx } from "./lib/xlsx.js";
import { readGz } from "./lib/bundle.js";
import { assertRoundTrip, packRows, unpackRows } from "./lib/rows-codec.mjs";
import { normalizeHorseName } from "./lib/horse-name.mjs";
import { countryGroupOf, LEVELS, TRACK_CENTRAL, TRACK_LOCAL, klassToLevel, scopeOfVenue } from "./race-config.js";

// CLI 覆盖（fixture/测试用）：node src/build.js --data-dir <dir> --out-dir <dir>
const optVal = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : null;
};
const DATA_DIR = path.resolve(optVal("--data-dir") ?? path.join("data", "races"));
const SITE_DIR = path.resolve("site");
const OUT_DIR = path.resolve(optVal("--out-dir") ?? "_site");
const DERIVED = path.join(OUT_DIR, "derived");
const XL_DIR = path.join(OUT_DIR, "excel");

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

function weekdayOf(date) {
  return WEEKDAY[new Date(date + "T00:00:00Z").getUTCDay()];
}

// 源标识：canonical race.card/v2 带 source id；JBIS 旧卡片（v1）的 source 字段是 URL → 视为 jbis
function sourceOf(doc) {
  const s = doc.source;
  return s && !String(s).includes("/") ? s : "jbis";
}

function isoWeek(date) {
  const d = new Date(date + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  const thu = new Date(d);
  thu.setUTCDate(d.getUTCDate() - day + 3);
  const week = 1 + Math.round((thu - new Date(Date.UTC(thu.getUTCFullYear(), 0, 1))) / 604800000);
  return { key: `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}` };
}

function readJson(file) {
  // 源文档支持 .json（旧）与 .json.gz（压缩落盘）
  return JSON.parse(file.endsWith(".gz") ? readGz(file) : fs.readFileSync(file, "utf8"));
}

// 场地口径：日本源按场馆名单 → JRA/NAR；海外源（racingpost）→ 国家组码（GB/IRE/FR/USA…）
function scopeOfDoc(doc) {
  return sourceOf(doc) === "racingpost" ? countryGroupOf(doc.country) : scopeOfVenue(doc.venue);
}

function listDates() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
}

const docFilesOf = (date) =>
  fs
    .readdirSync(path.join(DATA_DIR, date))
    .filter((f) => f.endsWith(".json") || f.endsWith(".json.gz"))
    .filter((f) => f !== "manifest.json")
    .sort();

// 单条出馬 → 扁平行（页面表格与 Excel 共用）
// 时区：canonical race.card/v2 带 startTimeTz/startTimeInstant；JBIS 旧卡片无该字段，
//       按 JST（+09:00）缺省补齐 —— 两口径（展示/场地）对 JBIS 一致。
function rowOf(doc, race, r) {
  const [y, m, d] = doc.date.split("-");
  const instant =
    race.startTimeInstant ??
    (race.startTime && /^\d{1,2}:\d{2}$/.test(race.startTime) ? `${doc.date}T${race.startTime}:00+09:00` : null);
  return {
    date: doc.date,
    weekday: weekdayOf(doc.date),
    scope: scopeOfDoc(doc),
    level: klassToLevel(race.klass),
    source: sourceOf(doc),
    country: doc.country ?? (doc.scope === "central" || doc.scope === "local" ? "JPN" : null),
    track: doc.track,
    venue: doc.venue,
    raceNo: race.no,
    startTime: race.startTime,
    startTimeTz: race.startTimeTz ?? "Asia/Tokyo",
    startTimeInstant: instant,
    raceName: race.name,
    klass: race.klass,
    klassGroup: race.klassGroup,
    grade: race.gradeTag,
    surface: race.surface,
    distance: race.distance,
    heads: race.heads,
    frame: r.frame,
    num: r.num,
    horseId: r.horse?.id ?? null,
    horseName: r.horse?.name ?? null,
    sex: r.sex,
    age: r.age,
    color: r.color,
    jockey: r.jockey?.name ?? null,
    weight: r.weight,
    trainer: r.trainer?.name ?? null,
    belongs: r.belongs,
    owner: r.owner?.name ?? null,
    breeder: r.breeder?.name ?? null,
    sire: r.sire?.name ?? null,
    sireSire: r.sireSire?.name ?? null,
    dam: r.dam?.name ?? null,
    bms: r.bms?.name ?? null,
    raceKey: race.raceKey,
    // 比赛页链接：RP = Sporting Life racecard（raceKey 即 race id，假 slug 可用）；JBIS = 场馆日历页
    raceUrl:
      sourceOf(doc) === "racingpost" && /^\d+$/.test(String(race.raceKey))
        ? `https://www.sportinglife.com/racing/racecards/${doc.date}/x/racecard/${race.raceKey}/x`
        : (doc.source ?? null),
    // 前走预渲染为文本（UI 已不用逐场对象；字典包里字符串远小于对象数组，且仅 Excel 消费）
    recent1: recentText(r.recent?.[0]) || null,
    recent2: recentText(r.recent?.[1]) || null,
    recent3: recentText(r.recent?.[2]) || null,
    dateLabel: `${m}-${d}`,
  };
}

function recentText(x) {
  if (!x) return "";
  const course = x.surface ? `${x.surface}${x.distance ?? ""}${x.going ?? ""}` : "";
  const t = [x.time, x.margin != null ? `（${x.margin}）` : ""].join("");
  return [x.date, x.venue, x.raceName, course, t, x.rank].filter(Boolean).join(" ");
}

// ---------- 复制静态资源 ----------
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.cpSync(SITE_DIR, OUT_DIR, { recursive: true });
// 字典包编解码模块复制进站点（app.js 以 type=module import；单一出处见 src/lib/rows-codec.mjs）
fs.copyFileSync(path.resolve("src", "lib", "rows-codec.mjs"), path.join(OUT_DIR, "codec.mjs"));
// 马名规范化模块同样复制进站点（app.js 下拉合并/搜索用）
fs.copyFileSync(path.resolve("src", "lib", "horse-name.mjs"), path.join(OUT_DIR, "horse-name.mjs"));
// 原始快照随站点发布（血统缓存除外）
if (fs.existsSync(DATA_DIR)) {
  fs.cpSync(DATA_DIR, path.join(OUT_DIR, "data", "races"), { recursive: true });
}

fs.mkdirSync(DERIVED, { recursive: true });

const index = {
  schema: "jbis.race.index/v1",
  generatedAt: new Date().toISOString(),
  dates: [],
  weeks: [],
  venues: [],
  levels: [],
  tracks: { central: TRACK_CENTRAL, local: TRACK_LOCAL },
};
const venueMap = new Map();
const klassMap = new Map();
const weekMap = new Map();

// ---------- 马名别名（canonical 合并） ----------
// canonical = JBIS id（有则）否则归一化名自身；展示名 = 当前行内出现最多的原始写法（原形保留）。
// 数据源：data/pedigree/name-lookup.json（RP 名→JBIS id）+ jbis-sire/jbis-horse 缓存
// （rec.name 出馬表表记 / rec.nameEn 官方英文名 / 各血统引用 {id,name}）。
// 同名异马冲突（同名老马 vs 现役种公马）按优先级解决：
//   3 = jbis-sire.json 键（出馬表里当过「父」= 现役种公马） > 2 = lookup 命中「種」标签 > 1 = 其它；
// 同分先到先得并记日志。
function buildAliasDict(nameCounts) {
  const claims = new Map(); // 归一化名 → [{canon, prio, src}]
  let conflicts = 0;
  const conflictNotes = [];
  const readJson = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };

  const pedDir = path.resolve("data", "pedigree");
  const lookup = readJson(path.join(pedDir, "name-lookup.json")) ?? {};
  const jbisSire = readJson(path.join(pedDir, "jbis-sire.json")) ?? {};
  const jbisHorse = readJson(path.join(pedDir, "jbis-horse.json")) ?? {};
  const activeSires = new Set(Object.keys(jbisSire)); // 出馬表里当过「父」的 id = 现役种公马
  const prioOf = (canon, base) => (activeSires.has(canon) ? 3 : base);
  const addClaim = (raw, canon, prio, src) => {
    const k = normalizeHorseName(raw);
    if (!k || !canon) return;
    if (!claims.has(k)) claims.set(k, []);
    const arr = claims.get(k);
    if (arr.some((c) => c.canon === canon)) return;
    arr.push({ canon, prio, src });
  };

  for (const rec of Object.values(lookup)) {
    if (!rec.resolvedId) continue;
    const base = rec.stallion ? 2 : 1;
    if (rec.name) addClaim(rec.name, rec.resolvedId, prioOf(rec.resolvedId, base), "lookup");
    if (rec.resolvedName) addClaim(rec.resolvedName, rec.resolvedId, prioOf(rec.resolvedId, base), "lookup");
    if (rec.sire?.name && rec.sire?.id) addClaim(rec.sire.name, rec.sire.id, prioOf(rec.sire.id, 1), "lookup.sire");
  }
  for (const rec of Object.values(jbisSire)) {
    if (rec.name && rec.id) addClaim(rec.name, rec.id, 3, "sire");
    if (rec.nameEn && rec.id) addClaim(rec.nameEn, rec.id, 3, "sire.nameEn");
    if (rec.sire?.name && rec.sire?.id) addClaim(rec.sire.name, rec.sire.id, prioOf(rec.sire.id, 1), "sire.sire");
  }
  for (const rec of Object.values(jbisHorse)) {
    if (rec.name && rec.id) addClaim(rec.name, rec.id, prioOf(rec.id, 1), "horse");
    if (rec.nameEn && rec.id) addClaim(rec.nameEn, rec.id, prioOf(rec.id, 1), "horse.nameEn");
    for (const k of ["sire", "sireSire", "sireDam", "dam", "damSire", "damDam"]) {
      if (rec[k]?.name && rec[k]?.id) addClaim(rec[k].name, rec[k].id, prioOf(rec[k].id, 1), `horse.${k}`);
    }
  }

  const alias = new Map(); // 归一化名 → canonical
  for (const [k, arr] of claims) {
    arr.sort((a, b) => b.prio - a.prio); // 稳定排序：同分保持先到先得
    alias.set(k, arr[0].canon);
    const losers = arr.filter((c) => c.canon !== arr[0].canon);
    if (losers.length) {
      conflicts++;
      conflictNotes.push(
        `${k}: ${arr[0].canon}(${arr[0].src}) 胜 ${losers.map((l) => `${l.canon}(${l.src})`).join(", ")}`
      );
    }
  }

  // 行内写法计数：展示名依据 + 未入库名字的 canonical 兜底（同名异写至少归一化合并）
  const forms = new Map(); // canonical → Map(原始写法 → 行数)
  for (const [raw, n] of nameCounts) {
    const k = normalizeHorseName(raw);
    const canon = alias.get(k) ?? k;
    if (!alias.has(k)) alias.set(k, canon);
    const fm = forms.get(canon) ?? new Map();
    fm.set(raw, (fm.get(raw) ?? 0) + n);
    forms.set(canon, fm);
  }
  const display = {};
  for (const [canon, fm] of forms) {
    display[canon] = [...fm.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))[0][0];
  }
  if (conflictNotes.length) console.log(`[alias] 同名异马冲突 ${conflicts} 处（现役种公马优先）:\n  ${conflictNotes.join("\n  ")}`);
  return {
    schema: "horse.aliases/v1",
    generatedAt: new Date().toISOString(),
    alias: Object.fromEntries([...alias].sort()),
    display,
  };
}

const nameCounts = new Map();
const countPedNames = (rows) => {
  for (const r of rows)
    for (const k of ["sire", "sireSire", "bms"]) {
      const v = r[k];
      if (v) nameCounts.set(v, (nameCounts.get(v) ?? 0) + 1);
    }
};

for (const date of listDates()) {
  const files = docFilesOf(date);

  const rows = [];
  const tracks = [];
  for (const f of files) {
    const doc = readJson(path.join(DATA_DIR, date, f));
    tracks.push({
      source: sourceOf(doc),
      country: doc.country ?? null,
      track: doc.track,
      venue: doc.venue,
      scope: scopeOfDoc(doc),
      races: doc.races.filter((r) => r.runners?.length).length,
      runners: doc.races.reduce((n, r) => n + (r.runners?.length ?? 0), 0),
      pending: doc.races.filter((r) => r.status === "pending").length,
    });
    for (const race of doc.races) for (const r of race.runners ?? []) rows.push(rowOf(doc, race, r));
    venueMap.set(`${sourceOf(doc)}:${doc.track}`, {
      source: sourceOf(doc),
      country: doc.country ?? null,
      track: doc.track,
      venue: doc.venue,
      scope: scopeOfDoc(doc),
    });
  }
  if (!rows.length) continue;

  for (const r of rows) klassMap.set(r.level, (klassMap.get(r.level) ?? 0) + 1);
  countPedNames(rows);

  rows.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.track.localeCompare(b.track) ||
      a.raceNo - b.raceNo ||
      (a.num ?? 99) - (b.num ?? 99)
  );

  const label = `${date.slice(5, 7)}-${date.slice(8, 10)}`;
  const bundle = packRows(rows);
  assertRoundTrip(rows, bundle);   // 打包↔解包同构断言，漂移即 build 失败
  fs.writeFileSync(
    path.join(DERIVED, `${date}.json`),
    JSON.stringify({ schema: "jbis.race.rows.bundle/v1", date, weekday: weekdayOf(date), label, tracks, total: rows.length, ...bundle })
  );

  index.dates.push({
    date,
    weekday: weekdayOf(date),
    label,
    races: tracks.reduce((n, t) => n + t.races, 0),
    runners: rows.length,
    tracks,
  });

  const wk = isoWeek(date).key;
  if (!weekMap.has(wk)) weekMap.set(wk, { key: wk, dates: [] });
  weekMap.get(wk).dates.push(date);
}

index.venues = [...venueMap.values()].sort((a, b) => a.track.localeCompare(b.track));
index.sources = [...new Set(index.venues.map((v) => v.source))].sort();
index.levels = LEVELS.map((level) => ({ level, count: klassMap.get(level) ?? 0 }));

// ---------- 马名别名字典落盘（前端下拉/分组合并 + Excel 透视共用） ----------
const aliasDict = buildAliasDict(nameCounts);
const canonOf = (raw) => aliasDict.alias[normalizeHorseName(raw)] ?? normalizeHorseName(raw);
const displayOf = (canon) => aliasDict.display[canon] ?? canon;
fs.writeFileSync(path.join(DERIVED, "horse-aliases.json"), JSON.stringify(aliasDict));
console.log(`[alias] ${Object.keys(aliasDict.alias).length} 别名 / ${Object.keys(aliasDict.display).length} canonical → derived/horse-aliases.json`);

// ---------- 每周 Excel ----------
const COLS = [
  "日付", "曜日", "区分", "場", "R", "発走", "レース名", "比赛格", "分组",
  "芝ダ", "距離", "頭数", "枠", "馬番", "馬名", "性齢", "毛色",
  "騎手", "斤量", "調教師", "所属", "馬主", "生産牧場",
  "父", "父父", "母", "母父",
  "前走", "前走2", "前走3",
  "源", "発走(基準時刻)",
];
const WIDTHS = [
  11, 5, 6, 6, 4, 6, 22, 8, 6,
  5, 7, 6, 5, 5, 18, 6, 6,
  10, 6, 10, 6, 14, 14,
  14, 14, 14, 14,
  46, 46, 46,
  10, 20,
];

const scopeLabel = (s) => (s === "JRA" ? "JRA" : s === "NAR" ? "NAR" : s || "海外");
const instantOffset = (iso) => (iso ? iso.slice(-6) : ""); // "+01:00"

function pivot(rows, key, label) {
  const m = new Map();
  for (const r of rows) {
    const raw = r[key];
    if (!raw) continue;
    const k = canonOf(raw); // 同一匹马的不同写法（JBIS 片假名/国码表记 vs RP 英文名）合并统计
    const e = m.get(k) ?? { name: displayOf(k), runners: 0, races: new Set(), jra: 0, nar: 0, overseas: 0 };
    e.runners++;
    e.races.add(`${r.date}/${r.track}/${r.raceNo}`);
    if (r.scope === "JRA") e.jra++;
    else if (r.scope === "NAR") e.nar++;
    else e.overseas++;
    m.set(k, e);
  }
  return {
    name: label,
    rows: [
      ["名称", "出走頭数", "レース数", "JRA", "NAR", "海外"],
      ...[...m.values()]
        .sort((a, b) => b.runners - a.runners || a.name.localeCompare(b.name))
        .map((e) => [e.name, e.runners, e.races.size, e.jra, e.nar, e.overseas]),
    ],
    widths: [26, 10, 10, 8, 8, 8],
  };
}

fs.mkdirSync(XL_DIR, { recursive: true });
const weeks = [];

for (const w of [...weekMap.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const rows = w.dates.flatMap((d) => {
    const j = readJson(path.join(DERIVED, `${d}.json`));
    return j.v === 1 ? unpackRows(j) : j.rows;   // v1 = 字典包；否则旧版明文 rows
  });
  if (!rows.length) continue;

  const body = rows.map((r) => [
    r.date, r.weekday, scopeLabel(r.scope), r.venue, r.raceNo, r.startTime,
    r.raceName, r.klass, r.klassGroup, r.surface, r.distance, r.heads, r.frame, r.num,
    r.horseName, `${r.sex ?? ""}${r.age ?? ""}`, r.color,
    r.jockey, r.weight, r.trainer, r.belongs, r.owner, r.breeder,
    r.sire, r.sireSire, r.dam, r.bms,
    r.recent1, r.recent2, r.recent3,
    r.source, r.startTime ? `${r.startTime} ${r.startTimeTz}${instantOffset(r.startTimeInstant) ? " " + instantOffset(r.startTimeInstant) : ""}` : "",
  ]);

  const buf = buildXlsx([
    { name: "出走馬", rows: [COLS, ...body], widths: WIDTHS },
    pivot(rows, "sire", "父集計"),
    pivot(rows, "sireSire", "父父集計"),
    pivot(rows, "bms", "母父集計"),
  ]);
  const file = `races-${w.key}.xlsx`;
  fs.writeFileSync(path.join(XL_DIR, file), buf);
  weeks.push({ key: w.key, dates: w.dates, file, runners: rows.length });
  console.log(`[xlsx] ${file} dates=${w.dates.join(",")} rows=${rows.length}`);
}

index.weeks = weeks;
fs.writeFileSync(path.join(DERIVED, "index.json"), JSON.stringify(index));
// GitHub Pages 项目站：禁用 Jekyll 处理（防下划线/特殊文件被吞），且全站均为相对路径，任意 base path 可用
fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "");
console.log(`[build] dates=${index.dates.length} rows=${index.dates.reduce((n, d) => n + d.runners, 0)} -> ${OUT_DIR}`);
