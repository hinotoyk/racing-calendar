// 官方年龄整岁制计算的回归测试（零依赖，纯逻辑）
//   node test/age.test.mjs
// 覆盖：北半球 1/1 转岁 / 南美 7/1 转岁（1–6 月边界 bug）/ 澳新 8/1 转岁 /
//       出生国优先于比赛国 / 直印年龄优先（resolveAge）/ 脏输入宁缺勿错
import { ageAt, resolveAge, birthdayMonthOf, normCountry } from "../src/lib/age.mjs";

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`); }
};

// ---------- ageAt：北半球（1月1日转岁，全年年差即官方年龄） ----------
eq("JP：2021年生 2026-11-17 → 5", ageAt("2021-10-22", "2026-11-17", 1), 5);
eq("JP：2021年生 2026-01-01（转岁当天）→ 5", ageAt("2021-06-15", "2026-01-01", 1), 5);
eq("JP：2021年生 2025-12-31 → 4", ageAt("2021-06-15", "2025-12-31", 1), 4);

// ---------- ageAt：南美（7月1日转岁）——修复点 ----------
eq("BR：2021年生 2026-11-17（下半年）→ 5", ageAt("2021-10-22", "2026-11-17", 7), 5);
eq("BR：2021年生 2026-06-30（上半年，旧公式会算成5）→ 4", ageAt("2021-10-22", "2026-06-30", 7), 4);
eq("BR：2021年生 2026-07-01（转岁当天）→ 5", ageAt("2021-10-22", "2026-07-01", 7), 5);
eq("BR：2022-07-31生 2026-11-17（TRUE RELIGION 案例）→ 4", ageAt("2022-07-31", "2026-11-17", 7), 4);
eq("BR：2022-08-01生 2025-06-15（上半年3岁区间）→ 2", ageAt("2022-08-01", "2025-06-15", 7), 2);
eq("AR：同 BR 规则", ageAt("2021-01-20", "2026-05-01", 7), 4);

// ---------- ageAt：澳新（8月1日转岁） ----------
eq("AU：2022-10-17生 2026-07-15（8/1转岁前）→ 3", ageAt("2022-10-17", "2026-07-15", 8), 3);
eq("AU：2022-10-17生 2026-08-01（转岁当天）→ 4", ageAt("2022-10-17", "2026-08-01", 8), 4);
eq("NZ：同 AU 规则", ageAt("2021-09-05", "2024-07-31", 8), 2);

// ---------- 转岁月按出生国（而非比赛国） ----------
eq("出生国 BR 比赛国 AU → 7月转岁", birthdayMonthOf("BR", "AUS"), 7);
eq("出生国未知 → 回退比赛国 BRA → 7月", birthdayMonthOf(null, "BRA"), 7);
eq("都未知 → 回退北半球 1月", birthdayMonthOf("XXX", null), 1);
eq("normCountry：3字码→2字码", normCountry("BRA"), "BR");
eq("normCountry：脏值→null", normCountry("巴西"), null);

// ---------- resolveAge：直印年龄永远优先，推算只是兜底 ----------
eq("直印年龄存在 → 原样透传，不计算", resolveAge({ age: 4, birth: "2021-10-22", raceDate: "2026-11-17", country: "BR" }), 4);
eq("直印年龄缺失 → 走推算", resolveAge({ age: null, birth: "2021-10-22", raceDate: "2026-06-30", country: "BRA" }), 4);
eq("直印年龄非法（0/负数/超界）→ 视同缺失走推算", resolveAge({ age: 0, birth: "2021-10-22", raceDate: "2026-11-17", country: "BR" }), 5);
eq("无出生日期 → 宁缺勿错返回 null", resolveAge({ age: null, birth: null, raceDate: "2026-11-17", country: "BR" }), null);

// ---------- 脏输入防护 ----------
eq("生日格式非法（DD/MM/YYYY 未归一）→ null", ageAt("22/10/2021", "2026-11-17", 7), null);
eq("比赛早于出生 → null", ageAt("2021-10-22", "2020-01-01", 7), null);
eq("转岁月越界 → null", ageAt("2021-10-22", "2026-11-17", 13), null);
eq("空输入 → null", ageAt(null, "2026-11-17", 7), null);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
