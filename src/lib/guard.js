// 采集写盘前的覆盖保护（docs/DESIGN.md §4）
//
// 背景：出馬表采集失败时（源站假 404、页面结构变动、分页只取到部分场次），解析器会产出一份
// 「空壳」或「残缺」文档。若直接落盘，会覆盖掉已经完整的旧文档 —— 2026-10/11 实际发生过
// 三例（10-31 高知 12R/117头→0头、10-31 佐賀 12R/125头→0头、11-04 Musselburgh 8R/87头→1R/12头），
// 数据只能从 git 历史手工恢复。
//
// 判据：已经跑完的赛事不会整体或大幅消失，头数骤降只能解释为本次采集失败。
//   - 空壳：旧文档有 runners，本次 0 头  → 一律保留
//   - 腰斩：本次不足旧文档 50% 且旧文档 ≥5 头 → 保留（整场取消出走通常只掉 1–3 头，不会过半）
//   - 部分采集（--limit / --tracks）：只要比旧文档少就保留
//   - --force：人工强制重采，一律放行

const runnersOf = (doc) => (doc?.races ?? []).reduce((n, r) => n + (r.runners?.length ?? 0), 0);

/**
 * @param {object|null|undefined} existing 已存文档（null/undefined 表示首次采集）
 * @param {object} doc 本次采集产出的文档
 * @param {{partial?: boolean, force?: boolean}} [opts]
 * @returns {{keep: boolean, reason: string|null, existed: number, fresh: number}}
 */
export function guardOverwrite(existing, doc, { partial = false, force = false } = {}) {
  const existed = runnersOf(existing);
  const fresh = runnersOf(doc);
  const out = (keep, reason) => ({ keep, reason, existed, fresh });

  if (force) return out(false, null);          // 人工强制重采
  if (!existing) return out(false, null);      // 首次采集，没有可保护的内容
  if (existed > 0 && fresh === 0) return out(true, "空壳");
  if (existed >= 5 && fresh < existed * 0.5) return out(true, "腰斩(<50%)");
  if (partial && existed > fresh) return out(true, "部分采集少于已存");
  return out(false, null);
}

/**
 * 统一 manifest 记录形状 —— 成功与失败（catch）路径必须产出同一套字段，
 * 否则失败时只写 { venue, status } 就会出现「undefinedR / undefined头」的脏记录。
 *
 * @param {object} p
 * @param {string} p.venue 场地名
 * @param {string} [p.scope] central / local / overseas
 * @param {{races:number, decoded:number, runners:number}} p.stats 已知的统计（失败时用旧文档的）
 * @param {string|null} [p.capturedAt] 文档抓取时间（失败且未落盘时沿用旧值）
 * @param {string} [p.error] 本次失败原因，写进 lastError
 */
export function manifestEntry({ venue, scope, stats, capturedAt = null, error }) {
  const runners = stats?.runners ?? 0;
  const entry = {
    venue,
    ...(scope ? { scope } : {}),
    races: stats?.races ?? 0,
    decoded: stats?.decoded ?? 0,
    runners,
    // status 反映「文档实际状态」：有 runners 即 ok；本次失败只记在 lastError，不改写 status 语义
    status: runners > 0 ? "ok" : "pending",
    capturedAt,
  };
  if (error) entry.lastError = error;
  return entry;
}
