// Deep Impact 血统匹配（探索分支 feat/global-graded）
//
// 口径（用户定稿 2026-11-19）：
//   直系 = 父系雄性链上的 Deep Impact —— 马是 DI 的儿子（sire=DI）、
//          孙子（父父=sireSire=DI）、曾孙（父父父=DI）。
//   母父 = 马的母父（bms / broodmare sire）是 DI，即母亲是 DI 的女儿。
//
// 数据边界：race.card/v2 的 runners 只带 sire / sireSire 两级父链，
// 「曾孙」需要第三级（sireSire.sire），本版不解析 —— 能从现有字段
// 稳妥判定的先收（宁缺勿错），三级解析留到 enrich 阶段接 netkeiba 血统页。
import { isDeepImpactName } from "./config.mjs";

// 单个 runner 的 DI 血统判定结果
export function diFlags(runner) {
  const sire = runner?.sire?.name ?? null;
  const sireSire = runner?.sireSire?.name ?? null;
  const bms = runner?.bms?.name ?? null;
  const line = isDeepImpactName(sire) || isDeepImpactName(sireSire);
  const broodmare = isDeepImpactName(bms);
  // lineVia：命中路径（展示用）：sire=儿子 / sireSire=孙子
  const lineVia = isDeepImpactName(sire) ? "sire"
    : isDeepImpactName(sireSire) ? "sireSire" : null;
  return { line, broodmare, lineVia };
}

// 数据集级过滤：mode = "line"（直系）| "bms"（母父）| "any"
export function filterByDi(runners, mode) {
  if (mode === "all") return runners;
  if (mode === "line") return runners.filter((r) => r.di?.line);
  if (mode === "bms") return runners.filter((r) => r.di?.broodmare);
  return runners.filter((r) => r.di?.line || r.di?.broodmare);
}
