// ============================================================
// 全球重赏收集（探索分支 feat/global-graded）
// 配置单源：关注范围 = G1/G2/G3 + JG1/JG2/JG3（日本另含 Jpn1-3，
// 见 INCLUDE_JPN 注释）；国家 = 截图 13 国 + 日本。
// ============================================================

// 地方格 Jpn1-3 是否收录：用户口径字面只说 G1-3/JG1-3，但 NAR 重赏
// 全部是 Jpn 格，不收则 NAR 永远为空、违背「区分 JRA 和 NAR」的本意。
// 默认收；独立成项目时若要严格口径，改这里即可。
export const INCLUDE_JPN = true;

// 日本 gradeTag 白名单（race.card/v2 的 race.gradeTag；JBIS 源直接印）
export const JP_GRADES = {
  G1: "G1", G2: "G2", G3: "G3",
  JG1: "JG1", JG2: "JG2", JG3: "JG3",
  ...(INCLUDE_JPN ? { Jpn1: "Jpn1", Jpn2: "Jpn2", Jpn3: "Jpn3" } : {}),
};

// 海外赛名级别正则：Group/Groupe/Grade + 数字，或 G1 形态。
// 覆盖：GB/IRE/FR/AU/NZ/HK/SA/AE（Group 系）、US/CA/AR/BR/CL/TR（Grade 系）、
// 及各源直印 (G1)/(G3) 的写法。字母后数字形态必须 \b 防止 "AG1" 之类误配。
export const OVERSEAS_GRADE_RE =
  /\b(?:group|groupe|grade|gr)\s*[.\-]?\s*([123])\b|\bG\s*([123])\b/i;

// 截图 13 国 + 日本。match = 各源 doc.country 的原始写法（已实测：
// racingpost 用 ENG/Wale/Scot/Eire/FR/HK/SAF/UAE/USA；racingaustralia 用 AUS；
// tjk 用 TUR；teletrak 用 CHI；turfeonline 用 BRA；sanisidro/laplata 用 ARG）。
export const COUNTRIES = [
  { code: "JP",  label: "日本",     match: ["JPN"] },
  { code: "AR",  label: "阿根廷",   match: ["ARG"] },
  { code: "AU",  label: "澳大利亚", match: ["AUS"] },
  { code: "BR",  label: "巴西",     match: ["BRA"] },
  { code: "CL",  label: "智利",     match: ["CHI"] },
  { code: "FR",  label: "法国",     match: ["FR"] },
  { code: "GB",  label: "英国",     match: ["GB", "ENG", "Wale", "SCO", "Scot"] },
  { code: "HK",  label: "中国香港", match: ["HK"] },
  { code: "IE",  label: "爱尔兰",   match: ["IRE", "Eire"] },
  { code: "NZ",  label: "新西兰",   match: ["NZ"] },
  { code: "SA",  label: "南非",     match: ["SA", "SAF"] },
  { code: "TR",  label: "土耳其",   match: ["TR", "TUR"] },
  { code: "AE",  label: "阿联酋",   match: ["AE", "UAE"] },
  { code: "US",  label: "美国",     match: ["US", "USA"] },
];

const BY_MATCH = new Map(COUNTRIES.flatMap((c) => c.match.map((m) => [m, c])));

export function countryOf(raw) {
  return BY_MATCH.get(raw) ?? null;
}

// Deep Impact 名称匹配（父系/母父通用）：日文片假名 + 英文，允许
// “Deep Impact (JPN)”、全角括号等前后缀；不做模糊匹配（宁缺勿错）。
const DI_RE = /ディープインパクト|deep\s+impact/i;

export function isDeepImpactName(name) {
  return !!name && DI_RE.test(String(name));
}
