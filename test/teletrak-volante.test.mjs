// Teletrak volante 解析的回归测试（零依赖，纯逻辑）
//   node test/teletrak-volante.test.mjs
// 覆盖 2026-11-18 VSC / 2026-11-17 CHC 实测 PDF 里发现的六种行合并/错位形态：
//   A) 「kg num Ed Jockey - Trainer」压成一行（"58 10 4 R. Fournet - J. Araya"）
//   B) 「kg num」粘进马名行尾（"IMPERIO BABILONICO - Classic Empire (usa)  58 9"）
//   C) 上一匹数字行 + 彩衣行被误认成下一匹起点（幽灵马 "481 33 Chino Emperador - Amar,…"）
//   D) 整行全合并（"VERDURITAFRESCA- Modernist (usa)   57 12 3 F. Tapia - B. Toledo"）
//   E) 年龄与骑师名粘连（"12D. Carvacho - R. Olivares"）
//   F) CHC 毛色码整行缺席导致 Ed 错位（SONRIELE 无 B 行）+ 缩写连写练马师（"L.G. Soto"）
//   + 骑师行首数字恰好等于马号计数器（"6 N. Rojas - A. Norambuena" → 不得当作 6 号马起点）
import { parseVolanteChunk, splitVolante } from "../src/sources/teletrak.js";

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`); }
};

// ---------- VSC：一段含 A/B/C/D/E 全部形态的块 ----------
// 场景还原自 VOLANTE_18_nov_COLOR.pdf：
//  - #3 HOOTEROAD 正常；#4 PERDUTO 的赔率行「3」+ 彩衣行「481 33 …」不得产生幽灵 3 号；
//    #5 SUGAR LIGHT 为形态 A；#6 IMPERIO BABILONICO 为形态 B；#7 VERDURITAFRESCA 为形态 D；
//    #8 COMMAND 的骑师行首数字「12」不等于计数器；#9 GRINGAUNICA 为形态 A 且年龄与骑师名粘连前
//    正常 #8 的骑师行「12D. Carvacho」恰好是形态 E。
const VSC_CHUNK = [
  "19:00 aprox. 1.100 Mts. (4.452)   Premio: GUILLERMO CASTRO S.    $1.400.000 al 1ro.",
  "HANDICAP 5a. Serie  Indice: 7 al 6 Pista: ARENA",
  "1",
  "MORINGA- Seeking The Dia",
  "58 1",
  "5 J. Eyzaguirre - V. Caballeria",
  "1va 5va 2va 111126 1.100 10-5",
  "2 1/4 1:09:42",
  "6,8",
  "454 7 Los Caleranos - Rojo Estrellas YBrazaletesBlanco Gor",
  "5",
  "2",
  "HIJO DELREY- Artigal",
  "58 2",
  "5 J. Medina - W. Mancilla",
  "2va 1va 3va 281026 1.200",
  "11,8 449 7 Rafael Sanchez A. - Solferino, Mangas Solferino YBlan",
  "2,5",
  "3",
  "481 33 Chino Emperador - Amar,estrells,rojo Mg Blnc YRojo En",
  "9",
  "3",
  "HOOTEROAD - Hootenanny (usa)",
  "59 3",
  "6 K. Espina - V. Moris",
  "7va 1va 5va 281026 1.100 9-8",
  "7 1/2 1:09:00",
  "8,7",
  "453 7 ALo Caballero - Blanco, Rombos Negro,Mangas YGorra",
  "9",
  "4",
  "SUGAR LIGHT- Hiraboku Deep (jap)",
  "56 4",
  "5 G. A. Perez - J. Leiva",
  "4va 7va 6va 111126 1.200",
  "44,9 450 29 Los Leones - Blanco, Triangulos YMangas Rojo, Gorra E",
  "11",
  "5",
  "IMPERIO BABILONICO - Classic Empire (usa)  58 5",
  "5 K. Espina - V. Moris",
  "7va 1va 5va 281026 1.100 9-8",
  "8,7",
  "453 7 ALo Caballero - Blanco, Rombos Negro,Mangas YGorra",
  "9",
  "6",
  "VERDURITAFRESCA- Modernist (usa)   57 6 3 F. Tapia - B. Toledo",
  "D E B U T A",
  "Pascuala - Blanco, Banda Negro, Mangas En Rueda, Gorr",
  "31",
  "7",
  "COMMAND -  Lookin At Lucky",
  "57 7",
  "12D. Carvacho - R. Olivares",
  "11va 9va 10va091126 1.100",
  "1",
  "12 1/2 1:10:50",
  "77,1 446 1 Joaquin Herrera O. - Azul Mangas Blanco YRojo Listad",
  "11",
  "8",
  "GRINGAUNICA- Unitarian",
  "57 8 9 M. Salinas - I. Maffud",
  "8va 5va 3va 041126 1.100",
  "3,3",
  "463 1 De Quiva`s - Amarillo, Estrella Azul,Mangas Blanco, G",
  "31",
];
const runners = parseVolanteChunk(VSC_CHUNK, "vsc");
eq("VSC: 不产生幽灵马，恰好 8 匹", runners.map((h) => h.num), [1, 2, 3, 4, 5, 6, 7, 8]);
eq("VSC: 无幽灵马名", runners.every((h) => /^[A-ZÁÉÍÓÚÑ]/.test(h.horse.name ?? "") && !/\d/.test(h.horse.name)), true);
const byNum = Object.fromEntries(runners.map((h) => [h.num, h]));
eq("VSC A: GRINGAUNICA(形态A)", [byNum[8].age, byNum[8].jockey.name, byNum[8].weight, byNum[8].trainer.name], [9, "M. Salinas", 57, "I. Maffud"]);
eq("VSC B: IMPERIO BABILONICO(形态B)", [byNum[5].age, byNum[5].jockey.name, byNum[5].weight, byNum[5].trainer.name, byNum[5].sire.name, byNum[5].sire.country], [5, "K. Espina", 58, "V. Moris", "Classic Empire", "USA"]);
eq("VSC D: VERDURITAFRESCA(形态D)", [byNum[6].age, byNum[6].jockey.name, byNum[6].weight, byNum[6].trainer.name, byNum[6].sire.name, byNum[6].sire.country], [3, "F. Tapia", 57, "B. Toledo", "Modernist", "USA"]);
eq("VSC E: COMMAND(年龄与骑师名粘连)", [byNum[7].age, byNum[7].jockey.name, byNum[7].weight, byNum[7].trainer.name], [12, "D. Carvacho", 57, "R. Olivares"]);
eq("VSC C: HOOTEROAD 不被吞（真 3 号在）", [byNum[3].horse.name, byNum[3].age, byNum[3].jockey.name], ["HOOTEROAD", 6, "K. Espina"]);
eq("VSC 正常: MORINGA", [byNum[1].age, byNum[1].jockey.name, byNum[1].weight, byNum[1].trainer.name], [5, "J. Eyzaguirre", 58, "V. Caballeria"]);
eq("VSC: 骑师行「6 K. Espina」不等于马号起点(计数器=4 时)", byNum[4].horse.name, "SUGAR LIGHT");

// ---------- VSC: 骑师行首数字恰好等于马号计数器（11-18 1R GIPSYVANNER 实测） ----------
const GIPSY_CHUNK = [
  "1",
  "CAMPO DE BATALLA- Mo Town",
  "56 1",
  "6 A. I. Maureira - X. Urenda",
  "7va 7va 4va 021126 1.100",
  "8,3 450 29 Los Leones - Blanco, Triangulos YMangas Rojo, Gorra E",
  "11",
  "2",
  "PERDUTO - Seeking The Dia",
  "59 2",
  "4 G. Rodriguez - G. Reyes I.",
  "3",
  "481 33 Chino Emperador - Amar,estrells,rojo Mg Blnc YRojo En",
  "9",
  "3",
  "HOOTEROAD - Hootenanny (usa)",
  "59 3",
  "6 K. Espina - V. Moris",
];
const gRunners = parseVolanteChunk(GIPSY_CHUNK, "vsc");
eq("骑师行数字=计数器: 仍按真马号起点", gRunners.map((h) => `${h.num}:${h.horse.name}`), ["1:CAMPO DE BATALLA", "2:PERDUTO", "3:HOOTEROAD"]);

// ---------- CHC: 毛色码缺席 + 缩写连写练马师（11-17 102182-1.pdf 实测） ----------
const CHC_CHUNK = [
  "(12:30) Hrs. Premio : \"SERIE A\"",
  "1",
  "GRAN DREAMER (Aragorn II)",
  "B",
  "4",
  "56 Jn.A. Campos",
  "J. Espinosa",
  "10-Nov",
  "4-4",
  "479",
  "1-1",
  "1000",
  "3 1/4",
  "0.57.51",
  "$ 17",
  "PETALO",
  "2",
  "SONRIELE (Flyer)",
  "7",
  "56 G. Urzúa",
  "L.G. Soto",
  "10-Nov",
  "7-7",
  "437",
  "1-1",
  "1000",
  "8 1/2",
  "0.57.51",
  "$ 8",
  "BARRERA A., HECTOR",
];
const cRunners = parseVolanteChunk(CHC_CHUNK, "chc");
const cBy = Object.fromEntries(cRunners.map((h) => [h.num, h]));
eq("CHC 毛色在: GRAN DREAMER", [cBy[1].age, cBy[1].weight, cBy[1].jockey.name, cBy[1].trainer.name, cBy[1].tk.colour], [4, 56, "Jn.A. Campos", "J. Espinosa", "B"]);
eq("CHC 毛色缺席: SONRIELE 年龄仍取到", [cBy[2].age, cBy[2].weight, cBy[2].jockey.name, cBy[2].trainer.name, cBy[2].tk.colour], [7, 56, "G. Urzúa", "L.G. Soto", null]);

// ---------- splitVolante 版式判定不被干扰 ----------
eq("splitVolante: chc 版式", splitVolante(CHC_CHUNK.join("\n")).format, "chc");
eq("splitVolante: vsc 版式", splitVolante(VSC_CHUNK.join("\n")).format, "vsc");

// ---------- CHS: 负磅粘连进马名行 → 年龄成为独立行（11-16 CHS 实测 26 頭踩坑） ----------
const CHS_CHUNK = [
  "1ª",
  "20:00 aprox. 1.200 Mts.   Premio: PRACTICO    $1.200.000 al 1ro.",
  "1",
  "DON AMERICAO** - Practical Joke (usa)56",
  "4",
  "G. Mendez",
  "H. Martinez R.",
  "1°cn2 2°cn1 24-10-25 1000 Cd",
  "6 ¼ 01:00.25 $7.4",
  "456 HARAS DEL SUR - Azul Banda",
  "2",
  "SUPER MARTINA** - Mustaaqeem (aus)54",
  "4",
  "M. Caro",
  "Fco. Pinochet P.",
  "1R2 8°cn2 8°cn1",
  "01:00.25 $7.4",
  "426 TRANSPORTES MENDEZ - Verde Mangas A",
];
const hRunners = parseVolanteChunk(CHS_CHUNK, "chs");
const hBy = Object.fromEntries(hRunners.map((h) => [h.num, h]));
eq("CHS 粘连负磅: #1 年龄/负重仍取到", [hBy[1].age, hBy[1].weight, hBy[1].jockey.name, hBy[1].trainer.name], [4, 56, "G. Mendez", "H. Martinez R."]);
eq("CHS 粘连负磅: #2 年龄/负重仍取到", [hBy[2].age, hBy[2].weight, hBy[2].jockey.name, hBy[2].trainer.name], [4, 54, "M. Caro", "Fco. Pinochet P."]);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
