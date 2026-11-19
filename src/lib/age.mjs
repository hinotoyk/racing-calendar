// 赛马官方年龄（整岁制）计算 —— 全站唯一实现
//
// ## 行业约定：马匹没有"按实际生日长岁"的说法，官方年龄按出生地的统一生日整岁递增
//   - 北半球（JP/TR/GB/IE/US/CA/FR/DE…）：1 月 1 日转岁
//   - 南美（AR/BR/CL/UY/PE）+ 南非：7 月 1 日转岁
//   - 澳大利亚/新西兰：8 月 1 日转岁
//   转岁日固定为该月 1 日 → 只需比较「比赛月份 vs 转岁月份」，无需逐日比较。
//   注意：跟随的是**马的出生地**（血统登记国），不是比赛举办地——北半球进口马
//   在南半球作赛仍按 1 月 1 日转岁（香港赛马会打吡条款同口径）。
//
// ## 使用原则：直印年龄永远优先，推算只是兜底
//   源站印了年龄（netkeiba「牡5」、RA「4 year old…」、Teletrak volante、TJK、
//   si `ejemplar_edad`、RP 接口…）→ 一律直取，不计算。
//   只有整条链路完全拿不到年龄（如巴西 TurfeOnline 不印）才走 ageAt 推算。
//   resolveAge() 封装了这个优先级，调用方不应绕过它直接用 ageAt。
//
// 背景：2026-11 排查发现三处年差公式（backfill-bra-ped / enrich-jcb /
// backfill-arg-ped）没有月份修正，南半球马在 1–6 月赛事会被标大 1 岁，本库收敛修复。

/** 官方转岁月份：出生国（2/3 字码均可）→ 1-12；查无 → 回退 venue 国 → 再回退北半球 1 月 */
export const AGE_RULES = {
  // 北半球：1 月 1 日
  JP: 1, TR: 1, GB: 1, IE: 1, FR: 1, DE: 1, US: 1, CA: 1,
  // 南美 + 南非：7 月 1 日
  AR: 7, BR: 7, CL: 7, UY: 7, PE: 7, ZA: 7,
  // 澳新：8 月 1 日
  AU: 8, NZ: 8,
};

/** 「BRA」「BR」「Brasil」→ 2 字码；识别不了返回 null */
export const normCountry = (c) => {
  const s = String(c ?? "").trim().toUpperCase();
  return /^[A-Z]{2,3}$/.test(s) ? s.slice(0, 2) : null;
};

export function birthdayMonthOf(country, venueCountry = null) {
  const m = AGE_RULES[normCountry(country)] ?? AGE_RULES[normCountry(venueCountry)] ?? 1;
  return m;
}

/**
 * 从出生日期推算官方年龄（兜底路径，直印年龄拿不到时才调用）
 *
 * @param {string|Date} birthDate    出生日期（ISO 串 / Date；「YYYY」「YYYY-MM」也可）
 * @param {string|Date} raceDate     比赛日期（ISO 串 / Date）
 * @param {number}      birthdayMonth 官方转岁月份（birthdayMonthOf() 的产物）
 * @returns {number|null} 官方年龄；输入不可解析 / 非法时返回 null（宁缺勿错）
 */
export function ageAt(birthDate, raceDate, birthdayMonth = 1) {
  if (!birthDate || !raceDate) return null;
  const birth = birthDate instanceof Date ? birthDate : new Date(birthDate);
  const race = raceDate instanceof Date ? raceDate : new Date(raceDate);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(race.getTime())) return null;
  if (!Number.isInteger(birthdayMonth) || birthdayMonth < 1 || birthdayMonth > 12) return null;
  if (race < birth) return null;

  let age = race.getFullYear() - birth.getFullYear();
  // 官方生日固定为转岁月的 1 号：比赛月份未到即未转岁（月份相同必然已过 1 号）
  if (race.getMonth() + 1 < birthdayMonth) age--;
  // 整岁制下合理区间，超出说明输入脏了
  return age >= 0 && age <= 40 ? age : null;
}

/**
 * 年龄解析统一入口：源站直印值优先，完全拿不到才按出生年 + 转岁月推算
 *
 * @param {object} o
 * @param {number|null} o.age           源站/前序回填已有的年龄（直印值）
 * @param {string|Date|null} o.birth    出生日期（推算用）
 * @param {string|Date|null} o.raceDate 比赛日期（推算用）
 * @param {string|null} o.country       马的出生/登记国（决定转岁月，优先于比赛地）
 * @param {string|null} o.venueCountry  比赛举办国（出生国未知时回退）
 * @returns {number|null} 官方年龄
 */
export function resolveAge({ age = null, birth = null, raceDate = null, country = null, venueCountry = null } = {}) {
  const direct = Number(age);
  if (Number.isFinite(direct) && direct > 0 && direct <= 40) return direct; // 直印优先
  return ageAt(birth, raceDate, birthdayMonthOf(country, venueCountry));
}
