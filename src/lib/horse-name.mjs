// 马名规范化「单一出处」：build.js 与前端（site/horse-name.mjs，构建时复制）共用。
//
// 目的：同一匹马在不同源 / 不同书写下归到同一个键（保留原始显示名，仅用于合并与检索）：
//   "Saxon Warrior(JPN)" / "Saxon Warrior (JPN)" / "Saxon Warrior"  → "saxonwarrior"
//   "Deep Impact" / "Deep Impact(JPN)"                              → "deepimpact"
//   "ディープインパクト"                                            → "ディープインパクト"
// 片假名与英文的等价由别名（JBIS 马页官方英文名 nameEn、JBIS 搜索解析）提供，
// 本函数只做形态归一，不做跨语言翻译。
//
// 规则：去尾部国码括号（JBIS 惯例 "(JPN)/(USA)/(IRE)…"）→ NFKC → 小写 → 去空白与常见标点。
// 长音记号「ー」与片假名/汉字原样保留（去掉会把不同名并坏）。
export function normalizeHorseName(s) {
  let t = String(s ?? "").trim();
  t = t.replace(/\s*[\(（][A-Za-z]{2,4}[\)）]\s*$/u, ""); // 尾部国码后缀
  t = t.normalize("NFKC").toLowerCase();
  t = t.replace(/[\s\u3000]+/g, ""); // 空白
  t = t.replace(/[（）()\[\]〔〕'’‘`・·\-‐–―—~〜。,，.、:：;；!！?？/／"“”]/g, ""); // 标点
  return t;
}
