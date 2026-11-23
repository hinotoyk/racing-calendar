// 枠番继承的回归测试（零依赖，纯逻辑）
//   npm test   或   node test/frame-inherit.test.mjs
// 背景：全量档 JST 凌晨重采时 JBIS 还没出枠順，会把 backfill-waku 补好的枠番清空
// （2026-11-23 线上事故）。此处锁定「只填空、不覆盖、按场次隔离」三条规则。
import { inheritFrame } from "../src/lib/frame-inherit.mjs";

const R = (id, frame, num = 1) => ({ num, frame, horse: { id } });
const D = (...races) => ({ races });

let pass = 0;
let fail = 0;
const cases = [
  // [说明, existing, doc, 期望继承数, 期望 doc 中 frame 值]
  ["无旧文档 → 不继承", null, D({ no: 1, runners: [R("h1", null)] }), 0, [null]],
  ["旧文档无枠番 → 不继承", D({ no: 1, runners: [R("h1", null)] }), D({ no: 1, runners: [R("h1", null)] }), 0, [null]],
  ["新值为空 → 继承", D({ no: 1, runners: [R("h1", 3)] }), D({ no: 1, runners: [R("h1", null)] }), 1, [3]],
  ["新值非空 → 新值优先（改枠）", D({ no: 1, runners: [R("h1", 3)] }), D({ no: 1, runners: [R("h1", 5)] }), 0, [5]],
  ["马不同 → 不继承", D({ no: 1, runners: [R("h1", 3)] }), D({ no: 1, runners: [R("h2", null)] }), 0, [null]],
  [
    "场次隔离（R1 的枠不能串到 R2）",
    D({ no: 1, runners: [R("h1", 7)] }),
    D({ no: 2, runners: [R("h1", null)] }),
    0,
    [null],
  ],
  [
    "混合：部分继承、部分保留新值",
    D({ no: 1, runners: [R("h1", 1), R("h2", 2), R("h3", 3)] }),
    D({ no: 1, runners: [R("h1", null), R("h2", null), R("h3", 8)] }),
    2,
    [1, 2, 8],
  ],
  ["runner 为空数组 → 不炸", D({ no: 1, runners: [R("h1", 3)] }), D({ no: 1, runners: [] }), 0, []],
];

for (const [name, existing, doc, wantN, wantFrames] of cases) {
  const n = inheritFrame(existing, doc);
  const got = doc.races[0].runners.map((x) => x.frame);
  const ok = n === wantN && JSON.stringify(got) === JSON.stringify(wantFrames);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} → 继承 ${n}（期望 ${wantN}）frames=${JSON.stringify(got)}（期望 ${JSON.stringify(wantFrames)}）`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
