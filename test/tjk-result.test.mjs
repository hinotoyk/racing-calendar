// TJK 赛果 CSV 解析的回归测试（零依赖，纯逻辑）
//   npm test   或   node test/tjk-result.test.mjs
// 覆盖：场次头（含带赛名写法）/ 奖金与表头行跳过 / 着顺与 Withdrawn / 闸位 DS /
//       双彩池人气取第一组 / 土耳其小数逗号 / 着差口径（Lengths·Half·Nose·Neck）
import { parseResultCsv } from "../src/sources/tjk.js";

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`); }
};

// 两个场次：R1 普通（含退出马），R2 带赛名 + G2 + DS 闸位 + 双彩池人气
const CSV = [
  "İstanbul;(93. Race Day);15/11/2026",
  "1. Race 14.00;Handicap 15/DHÖW; 3 Years Old Purebred Arabians; kg; 1900m; Turf;;;;Best Timing :2.04.59",
  "Prize;;;;;Breeder Premium;;;;",
  "1.)595.000 TL;2.)238.000 TL;3.)119.000 TL;4.)59.500 TL;5.)29.750 TL;1.)178.500 TL;",
  "No;Horse Name;Age;Sire;Dam;Weight;Jockey;Owner;Trainer;St;PSF;R;Time;Win;Margin,;LR;L20;BestTime",
  "1;EFE KAPTAN B TT;3yo ch c;GÜMBÜRGÜMBÜR;DRAMATİK;51,5 +1.10;A.KAÇMAZ;TAMER KOLDAŞ;C.TURAN;4;%4.16(9);40;2:13.49;16,60;2,5 Lengths",
  "2;YALNIZ AŞIK B;3yo ch c;AŞIKBEY;JETKIZ;57,5;H.ÇİZİK;ALİ TOYDEMİR;O.DEMİR;1;%19.67(2);52;2:13.87;2,95;Half Length",
  "3;AMENTES H (Withdrawn);3yo b c;X;Y;57;J;O;T;2;%0.8(8);30;Withdrawn;;",
  "",
  "5. Race :  SAKARYA RACE 16.00;G 2/ULS; 2 Years Old Thoroughbreds; 57.00kg; 1800m; Turf;;;;Best Timing :1.49.05",
  "Prize;;;;;Breeder Premium;;;;",
  "No;Horse Name;Age;Sire;Dam;Weight;Jockey;Owner;Trainer;St;PSF;R;Time;Win;Margin,;LR;L20;BestTime",
  "1;BATURALP CAN B;2yo gr c;MARCAVELLY (USA);SNOWFLAKE;57 +0.60;H.ÇİZİK;CAHİT KOCAMAN;B.TANRIVER;11 - DS;%2.32(9)  %2.56(9);40;1:54.57;24,40;Nose",
  "2;HAYRETBİŞEY CP;2yo b c;KIRCAALİ;PLAYA DEL AMOR;57;H.KARATAŞ;FEDAİ KAHRAMAN;Y.ŞİMŞEK;2;%45.16(1)  %43.4(1);44;1:54.63;1,85;Neck",
].join("\n");

const races = parseResultCsv(CSV);

eq("场次数", races.length, 2);
eq("场次号排序", races.map((r) => r.no), [1, 5]);
eq("时刻（带赛名写法也取到最后一处）", races.map((r) => r.startTime), ["14:00", "16:00"]);
eq("距离/场地", [races[0].distance, races[0].surface], [1900, "Turf"]);
eq("冠军用时", races.map((r) => r.winningTime), ["2:13.49", "1:54.57"]);
eq("奖金行与表头不入行", races[0].rows.length, 3);

const r1 = races[0].rows;
eq("着顺取值", r1.map((x) => x.finish), [1, 2, "取"]);
eq("Withdrawn 仍保留源行序号", r1[2].finishRank, 3);
eq("马名保留装备码原样", r1[0].nameRaw, "EFE KAPTAN B TT");
eq("退出马去掉 (Withdrawn) 标记", r1[2].nameRaw, "AMENTES H");
eq("负重与超重", [r1[0].weight, r1[0].weightOver], [51.5, 1.1]);
eq("人气取括号里的排名", r1.map((x) => x.agfRank), [9, 2, 8]);
eq("人气占比", r1[0].agfPct, 4.16);
eq("独赢赔率（土耳其逗号）", r1[0].winOdds, 16.6);
eq("着差 2,5 Lengths", r1[0].margin, "2.5");
eq("着差 Half Length", r1[1].margin, "0.5");
eq("退出马无走破时", r1[2].time, null);

const r2 = races[1].rows;
eq("闸位带 DS", [r2[0].gate, r2[0].outerStart], [11, true]);
eq("普通闸位", [r2[1].gate, r2[1].outerStart], [2, false]);
eq("双彩池人气取第一组", [r2[0].agfPct, r2[0].agfRank], [2.32, 9]);
eq("着差 Nose", r2[0].margin, "鼻");
eq("着差 Neck", r2[1].margin, "颈");
eq("让赛评分", [r2[0].rating, r2[1].rating], [40, 44]);

// 空输入 / 只有表头
eq("空文本", parseResultCsv(""), []);
eq("只有表头无数据行", parseResultCsv("No;Horse Name;Age\n").length, 0);

console.log(`\n${fail ? "FAIL" : "PASS"}  通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
