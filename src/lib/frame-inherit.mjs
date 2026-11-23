// 枠番继承（纯函数，2026-11-23）
//
// ## 为什么需要
// JBIS 出馬表在 JST 凌晨（全量档 02:00 档期）还没有枠順值 → parse 出来 frame=null。
// 全量档重写卡片时会把 backfill-waku（11:00/23:00 档）补好的枠番整片清空，
// 于是白天页面没有枠色，且完全依赖下一轮补采再补一次（期间任何一次失败就长期缺色）。
//
// ## 规则（宁缺勿错）
//   - 按 (raceNo, horseId) 匹配，只在新值为空时继承旧值；
//   - 源站已给出枠番时新值优先 → 取消马导致的改枠能正确反映；
//   - 不动任何非空值，不新增/删除 runner。

/**
 * @param {{races?: Array<{no:number, runners?: Array<{horse?: {id?: string}, frame?: number|null}>}>}|null} existing
 * @param {{races?: Array<{no:number, runners?: Array<{horse?: {id?: string}, frame?: number|null}>}>}} doc
 * @returns {number} 继承的頭数
 */
export function inheritFrame(existing, doc) {
  if (!existing?.races?.length || !doc?.races?.length) return 0;
  const prev = new Map();
  for (const pr of existing.races) {
    for (const x of pr.runners ?? []) {
      if (x.frame != null) prev.set(`${pr.no}:${x.horse?.id}`, x.frame);
    }
  }
  if (!prev.size) return 0;
  let n = 0;
  for (const r of doc.races) {
    for (const x of r.runners ?? []) {
      if (x.frame != null) continue;
      const k = `${r.no}:${x.horse?.id}`;
      if (prev.has(k)) {
        x.frame = prev.get(k);
        n++;
      }
    }
  }
  return n;
}
