// 合成测试数据生成器（fixture）：N 天 × 每天 races 场，写入 --out 目录（默认 .tmp-fixture/data/races）
//   node src/fixture.js --days 30 --races 500 --start 2026-10-22 --out .tmp-fixture/data/races
// 覆盖保证（每天）：
//   - 16 场馆（中央6 / 地方4 / 海外6）每馆 ≥1 场
//   - KLASS_ORDER 全部比赛格 ≥1 场（GⅠ-Ⅲ / Jpn / JG / L / OP / 1-3勝 / A1-C3 / Class 1-7 / 障害 / 特選 / 交流 / 一般 / 重賞 / 準重賞 / 障害未勝利 / 新馬 / 未勝利）
//   - 芝 / ダ（障害格 → 障）双表面；jbis(v1) 与 racingpost(v2) 双源；多时区（Europe/London / America/Toronto / America/Chicago）
// 数据为确定性伪随机（固定种子），重复运行产物一致。仅本地测试用。
import fs from "node:fs";
import path from "node:path";
import { KLASS_ORDER } from "./race-config.js";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const DAYS = Number(arg("--days", 30));
const RACES = Number(arg("--races", 500));
const START = arg("--start", "2026-10-22");
const OUT = path.resolve(arg("--out", path.join(".tmp-fixture", "data", "races")));

// ---------- 场馆 ----------
const VENUES = [
  { track: "101", venue: "札幌", scope: "central" },
  { track: "105", venue: "東京", scope: "central" },
  { track: "108", venue: "京都", scope: "central" },
  { track: "109", venue: "阪神", scope: "central" },
  { track: "210", venue: "新潟", scope: "central" },
  { track: "232", venue: "小倉", scope: "central" },
  { track: "301", venue: "門別", scope: "local", belongs: "門別" },
  { track: "302", venue: "園田", scope: "local", belongs: "園田" },
  { track: "303", venue: "高知", scope: "local", belongs: "高知" },
  { track: "304", venue: "佐賀", scope: "local", belongs: "佐賀" },
  { track: "CAR", venue: "Carlisle", scope: "overseas", country: "ENG", tz: "Europe/London", going: ["Good", "Good to Soft", "Soft", "Heavy"] },
  { track: "NMK", venue: "Newmarket", scope: "overseas", country: "ENG", tz: "Europe/London", going: ["Good", "Firm", "Good to Firm"] },
  { track: "FFL", venue: "Ffos Las", scope: "overseas", country: "Wale", tz: "Europe/London", going: ["Soft", "Heavy", "Good to Soft"] },
  { track: "CLO", venue: "Clonmel", scope: "overseas", country: "Eire", tz: "Europe/London", going: ["Yielding", "Soft", "Good"] },
  { track: "WO", venue: "Woodbine", scope: "overseas", country: "CAN", tz: "America/Toronto", going: ["Fast", "Sloppy", "Muddy"] },
  { track: "RPX", venue: "Remington Park", scope: "overseas", country: "USA", tz: "America/Chicago", going: ["Fast", "Muddy", "Sloppy"] },
];
// 城市时区偏移（fixture 期间 2026-10-22 … 11-20；DST 切换：EU 10-25 / 北美 11-01）
const tzOffset = (tz, date) => {
  if (tz === "Europe/London") return date < "2026-10-25" ? "+01:00" : "+00:00";
  if (tz === "America/Toronto") return date < "2026-11-01" ? "-04:00" : "-05:00";
  if (tz === "America/Chicago") return date < "2026-11-01" ? "-05:00" : "-06:00";
  return "+09:00";
};

const JUMP = new Set(["JGⅠ", "JGⅡ", "JGⅢ", "障害未勝利", "障害"]);
const GRADE = { "GⅠ": "G1", "GⅡ": "G2", "GⅢ": "G3", "JpnⅠ": "Jpn1", "JpnⅡ": "Jpn2", "JpnⅢ": "Jpn3", "JGⅠ": "JG1", "JGⅡ": "JG2", "JGⅢ": "JG3" };
const klassGroupOf = (k) =>
  GRADE[k] ? "重賞" : ["L", "OP"].includes(k) ? "特別" : JUMP.has(k) ? "障害" : ["Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6", "Class 7"].includes(k) ? "Class" : k;
const surfaceOf = (k, coin) => (JUMP.has(k) ? "障" : coin ? "ダ" : "芝");

// ---------- 名前プール（合成っぽい組み合わせ名） ----------
const JP1 = ["アオバ", "キタノ", "サクラ", "ダイオウ", "テスト", "ニジノ", "ハルカ", "ミドリ", "ユキノ", "オオゾラ"];
const JP2 = ["トライ", "ホシノ", "カチドキ", "ライデン", "フレーム", "サンデー", "ゴールド", "スターマ", "ワカバ", "ミツバ"];
const JP_F = ["マリー", "ヒメ", "コトブキ", "サティ", "リリー", "カンナ"];
const EN1 = ["Iron", "Silver", "Golden", "Storm", "River", "Night", "Star", "Blue", "Copper", "Winter"];
const EN2 = ["Dancer", "Runner", "Warrior", "Knight", "Spirit", "Arrow", "Emperor", "Legend", "Harbor", "Rocket"];
const OWNER_JP = ["（有）テスト牧場", "青山商事株式会社", "地平線組合", "冨澤研究室", "サンデー友の会", "（株）グリーンチャンネル"];
const OWNER_EN = ["Test Racing Club", "The Horizon Partnership", "Northwind Syndicate", "Aurora Stables Ltd", "Silverline Holdings"];
const BREEDER = ["岬牧場", "早来ファーム", "静内スタッド", "門別牧場", "青森ベイファーム", "日高テスト牧場"];
const JOCK_JP = ["田中一郎", "佐藤次郎", "鈴木三郎", "高橋四郎", "伊藤五郎", "渡辺六郎", "山本七子", "中村八郎", "小林九子", "加藤十郎"];
const JOCK_EN = ["D McMenamin", "P W Wadge", "T J O'Brien", "R L Moore", "H Skelton", "C Beasley", "J Power", "A Ryders"];
const TRAIN_JP = ["山田厩舎", "佐々木厩舎", "鈴木厩舎", "池江厩舎", "藤沢厩舎", "荒木厩舎"];
const TRAIN_EN = ["N G Richards", "A M Thomson", "J Parkinson", "M Walford", "G Bewley", "L Russell"];
const RACE_P = ["テスト", "アオバ", "ニジノ", "ハルカ", "ミドリ", "オリオン", "シリウス", "ペガサス"];
const RACE_S = ["ステークス", "記念", "特別", "カップ", "賞", "ハンデキャップ", "トロフィー", "マイルCS"];
const EN_RACE = ["Test Stakes", "Horizon Handicap", "Fixture Cup", "Silverline Sprint", "Winter Novices' Hurdle", "Arena Handicap Chase", "Moonlight Maiden", "Harbour Stakes"];
const COLOR = ["鹿毛", "栗毛", "黒鹿毛", "青鹿毛", "芦毛", "青毛"];

// ---------- 伪随机（确定性） ----------
let _s = 0x2f6e2b1;
const rnd = () => {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const jpName = () => pick(JP1) + pick(JP2);
const enName = () => `${pick(EN1)} ${pick(EN2)}`;

const addDays = (date, n) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const hm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ---------- runner / race 生成 ----------
function runnerOf(jbisLike, venue, idx, date) {
  const jp = jbisLike;
  const horse = jp ? jpName() : enName();
  const sex = pick(["牡", "牝", "セ"]);
  const age = rint(2, 9);
  const jockey = jp ? pick(JOCK_JP) : pick(JOCK_EN);
  const trainer = jp ? pick(TRAIN_JP) : pick(TRAIN_EN);
  const owner = jp ? pick(OWNER_JP) : pick(OWNER_EN);
  const sire = jp ? jpName() : enName();
  const sireSire = jp ? jpName() : enName();
  const dam = jp ? pick(JP2) + pick(JP_F) : `${pick(EN2)}'s ${pick(JP_F) === "ヒメ" ? "Princess" : pick(EN1)}`;
  const bms = jp ? jpName() : enName();
  const recent = [];
  const nRec = rint(0, 3);
  for (let k = 0; k < nRec; k++) {
    recent.push({
      rank: `${rint(1, 12)}着`,
      date: addDays(date, -7 * (k + 1) + rint(-2, 2)),
      venue: jp ? pick(VENUES.filter((v) => v.scope !== "overseas")).venue : pick(VENUES.filter((v) => v.scope === "overseas")).venue,
      raceName: jp ? pick(RACE_P) + pick(RACE_S) : pick(EN_RACE),
    });
  }
  if (jp) {
    return {
      frame: (idx % 8) + 1,
      num: idx + 1,
      horse: { id: String(1000000000 + rint(0, 999999999)).slice(0, 10), name: horse },
      sex, age, color: pick(COLOR),
      weight: rint(51, 62),
      jockey: { name: jockey },
      trainer: { name: trainer },
      owner: { name: owner },
      breeder: { name: pick(BREEDER) },
      belongs: venue.belongs ?? (venue.scope === "central" ? pick(["美浦", "栗東"]) : undefined),
      sire: { name: sire },
      sireSire: { name: sireSire },
      dam: { name: dam },
      bms: { name: bms },
      recent,
    };
  }
  return {
    num: idx + 1,
    frame: null,
    horse: { id: `rp:${rint(100000, 999999)}`, name: horse },
    sex, age,
    weight: Math.round((54.4 + rnd() * 21.8) * 10) / 10,
    weightRaw: `${rint(8, 11)}-${rint(0, 13)}`,
    jockey: { name: jockey },
    trainer: { name: trainer },
    owner: { name: owner },
    sire: { name: sire },
    dam: { name: dam },
    bms: { name: bms },
    recent,
    rp: { formsummary: `${rint(1, 12)}${pick(["F", "P", "U"])}${rint(1, 12)}`, lastRanDays: rint(7, 200), timeformStars: rint(0, 5), rating123: rint(60, 140), status: "declared", foaled: `${2026 - age}-0${rint(1, 9)}-15` },
  };
}

function raceOf(no, klass, venue, date, startMin) {
  const surface = surfaceOf(klass, rnd() < 0.45);
  const distance = surface === "障" ? pick([3000, 3200, 3400, 3600, 4000, 4400]) : surface === "ダ" ? pick([900, 1000, 1200, 1400, 1600, 1700, 1800, 2000, 2100]) : pick([1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2500, 3000, 3200, 3600]);
  const overseas = venue.scope === "overseas";
  const name = overseas ? `${pick(EN_RACE)} (${klass})` : `${pick(RACE_P)}${pick(RACE_S)}`;
  const heads = rint(8, 18);
  const runners = Array.from({ length: heads }, (_, i) => runnerOf(!overseas, venue, i, date));
  const raceKey = overseas ? String(91000000 + _seq++) : `${date}-${venue.track}-${no}`;
  const base = { no, name, klass, klassGroup: klassGroupOf(klass), surface, distance, heads, raceKey, runners };
  if (GRADE[klass]) base.gradeTag = GRADE[klass];
  if (overseas) {
    const tz = venue.tz;
    const off = tzOffset(tz, date);
    return { ...base, startTime: hm(startMin), startTimeTz: tz, startTimeInstant: `${date}T${hm(startMin)}:00${off}`, raceType: JUMP.has(klass) ? (rnd() < 0.5 ? "HURDLE" : "CHASE") : "FLAT", raceStage: "entries", status: "scheduled", runners };
  }
  return { ...base, startTime: hm(startMin), runners };
}

// ---------- 主流程 ----------
fs.rmSync(OUT, { recursive: true, force: true });
let totalRaces = 0;
let totalRunners = 0;
let _seq = 0;   // 海外场 raceKey 用数字 id（对齐 SL race id 形态 → build 可构造比赛页链接）
for (let d = 0; d < DAYS; d++) {
  const date = addDays(START, d);
  const dir = path.join(OUT, date);
  fs.mkdirSync(dir, { recursive: true });

  // 每天分配：各馆 base 场，前 (RACES % VENUES.length) 个馆 +1
  const per = Math.floor(RACES / VENUES.length);
  const extra = RACES % VENUES.length;

  VENUES.forEach((venue, vi) => {
    const n = per + (vi < extra ? 1 : 0);
    let startMin = 9 * 60 + 40 + vi * 5;
    const overseas = venue.scope === "overseas";
    const going = venue.going ? pick(venue.going) : undefined;

    // 该馆第 i 场的比赛格：KLASS_ORDER 轮转（vi 错位）→ 全馆并集每天覆盖全部比赛格
    const races = Array.from({ length: n }, (_, i) => {
      const klass = KLASS_ORDER[(vi * 3 + i) % KLASS_ORDER.length];
      const r = raceOf(i + 1, klass, venue, date, startMin);
      startMin += 17;
      totalRunners += r.heads;
      return r;
    });
    totalRaces += n;

    let doc;
    if (overseas) {
      doc = {
        schema: "race.card/v2",
        source: "racingpost",
        fetchLayer: "sportinglife.com",
        sourceKey: `rp:${venue.track}`,
        date, track: venue.track, venue: venue.venue,
        country: venue.country, countryLong: venue.country,
        scope: "overseas",
        timeZone: venue.tz, localTimeZone: venue.tz,
        going, surfaceRaw: going ? `Going: ${going}` : undefined,
        races,
      };
    } else {
      doc = {
        schema: "jbis.race.card/v1",
        date, track: venue.track, venue: venue.venue,
        scope: venue.scope, country: "JPN",
        source: `https://www.jbis.or.jp/race/calendar/${date.replaceAll("-", "")}/${venue.track}/`,
        races,
      };
    }
    const file = path.join(dir, `${overseas ? "rp-" : "jbis-"}${venue.track}.json`);
    fs.writeFileSync(file, JSON.stringify(doc));
  });
  console.log(`[fixture] ${date} ${RACES} races`);
}

fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify({ schema: "fixture/manifest/v1", generated: new Date().toISOString(), days: DAYS, racesPerDay: RACES, venues: VENUES.length, totalRaces, totalRunners }, null, 1),
);
console.log(`[fixture] done: ${DAYS} days × ${RACES} races = ${totalRaces} races / ${totalRunners} runners -> ${OUT}`);
