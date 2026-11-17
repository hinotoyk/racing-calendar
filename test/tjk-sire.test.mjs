// TJK「祖父（父父）」解析的回归测试（零依赖，纯逻辑）
//   npm test   或   node test/tjk-sire.test.mjs
// 覆盖：At Sorgulama 结果行解析（sup 角标 / HTML 实体）/ Orijin(Baba-Anne) 拆父 /
//       精确匹配（前缀无关行要排除）/ 国码否决 / 性别否决 / 品种收窄 / 同名歧义留空
import { parseHorseQueryRows, pickSireSire, sireOfOriginCell } from "../src/sources/tjk.js";

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`); }
};

const row = (name, sex, irk, origin) => `
<tr class="even">
  <td class="sorgu-Atlar-AtIsmi"><a href="#">${name}</a><sup><span class='aciklamaFancy'>%&nbsp;</span></sup></td>
  <td class="sorgu-Atlar-IrkAdi">${irk}</td>
  <td class="sorgu-Atlar-Cinsiyet">${sex}</td>
  <td class="sorgu-Atlar-Yas">18&nbsp;y d a&nbsp;</td>
  <td class="sorgu-Atlar-BabaAdi">${origin}</td>
</tr>`;

// 一页里同时有：目标马（含 % 角标）、前缀同名马（ÖZHABER OĞLU）、牝馬同名、别国同名、品种不同
const HTML = `<table id="queryTable"><tbody>
  <tr><th>At İsmi</th><th>Orijin(Baba-Anne)</th></tr>
  ${row("SMART ROBIN (JPN)", "Erkek", "İngiliz", "DEEP IMPACT (JPN) - KEYBOOGIE (USA)")}
  ${row("ÖZHABER", "Erkek", "Arap", "HABERBATUR - &#214;ZTAY")}
  ${row("ÖZHABER OĞLU", "Erkek", "Arap", "&#214;ZHABER - ELIZABETH")}
  ${row("KITTEN'S JOY (USA)", "Erkek", "İngiliz", "EL PRADO (IRE) - SOARING")}
  ${row("SILVER STATE (USA)", "Dişi", "İngiliz", "WRONG HORSE (USA) - X")}
  ${row("DEEP IMPACT", "Erkek", "Arap", "SOMETHING ELSE - Y")}
  ${row("DEEP IMPACT (JPN)", "Erkek", "İngiliz", "SUNDAY SILENCE (USA) - WIND IN HER HAIR (USA)")}
  ${row("COUNTERATTACK", "Erkek", "İngiliz", "EPAULETTE (AUS) - ÜMİTLİ")}
  ${row("COUNTERATTACK* (AUS)", "Erkek", "İngiliz", "REDOUTE'S CHOICE (AUS) - KISMA (AUT)")}
</tbody></table>`;

const rows = parseHorseQueryRows(HTML);

eq("结果行数（表头行不计）", rows.length, 9);
eq("sup 角标不进名字", rows[0].name, "SMART ROBIN (JPN)");
eq("性别列", rows[0].sex, "Erkek");
eq("品种列", rows[2].irk, "Arap");

// Orijin 单元格
eq("Orijin 拆父（带国码）", sireOfOriginCell("KITTEN&#39;S JOY (USA) - GATA BELLA (USA)"), { name: "KITTEN'S JOY", country: "USA" });
eq("Orijin 拆父（无国码）", sireOfOriginCell("HABERBATUR - ÖZTAY"), { name: "HABERBATUR", country: null });
eq("Orijin 空", sireOfOriginCell(""), null);

// 精确匹配：SMART ROBIN 只有一行 → 拿到 DEEP IMPACT
eq("按父名取祖父", pickSireSire(rows, { name: "SMART ROBIN", country: "JPN", breed: "TB" }), {
  sire: { name: "DEEP IMPACT", country: "JPN" },
});
// 前缀同名（ÖZHABER OĞLU/ÖZHABERCAN 之类）必须排除，只认完全同名那一行
eq("排除前缀同名马", pickSireSire(rows, { name: "ÖZHABER", breed: "ARAB" }), {
  sire: { name: "HABERBATUR", country: null },
});
// 卡上写法不带国码也要能命中（节目页有些父名没标国码）
eq("无国码也能命中", pickSireSire(rows, { name: "SMART ROBIN" }), {
  sire: { name: "DEEP IMPACT", country: "JPN" },
});
// 国码否决：卡上写 (CAN) 时不认 (USA) 那匹
eq("国码不符 → 查无", pickSireSire(rows, { name: "SMART ROBIN", country: "CAN" }), { miss: 1 });
// 性别否决：只有牝馬同名 → 不能当父
eq("牝馬不能当父", pickSireSire(rows, { name: "SILVER STATE", country: "USA" }), { miss: 1 });
// 品种收窄：同名有英纯血与阿拉伯两匹，按场次品种选
eq("品种收窄取英纯血", pickSireSire(rows, { name: "DEEP IMPACT", breed: "TB" }), {
  sire: { name: "SUNDAY SILENCE", country: "USA" },
});
eq("品种收窄取阿拉伯", pickSireSire(rows, { name: "DEEP IMPACT", breed: "ARAB" }), {
  sire: { name: "SOMETHING ELSE", country: null },
});
// 不给品种时两匹都留着 → 父不同 → 留空待裁决（宁缺勿错）
eq("无品种信息且父不同 → 不填", Boolean(pickSireSire(rows, { name: "DEEP IMPACT" }).ambiguous), true);
// 查无此马
eq("查无此马", pickSireSire(rows, { name: "NO SUCH HORSE" }), { miss: 1 });
// 国码优先：同名有无国码的土产马与 (AUS) 进口马两行 → 按卡上国码选，无国码时才退到土产那行
eq("国码优先取同国", pickSireSire(rows, { name: "COUNTERATTACK", country: "AUS" }), {
  sire: { name: "REDOUTE'S CHOICE", country: "AUS" },
});
eq("卡上无国码且两匹父不同 → 不填", Boolean(pickSireSire(rows, { name: "COUNTERATTACK" }).ambiguous), true);
// 同名多匹且父不同 → 留空待裁决
const twins = parseHorseQueryRows(
  [row("TWIN", "Erkek", "İngiliz", "SIRE A - DAM1"), row("TWIN", "Erkek", "İngiliz", "SIRE B - DAM2")].join("")
);
const amb = pickSireSire(twins, { name: "TWIN" });
eq("同名歧义 → 不填", [Boolean(amb.ambiguous), Boolean(amb.sire)], [true, false]);
// 同名多匹但父一致 → 可以用
const same = parseHorseQueryRows(
  [row("TWIN2", "Erkek", "İngiliz", "SIRE A - DAM1"), row("TWIN2", "Erkek", "İngiliz", "SIRE A - DAM2")].join("")
);
eq("同名但父一致 → 采用", pickSireSire(same, { name: "TWIN2" }), { sire: { name: "SIRE A", country: null } });
// 空 html
eq("空页", parseHorseQueryRows(""), []);

console.log(`\n${fail ? "FAIL" : "PASS"}  通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
