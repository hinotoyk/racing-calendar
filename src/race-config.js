// 出走表用的场地与「比赛格」定义（docs/RACES.md §3）

// 场代码 → [场名, 中央/地方]；未知代码按数值段推断
export const VENUES = {
  "101": ["札幌", "central"],
  "102": ["函館", "central"],
  "103": ["福島", "central"],
  "104": ["新潟", "central"],
  "105": ["東京", "central"],
  "106": ["中山", "central"],
  "107": ["中京", "central"],
  "108": ["京都", "central"],
  "109": ["阪神", "central"],
  "110": ["小倉", "central"],
  "210": ["盛岡", "local"],
  "211": ["水沢", "local"],
  "218": ["浦和", "local"],
  "219": ["船橋", "local"],
  "220": ["大井", "local"],
  "221": ["川崎", "local"],
  "222": ["金沢", "local"],
  "223": ["笠松", "local"],
  "224": ["名古屋", "local"],
  "226": ["姫路", "local"],
  "227": ["園田", "local"],
  "228": ["福山", "local"],
  "231": ["高知", "local"],
  "232": ["佐賀", "local"],
  "236": ["門別", "local"],
  "246": ["帯広", "local"],
};

export function venueName(code) {
  return VENUES[code]?.[0] ?? `場${code}`;
}
export function scopeOf(code) {
  return VENUES[code]?.[1] ?? (Number(code) < 200 ? "central" : "local");
}

const GRADE_LABEL = {
  G1: "GⅠ",
  G2: "GⅡ",
  G3: "GⅢ",
  Jpn1: "JpnⅠ",
  Jpn2: "JpnⅡ",
  Jpn3: "JpnⅢ",
  JG1: "JGⅠ",
  JG2: "JGⅡ",
  JG3: "JGⅢ",
  listed: "L",
  heavy: "重賞",
  sea: "海外",
};

const HEX = /[０-９]/g;
function normalize(s) {
  return String(s ?? "")
    .replace(HEX, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 48))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ⅠⅡⅢ]/g, (c) => ({ "Ⅰ": "1", "Ⅱ": "2", "Ⅲ": "3" }[c]))
    .replace(/\s+/g, " ")
    .trim();
}

// 比赛格归一：klass = 具体格（新馬/未勝利/1勝/2勝/3勝/OP/GⅠ/L/B2/特選…），group = 粗分组
export function klassOf({ name, gradeTag, scope }) {
  const n = normalize(name);

  if (gradeTag && GRADE_LABEL[gradeTag]) {
    const label = GRADE_LABEL[gradeTag];
    const isJump = /^JG/.test(gradeTag);
    return { klass: label, group: isJump ? "障害" : "重賞" };
  }

  if (/新馬/.test(n)) return { klass: "新馬", group: "新馬" };

  if (/未勝利/.test(n)) {
    return /障害/.test(n)
      ? { klass: "障害未勝利", group: "障害" }
      : { klass: "未勝利", group: "未勝利" };
  }

  const win = n.match(/([123])\s*勝クラス/);
  if (win) return { klass: `${win[1]}勝`, group: `${win[1]}勝` };

  if (/(^|\s)OP\b|オープン/.test(n)) return { klass: "OP", group: "OP" };
  if (/リステッド/.test(n)) return { klass: "L", group: "重賞" };
  if (/障害/.test(n)) return { klass: "障害", group: "障害" };
  if (/準重賞/.test(n)) return { klass: "準重賞", group: "重賞" };

  // 地方班别：A1/B2/C3 等（如 "実りの秋特別 B3イC1ア" 取首个班）
  const ban = n.match(/([ABC])\s*([123])/);
  if (ban) return { klass: `${ban[1]}${ban[2]}`, group: scope === "local" ? "一般" : "OP" };

  if (/特選/.test(n)) return { klass: "特選", group: "一般" };
  if (/中央認定|中央交流|交流/.test(n)) return { klass: "交流", group: "交流" };

  return { klass: "一般", group: "一般" };
}

// 展示顺序（fixture 造数据用：原始比赛格全集）
export const KLASS_ORDER = [
  "新馬", "未勝利", "1勝", "2勝", "3勝", "OP", "L", "GⅠ", "GⅡ", "GⅢ",
  "JpnⅠ", "JpnⅡ", "JpnⅢ", "JGⅠ", "JGⅡ", "JGⅢ", "重賞", "準重賞",
  "障害未勝利", "障害",
  "A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3",
  "Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6", "Class 7",
  "特選", "交流", "一般",
];

// ---------- 场地 / 级别（UI 筛选用，用户定稿 2026-10-22 / 场地细化 2026-10-22） ----------
// 场地两级口径：日本源按场馆名单 → JRA（中央10场）/ NAR（地方15场）；
// 海外源（Racing Post 经 SL）→ 国家组码（见 countryGroupOf），build 侧按 source 选择口径
export const TRACK_CENTRAL = ["阪神", "京都", "東京", "中京", "札幌", "中山", "新潟", "小倉", "函館", "福島"];
export const TRACK_LOCAL = ["帯広", "門別", "盛岡", "水沢", "浦和", "船橋", "大井", "川崎", "金沢", "笠松", "名古屋", "園田", "姫路", "高知", "佐賀"];
export const scopeOfVenue = (venue) =>
  TRACK_CENTRAL.includes(venue) ? "JRA" : TRACK_LOCAL.includes(venue) ? "NAR" : "海外";

// SL country.short_name → 国家组码（与 sources/racingpost.js 的 COUNTRY_GROUP 同口径）
const COUNTRY_GROUP_MAP = { ENG: "GB", Wale: "GB", SCO: "GB", Eire: "IRE" };
export const countryGroupOf = (code) => COUNTRY_GROUP_MAP[code] ?? code ?? "海外";

// 级别（半角标签对齐 yunji-web GRADE 表）：原始比赛格 → 13 桶
//   G1-3 = GⅠ-Ⅲ；Jpn1-3 = 地方全国格；JG1-3 = 障害重赏；地方重赏 = 重賞/準重賞；
//   无级别 = 新馬/未勝利/1-3勝/地方班级(A1-C3)/特選/交流/一般/障害/RP Class 1-7 等
export const LEVELS = [
  "G1", "G2", "G3", "Jpn1", "Jpn2", "Jpn3", "JG1", "JG2", "JG3",
  "OP", "L", "地方重赏", "无级别",
];
const K2L = {
  "GⅠ": "G1", "GⅡ": "G2", "GⅢ": "G3",
  "JpnⅠ": "Jpn1", "JpnⅡ": "Jpn2", "JpnⅢ": "Jpn3",
  "JGⅠ": "JG1", "JGⅡ": "JG2", "JGⅢ": "JG3",
  "OP": "OP", "L": "L",
  "重賞": "地方重赏", "準重賞": "地方重赏",
};
export const klassToLevel = (klass) => K2L[klass] ?? "无级别";
