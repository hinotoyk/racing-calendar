// 同名异马人工裁决表（data/pedigree/homonym.json）的读取与判定。
//
// 为什么需要它：马名不是主键。normalizeHorseName() 只做形态归一，能合并「同一匹马的多种写法」
// （Deep Impact / ディープインパクト、Saxon Warrior(JPN) / Saxon Warrior），但无法区分
// 「不同的马用了同一个写法」。后者在名字这条线索上不可判定 —— 例如 JBIS 里 "Silver State"
// 只有 シルバーステート 一条记录，牡、種、生年 2016 全部对得上，任何更聪明的名字匹配都会选中它。
// 所以只能显式声明：这是人工裁决，不是自动消歧。
//
// 判定口径：
//   · 一条记录同时给出 jbis 与 intl 两侧 → 该写法是「同名异马」；
//   · 海外（非日本）语境下禁止按名字绑 JBIS：blockedForIntl() = true；
//   · 只有单边归属的记录不算歧义（blockedForIntl 返回 false），避免把「单纯登记在 JBIS 的
//     海外种公马」（Saxon Warrior / Karakontie 这类）误伤 —— 见 docs/DESIGN.md §12。
//
// 调用方：src/lib/horse-lookup.js（血统名解析）、src/sources/racingpost.js（祖父补全）。
import fs from "node:fs";
import { normalizeHorseName } from "./horse-name.mjs";

export const HOMONYM_FILE = "data/pedigree/homonym.json";

export function loadHomonym(file = HOMONYM_FILE) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    raw = null; // 文件缺失/损坏 = 空表，全站行为回到裁决前，不影响其它逻辑
  }
  const byKey = new Map(); // 归一化写法 → { key, jbis, intl, note }
  for (const [k, rec] of Object.entries(raw?.names ?? {})) {
    const key = normalizeHorseName(k);
    if (!key) continue;
    const entry = { key, jbis: rec?.jbis ?? null, intl: rec?.intl ?? null, note: rec?.note ?? null };
    // 裁决键与两侧 label 都登记，任一写法都能命中同一条裁决
    for (const form of [k, rec?.jbis?.label, rec?.intl?.label]) {
      const norm = normalizeHorseName(form);
      if (norm && !byKey.has(norm)) byKey.set(norm, entry);
    }
  }
  return {
    size: () => byKey.size,
    entries: () => [...new Set(byKey.values())],
    get: (name) => byKey.get(normalizeHorseName(name)) ?? null,
    /** 海外语境下是否禁止按名字绑 JBIS：只有「两侧都有归属」才算同名异马 */
    blockedForIntl: (name) => {
      const e = byKey.get(normalizeHorseName(name));
      return Boolean(e?.jbis && e?.intl);
    },
    /** 前端字典用的精简形态（derived/horse-aliases.json 的 homonym 段） */
    toJSON: () =>
      Object.fromEntries(
        [...new Set(byKey.values())].map((e) => [
          e.key,
          {
            jbisId: e.jbis?.id ?? null,
            jbisLabel: e.jbis?.label ?? null,
            intlLabel: e.intl?.label ?? null,
            country: e.intl?.country ?? null,
            blocked: Boolean(e.jbis && e.intl), // 只有两侧都有归属才是同名异马（单边不算，见上）
            note: e.note ?? null,
          },
        ])
      ),
  };
}
