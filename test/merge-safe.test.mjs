// merge-safe 回归测试：核心不变量 —— 有值可覆盖无值，无值绝不覆盖有值。
import assert from "node:assert/strict";
import { mergeDocSafe, diffDowngrades, mergeValue, isBlank } from "../src/lib/merge-safe.mjs";

let n = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  n++;
};

const doc = (races) => ({ schema: "x", date: "2026-11-22", races });

// 1. 顶层：null / "" 不覆盖有值
{
  const { doc: out } = mergeDocSafe({ date: "2026-11-22", venue: "東京", going: "良" }, { date: "2026-11-22", venue: null, going: "" });
  assert.equal(out.venue, "東京");
  assert.equal(out.going, "良");
  ok("null / 空串不覆盖已有值");
}

// 2. 顶层：有值覆盖无值（填充）
{
  const { doc: out, stats } = mergeDocSafe({ venue: "東京", trackId: null }, { venue: "東京", trackId: 105 });
  assert.equal(out.trackId, 105);
  assert.equal(stats.preserved, 0);
  ok("有值可以覆盖无值");
}

// 3. 有值可以纠错（新值不同且非空 → 以新为准）
{
  const { doc: out } = mergeDocSafe({ venue: "東京" }, { venue: "中山" });
  assert.equal(out.venue, "中山");
  ok("新值非空时以新值为准（允许纠错）");
}

// 4. 0 / false 不是「空」
{
  assert.equal(isBlank(0), false);
  assert.equal(isBlank(false), false);
  assert.equal(isBlank([]), true);
  assert.equal(isBlank("  "), true);
  ok("0 / false 视为有效值，空数组与空白串视为空");
}

// 5. 嵌套对象：内层 null 不洗掉外层已有值
{
  const { doc: out } = mergeDocSafe(
    { date: "d", races: [{ no: 1, runners: [] }], owner0: { id: "J007793", name: "峰哲馬" } },
    { date: "d", races: [{ no: 1, runners: [] }], owner0: { id: null, name: null } }
  );
  assert.deepEqual(out.owner0, { id: "J007793", name: "峰哲馬" });
  ok("嵌套对象递归保护（owner.id）");
}

// 6. runners 整表为空 → 保留旧表
{
  const prev = doc([{ no: 1, runners: [{ num: 1, horse: { id: "h1" }, frame: 1 }] }]);
  const next = doc([{ no: 1, runners: [] }]);
  const { doc: out } = mergeDocSafe(prev, next);
  assert.equal(out.races[0].runners.length, 1);
  assert.equal(out.races[0].runners[0].frame, 1);
  ok("本次 runners 为空时保留旧出马表");
}

// 7. 同一匹马：本次丢字段，旧值保留
{
  const prev = doc([{ no: 1, runners: [{ num: 1, frame: 3, horse: { id: "h1" }, age: 4, sire: { id: "s1", name: "S" }, silk: { url: "u" } }] }]);
  const next = doc([{ no: 1, runners: [{ num: 1, frame: null, horse: { id: "h1" }, age: null, sire: { id: null, name: "S" }, silk: null }] }]);
  const { doc: out, stats } = mergeDocSafe(prev, next);
  const r = out.races[0].runners[0];
  assert.equal(r.frame, 3);
  assert.equal(r.age, 4);
  assert.equal(r.sire.id, "s1");
  assert.deepEqual(r.silk, { url: "u" });
  assert.ok(stats.preserved >= 3);
  ok("单匹马字段级保留（枠番/年龄/血统 id/彩衣）");
}

// 8. 退赛：本次确实少了一匹 → 以本次为准（不能复活）
{
  const prev = doc([{ no: 1, runners: [{ num: 1, horse: { id: "h1" } }, { num: 2, horse: { id: "h2" } }] }]);
  const next = doc([{ no: 1, runners: [{ num: 1, horse: { id: "h1" } }] }]);
  const { doc: out } = mergeDocSafe(prev, next);
  assert.equal(out.races[0].runners.length, 1);
  ok("退赛/减头以本次为准（不复活已减马匹）");
}

// 9. 整场缺席但有出马 → 保留该场
{
  const prev = doc([
    { no: 1, runners: [{ num: 1, horse: { id: "h1" } }] },
    { no: 2, runners: [{ num: 1, horse: { id: "h9" } }] },
  ]);
  const next = doc([{ no: 1, runners: [{ num: 1, horse: { id: "h1" } }] }]);
  const { doc: out, stats } = mergeDocSafe(prev, next);
  assert.equal(out.races.length, 2);
  assert.deepEqual(stats.keptRaces, ["2R(1頭)"]);
  ok("本次缺席但旧文档有出马的场次被保留");
}

// 10. 整场缺席且旧场本来就空 → 不保留（避免留空壳）
{
  const prev = doc([{ no: 1, runners: [{ num: 1, horse: { id: "h1" } }] }, { no: 2, runners: [] }]);
  const next = doc([{ no: 1, runners: [{ num: 1, horse: { id: "h1" } }] }]);
  const { doc: out, stats } = mergeDocSafe(prev, next);
  assert.equal(out.races.length, 1);
  assert.deepEqual(stats.keptRaces, []);
  ok("缺席的空壳场次不保留");
}

// 11. 合并后不再存在任何降级点
{
  const prev = doc([{ no: 1, runners: [{ num: 1, frame: 2, horse: { id: "h1" }, recent: [{ raceKey: "a" }] }] }]);
  const next = doc([{ no: 1, runners: [{ num: 1, frame: null, horse: { id: "h1" }, recent: [] }] }]);
  const before = diffDowngrades(prev, next);
  assert.ok(before.length >= 2, "原始对比应能发现降级点");
  const { doc: out } = mergeDocSafe(prev, next);
  assert.equal(diffDowngrades(prev, out).length, 0, "合并后不应再有降级点");
  ok("diffDowngrades 能识别降级，合并后归零");
}

// 12. 非身份键数组（如字符串列表）不误合并
{
  const r = mergeValue(["a", "b"], []);
  assert.deepEqual(r.value, ["a", "b"]);
  const r2 = mergeValue(["a"], ["b"]);
  assert.deepEqual(r2.value, ["b"]);
  ok("无身份键的数组：空不覆盖、非空以新为准");
}

console.log(`\nmerge-safe: ${n} 组用例全部通过`);
