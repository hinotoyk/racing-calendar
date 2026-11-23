// 写盘前的字段级「不降级」合并（2026-11-23）
//
// 原则（用户明确要求）：**允许有值覆盖无值，绝不允许无值覆盖有值。**
//
// 背景：lib/guard.js 只在「文档级」做保护（总头数骤降/空壳），拦不住字段级覆盖：
// 重采时头数一样多，但解析器这次没拿到 frame / 血统 / 彩衣 / 年龄 / 骑手 id，
// 直接把已补好的值洗成 null —— 这就是「无值覆盖有值」，且日志显示一切正常。
//
// 判定：
//   - 本次为「空」（null / undefined / "" / [] / NaN）且已存有值  → 保留已存值
//   - 本次有值                                                  → 本次优先（含纠错）
//   - 对象递归合并；数组按身份键（raceKey / horse.id / id / num / no）逐项合并
//   - races 数组中「本次消失但旧文档有出马」的场次 → 保留（丢整场比留陈旧场危险得多）
//   - 同一场比赛的 runners 以本次为准（退赛必须能退），但本次整表为空时保留旧表

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 「无值」判定：null / undefined / 空串 / 空数组 / NaN。0 与 false 属于有效值。 */
export function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return Number.isNaN(v);
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 数组元素身份键；返回 null 表示无法识别（退化为整体替换）。 */
function keyOf(v) {
  if (!isPlainObject(v)) return null;
  if (v.raceKey != null && v.raceKey !== "") return `rk:${v.raceKey}`;
  if (v.horse && v.horse.id != null) return `h:${v.horse.id}`;
  if (v.id != null && v.id !== "") return `id:${v.id}`;
  if (v.num != null) return `n:${v.num}`;
  if (v.no != null) return `no:${v.no}`;
  return null;
}

function keyable(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.every((x) => keyOf(x) !== null);
}

/**
 * 合并两个值。返回 { value, preserved }，preserved 是「因本次为空而保住」的字段数。
 */
export function mergeValue(prev, next) {
  if (isBlank(next)) {
    if (!isBlank(prev)) return { value: prev, preserved: 1 };
    return { value: prev === undefined ? next : prev, preserved: 0 };
  }
  if (isBlank(prev)) return { value: next, preserved: 0 };

  // 对象：递归
  if (isPlainObject(prev) && isPlainObject(next)) {
    const out = { ...prev, ...next };
    let preserved = 0;
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (k === "__proto__") continue;
      const r = mergeValue(prev[k], next[k]);
      out[k] = r.value;
      preserved += r.preserved;
    }
    return { value: out, preserved };
  }

  // 数组：按身份键逐项合并
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (!keyable(next) || !keyable(prev)) {
      return { value: next, preserved: 0 };
    }
    const prevMap = new Map(prev.map((x) => [keyOf(x), x]));
    let preserved = 0;
    const out = next.map((x) => {
      const k = keyOf(x);
      const p = prevMap.get(k);
      if (!p) return x;
      const r = mergeValue(p, x);
      preserved += r.preserved;
      return r.value;
    });
    return { value: out, preserved };
  }

  return { value: next, preserved: 0 };
}

/**
 * 合并一份赛事文档（new 为本次采集结果，old 为已存文档）。
 * @returns {{doc:object, stats:{preserved:number, keptRaces:string[]}}}
 */
export function mergeDocSafe(oldDoc, newDoc) {
  const stats = { preserved: 0, keptRaces: [] };
  if (!isPlainObject(oldDoc) || !isPlainObject(newDoc)) {
    return { doc: newDoc, stats };
  }

  // 1) 文档级字段
  const out = { ...oldDoc, ...newDoc };
  for (const k of new Set([...Object.keys(oldDoc), ...Object.keys(newDoc)])) {
    if (k === "races" || k === "__proto__") continue;
    const r = mergeValue(oldDoc[k], newDoc[k]);
    out[k] = r.value;
    stats.preserved += r.preserved;
  }

  // 2) races：按 no 匹配
  const oldRaces = Array.isArray(oldDoc.races) ? oldDoc.races : [];
  const newRaces = Array.isArray(newDoc.races) ? newDoc.races : [];
  if (!newRaces.length) {
    out.races = oldRaces; // 本次整表为空：保留旧表（空壳保护，与 guard.js 同向）
    if (oldRaces.length) stats.keptRaces.push(`*${oldRaces.length}R`);
    return { doc: out, stats };
  }

  const oldByNo = new Map(oldRaces.map((r) => [String(r.no), r]));
  const seen = new Set();
  const merged = newRaces.map((r) => {
    const p = oldByNo.get(String(r.no));
    if (!p) return r;
    seen.add(String(r.no));
    const res = mergeValue(p, r);
    stats.preserved += res.preserved;
    return res.value;
  });

  // 本次没出现的旧场次：只有「旧文档确实有出马表」才补回，避免丢整场
  for (const r of oldRaces) {
    const no = String(r.no);
    if (seen.has(no)) continue;
    if ((r.runners?.length ?? 0) === 0) continue;
    merged.push(r);
    stats.keptRaces.push(`${no}R(${r.runners.length}頭)`);
  }
  merged.sort((a, b) => Number(a.no) - Number(b.no));
  out.races = merged;
  return { doc: out, stats };
}

/**
 * 找出「无值覆盖有值」的降级点（用于审计/报警）。比较的是**原始两份文档**，未做合并。
 * @returns {Array<{path:string, from:any}>}
 */
export function diffDowngrades(oldDoc, newDoc, { base = "" } = {}) {
  const out = [];
  const walk = (prev, next, p) => {
    if (isBlank(next) && !isBlank(prev)) {
      out.push({ path: p, from: prev });
      return;
    }
    if (isPlainObject(prev) && isPlainObject(next)) {
      for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        walk(prev[k], next[k], p ? `${p}.${k}` : k);
      }
      return;
    }
    if (Array.isArray(prev) && Array.isArray(next) && keyable(prev) && keyable(next)) {
      const pm = new Map(prev.map((x) => [keyOf(x), x]));
      for (const x of next) {
        const o = pm.get(keyOf(x));
        if (o) walk(o, x, `${p}[${keyOf(x)}]`);
      }
    }
  };
  walk(oldDoc, newDoc, base);
  return out;
}
