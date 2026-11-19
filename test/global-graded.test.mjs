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

// ---- gradeOf：SL 赛名形态补充（真实回填数据抽样） ----
assert.equal(gradeOf({ name: "Qatar Racing Champion Stakes (Group 1) (Str)" }, {}), "G1");
assert.equal(gradeOf({ name: "Prix Orcada Chase - Grade 3", raceClass: "1" }, {}), "G3");

// ---- parseResultPage：JBIS 结果页模板（过往赛日回填路径） ----
import { parseResultPage } from "../src/lib/parse-race.js";
const FIXTURE = `<div class="data-6-11 sort-1">
<div><div>着順</div><div>枠番</div><div>馬番</div><div>馬名</div><div>性齢</div><div>騎手斤量</div><div>タイム</div><div>調教師</div></div>
<div>
 <div><div><span class="number-1">1</span></div></div>
 <div><div><span class="frameNumber-7">7</span></div></div>
 <div class="jc-right">11番</div>
 <div class="jc-left"><div><a href="/horse/0001361718/" class="txt-link">カラマティアノス</a>
   <div class="data-6__small"><p class="txt-overflow">父：<a href="/horse/0001189721/" class="txt-link">レイデオロ</a></p></div></div></div>
 <div><span class="txt-male">牡4</span></div>
 <div class="data-6__lyt-1"><a href="/race/jockey/J01092/" class="txt-link txt-overflow">津村 明秀</a><span class="ta-right">55.0</span></div>
 <div class="jc-right">2:00.3</div>
 <div class="jc-left"><span class="txt-overflow"><a href="/race/trainer/J01145/" class="txt-link txt-overflow">奥村 武</a>(美 浦)</span></div>
</div>
<div>
 <div><div>中</div></div>
 <div><div><span class="frameNumber-2">2</span></div></div>
 <div class="jc-right">3番</div>
 <div class="jc-left"><div><a href="/horse/0001340873/" class="txt-link">テストベイ</a></div></div>
 <div><span class="txt-male">牝5</span></div>
 <div class="data-6__lyt-1"><a href="/race/jockey/J99999/" class="txt-link">ダミー</a><span class="ta-right">54.0</span></div>
 <div class="jc-right">-</div>
 <div class="jc-left"><span class="txt-overflow"><a href="/race/trainer/J99998/" class="txt-link">ダミー 師</a>(美 浦)</span></div>
</div>
</div>`;
{
  const p = parseResultPage(FIXTURE);
  assert.equal(p.runners.length, 2);
  const [w, dnf] = p.runners;
  assert.equal(w.finish, 1);
  assert.equal(w.finishRaw, "1");
  assert.equal(w.num, 11);
  assert.equal(w.frame, 7);
  assert.equal(w.horse.name, "カラマティアノス");
  assert.equal(w.sire.name, "レイデオロ");
  assert.equal(w.jockey.name, "津村 明秀");
  assert.equal(w.weight, 55);
  assert.equal(w.trainer.name, "奥村 武");
  assert.equal(dnf.finish, null);
  assert.equal(dnf.finishRaw, "中");
  assert.equal(dnf.num, 3);
}

console.log("test/global-graded.test.mjs: all passed");
