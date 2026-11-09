// 赛果完整性校验（着顺 + 最终人气）
// 背景：部分比赛会先放出前三名着顺 / 人气尚未回填；这类「半截结果」绝不能入库，
//       否则会被幂等当成已完成、之后再也不补。异常态（除/中/失/取/止）是合法结果，
//       但不能拿它们凑数，也不对它们要求人气。
export const ABNORMAL_FINISH = new Set(["除", "中", "失", "取", "止"]);

export function isAbnormalFinish(f) {
  return typeof f === "string" && ABNORMAL_FINISH.has(f);
}

/**
 * @param {Array} runners 结果行（parsed.runners 或已落盘的 runners；需带 finish / pop）
 * @param {number} heads  出馬表头数（race.heads）
 * @param {object} opt    minPopRatio 数字名次行的人气覆盖率下限；headTolerance 允许的头数误差
 * @returns {{ok: boolean, reason: string|null, stats: object}}
 */
export function checkCompleteness(runners, heads, { minPopRatio = 0.8, headTolerance = 2 } = {}) {
  const list = Array.isArray(runners) ? runners : [];
  const H = Number(heads) > 0 ? Number(heads) : list.length;
  const numeric = list.filter((r) => typeof r.finish === "number");
  const abnormal = list.filter((r) => isAbnormalFinish(r.finish));
  const ranks = numeric.map((r) => r.finish);
  const maxRank = ranks.length ? Math.max(...ranks) : 0;
  // 名次游标：并列第 N 着有 c 匹时，下一着顺应为 N+c（日本赛马同着跳号是合法的）。
  // 例如 4 着并列两匹 → 序列 1,2,3,4,4,6… 中缺 5 属正常，不能判不完整。
  const rankCounts = new Map();
  for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  const missingRanks = [];
  let cursor = 1;
  while (cursor <= maxRank) {
    const c = rankCounts.get(cursor) ?? 0;
    if (!c) { missingRanks.push(cursor); cursor++; }
    else cursor += c;
  }
  const popCovered = numeric.filter((r) => r.pop != null && r.pop !== "").length;
  const popRatio = numeric.length ? popCovered / numeric.length : 0;

  const stats = {
    heads: H,
    rows: list.length,
    numeric: numeric.length,
    abnormal: abnormal.length,
    maxRank,
    missingRanks,
    popCovered,
    popTotal: numeric.length,
    popRatio: Number(popRatio.toFixed(3)),
  };

  let reason = null;
  if (!list.length) reason = "结果为空";
  else if (!numeric.length) reason = "无有效数字着顺";
  else if (missingRanks.length) reason = `名次缺号 ${missingRanks.slice(0, 6).join(",")}`;
  // 只放前三名：名次连续但行数远少于出馬表头数（允许少量除外马未列入结果表）
  else if (list.length < H - headTolerance) reason = `仅 ${list.length}/${H} 頭（疑似只放出前三名）`;
  else if (maxRank < H - abnormal.length - headTolerance)
    reason = `最大着顺 ${maxRank} < 应有约 ${H - abnormal.length}（名次不全）`;
  else if (popRatio < minPopRatio) reason = `人气仅 ${popCovered}/${numeric.length}（未回填齐）`;

  return { ok: reason === null, reason, stats };
}
