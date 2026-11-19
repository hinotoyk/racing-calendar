// 全球重赏收集 · 单元测试（级别判定 / 国家映射 / Deep Impact 血统匹配）
import { strict as assert } from "node:assert";
import { gradeOf } from "../src/global/grade.mjs";
import { countryOf, isDeepImpactName } from "../src/global/config.mjs";
import { diFlags, filterByDi } from "../src/global/pedigree.mjs";

// ---- gradeOf：日本走 gradeTag ----
assert.equal(gradeOf({ gradeTag: "G1", name: "天皇賞(秋)" }, { scope: "central" }), "G1");
assert.equal(gradeOf({ gradeTag: "JG1", name: "中山大障害" }, { scope: "central" }), "JG1");
assert.equal(gradeOf({ gradeTag: "Jpn1", name: "帝王賞" }, { scope: "local" }), "Jpn1");
assert.equal(gradeOf({ gradeTag: null, name: "3勝クラス" }, { scope: "central" }), null);
assert.equal(gradeOf({ gradeTag: null, name: "メジロS" }, { scope: "central" }), null);

// ---- gradeOf：海外走赛名/класс正则 ----
assert.equal(gradeOf({ name: "GRAN PREMIO DARDO ROCHA (G1)" }, { scope: "overseas" }), "G1");
assert.equal(gradeOf({ name: "Paddy Power Arkle ... (Grade 2)" }, { scope: "overseas" }), "G2");
assert.equal(gradeOf({ name: "Prix Du Languedoc - Attele - Group 3" }, {}), "G3");
assert.equal(gradeOf({ name: "SAKARYA RACE", raceClass: "G2" }, { scope: "overseas" }), "G2");
assert.equal(gradeOf({ name: "Prix Maurice Gillois (grade 1)" }, {}), "G1");
// 误配防线
assert.equal(gradeOf({ name: "Cheung Sha Handicap", raceClass: "" }, { scope: "overseas" }), null);
assert.equal(gradeOf({ name: "Condition 5/DHÖW/Mares" }, { scope: "overseas" }), null);
assert.equal(gradeOf({ name: "Class 1 Novice" }, { scope: "overseas" }), null);
assert.equal(gradeOf({ name: "Grand National Handicap" }, { scope: "overseas" }), null);

// ---- countryOf：实测源码 → 国家码 ----
assert.equal(countryOf("ENG")?.code, "GB");
assert.equal(countryOf("Eire")?.code, "IE");
assert.equal(countryOf("SAF")?.code, "SA");
assert.equal(countryOf("UAE")?.code, "AE");
assert.equal(countryOf("TUR")?.code, "TR");
assert.equal(countryOf("CHI")?.code, "CL");
assert.equal(countryOf("BRA")?.code, "BR");
assert.equal(countryOf("AUS")?.code, "AU");
assert.equal(countryOf("NOPE"), null);

// ---- Deep Impact 名称匹配 ----
assert.ok(isDeepImpactName("ディープインパクト"));
assert.ok(isDeepImpactName("DEEP IMPACT"));
assert.ok(isDeepImpactName("Deep Impact"));
assert.ok(!isDeepImpactName("ディープブリランテ"));
assert.ok(!isDeepImpactName("Deep Field"));
assert.ok(!isDeepImpactName("キタサンブラック"));

// ---- diFlags / filterByDi ----
assert.deepEqual(diFlags({ sire: { name: "ディープインパクト" } }),
  { line: true, broodmare: false, lineVia: "sire" });
assert.deepEqual(diFlags({ sireSire: { name: "Deep Impact" } }),
  { line: true, broodmare: false, lineVia: "sireSire" });
assert.deepEqual(diFlags({ bms: { name: "ディープインパクト" } }),
  { line: false, broodmare: true, lineVia: null });
assert.deepEqual(diFlags({ sire: { name: "キタサンブラック" } }),
  { line: false, broodmare: false, lineVia: null });

const rows = [
  { di: { line: true, broodmare: false } },
  { di: { line: false, broodmare: true } },
  { di: { line: false, broodmare: false } },
];
assert.equal(filterByDi(rows, "line").length, 1);
assert.equal(filterByDi(rows, "bms").length, 1);
assert.equal(filterByDi(rows, "any").length, 2);
assert.equal(filterByDi(rows, "all").length, 3);

console.log("test/global-graded.test.mjs: all passed");
