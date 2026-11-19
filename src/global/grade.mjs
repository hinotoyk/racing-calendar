// 级别判定：日本走 doc.races[].gradeTag（JBIS 直印），海外走赛名正则。
// 输入统一为 canonical race.card/v2 的 race 对象 + doc（供 region 判断）。
import { JP_GRADES, OVERSEAS_GRADE_RE } from "./config.mjs";

// 日本级别 → 展示/排序用规范标签（JG 系是障害，Jpn 系是地方全国格）
const JP_NORMALIZE = {
  G1: "G1", G2: "G2", G3: "G3",
  JG1: "JG1", JG2: "JG2", JG3: "JG3",
  Jpn1: "Jpn1", Jpn2: "Jpn2", Jpn3: "Jpn3",
};

// 海外：Group/Groupe/Grade/Gr N、G N → G1/G2/G3（海外不区分障害，赛名里
// 带 hurdle/steeple 的 Group 赛极少，先按平地收，宁多勿漏由 UI 级别徽章区分）
export function gradeOf(race, doc = {}) {
  const tag = JP_NORMALIZE[race.gradeTag];
  if (tag && JP_GRADES[race.gradeTag]) return tag;

  const scope = doc.scope;
  if (scope === "central" || scope === "local") return null; // 日本但非重赏

  const text = `${race.name ?? ""} ${race.raceClass ?? ""}`;
  // SL 的「Domestic Group N」= 巴林等国的国内限定级，非国际 pattern → 排除（宁缺勿错）
  if (/\bdomestic\s+group\b/i.test(text)) return null;
  const m = text.match(OVERSEAS_GRADE_RE);
  if (!m) return null;
  return `G${m[1] || m[2]}`;
}

// 展示排序：G1 > G2 > G3 > JG1... > Jpn1...
export const GRADE_ORDER = ["G1", "G2", "G3", "JG1", "JG2", "JG3", "Jpn1", "Jpn2", "Jpn3"];
export const gradeRank = (g) => {
  const i = GRADE_ORDER.indexOf(g);
  return i === -1 ? 99 : i;
};
