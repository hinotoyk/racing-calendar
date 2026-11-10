// 采集覆盖保护 + manifest 记录 schema 的回归测试（零依赖，纯逻辑）
//   npm test   或   node test/guard.test.mjs
import { guardOverwrite, manifestEntry } from "../src/lib/guard.js";

const doc = (...runnersPerRace) => ({
  races: runnersPerRace.map((n, i) => ({
    no: i + 1,
    status: n ? "entries" : "result",
    runners: Array.from({ length: n }, (_, k) => ({ num: k + 1, frame: 1 })),
  })),
});
// 生成一个总头数为 total 的单场文档
const total = (n) => doc(n);

let pass = 0;
let fail = 0;
const cases = [
  // [说明, existing, doc, opts, 期望 keep, 期望 reason]
  ["首次采集（无旧文档）", null, total(0), {}, false, null],
  ["首次采集，有数据", null, total(12), {}, false, null],
  ["旧 117 头 → 本次 0 头（空壳）", total(117), total(0), {}, true, "空壳"],
  ["旧 117 头 → 本次 12 头（rp-326 实况 10%）", total(117), total(12), {}, true, "腰斩(<50%)"],
  ["旧 117 头 → 本次 60 头（51%，边界内放行）", total(117), total(60), {}, false, null],
  ["旧 18 头 → 15 头（正常取消出走）", total(18), total(15), {}, false, null],
  ["旧 18 头 → 8 头（腰斩）", total(18), total(8), {}, true, "腰斩(<50%)"],
  ["旧 18 头 → 9 头（恰好 50%，放行）", total(18), total(9), {}, false, null],
  ["旧 4 头 → 0 头（小场也要保护）", total(4), total(0), {}, true, "空壳"],
  ["旧 4 头 → 1 头（<5 头不适用腰斩判据）", total(4), total(1), {}, false, null],
  ["--force 空壳也放行", total(117), total(0), { force: true }, false, null],
  ["--force 腰斩也放行", total(117), total(12), { force: true }, false, null],
  ["部分采集少 1 头 → 保留", total(18), total(17), { partial: true }, true, "部分采集少于已存"],
  ["部分采集持平 → 放行", total(18), total(18), { partial: true }, false, null],
  ["全量采集少 1 头 → 放行", total(18), total(17), {}, false, null],
  ["旧空壳 → 本次空壳", total(0), total(0), {}, false, null],
  ["旧空壳 → 本次有数据", total(0), total(12), {}, false, null],
  ["多场文档整体腰斩（12R/120头 → 12R/12头）", doc(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10), doc(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1), {}, true, "腰斩(<50%)"],
];

for (const [label, existing, fresh, opts, wantKeep, wantReason] of cases) {
  const r = guardOverwrite(existing, fresh, opts);
  const ok = r.keep === wantKeep && r.reason === wantReason;
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(42)} keep=${String(r.keep).padEnd(5)} reason=${String(r.reason)}  (${r.existed}→${r.fresh})` +
      (ok ? "" : `  期望 keep=${wantKeep} reason=${wantReason}`)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);

// ---- manifestEntry：成功/失败两条路径的 schema 必须一致 ----
console.log("\n== manifestEntry schema ==");
const REQUIRED = ["venue", "scope", "races", "decoded", "runners", "status", "capturedAt"];
const check = (label, entry, wantStatus, wantError) => {
  const missing = REQUIRED.filter((k) => entry[k] === undefined);
  const extra = Object.keys(entry).filter((k) => !REQUIRED.includes(k));
  const ok =
    missing.length === 0 &&
    entry.status === wantStatus &&
    (wantError ? typeof entry.lastError === "string" && entry.lastError.length > 0 : entry.lastError === undefined) &&
    extra.every((k) => k === "lastError");
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(38)} status=${entry.status} 缺失=[${missing}] 额外=[${extra}]` +
      (entry.lastError ? ` lastError="${entry.lastError.slice(0, 24)}…"` : "")
  );
  ok ? pass++ : fail++;
};

// 1) 成功路径
check(
  "成功：12R/142头",
  manifestEntry({ venue: "盛岡", scope: "local", stats: { races: 12, decoded: 12, runners: 142 }, capturedAt: "2026-11-07T00:00:00+09:00" }),
  "ok",
  false
);
// 2) 失败但已有完整旧文档（旧实现会写成 {venue,status:"error"}）
check(
  "失败：沿用旧文档 142 头",
  manifestEntry({
    venue: "盛岡",
    scope: "local",
    stats: { races: 12, decoded: 12, runners: 142 },
    capturedAt: "2026-11-07T00:00:00+09:00",
    error: "2026-11-10T00:00:00+09:00 fetch failed",
  }),
  "ok",
  true
);
// 3) 失败且从未采到过
check(
  "失败：无旧数据（0 头）",
  manifestEntry({ venue: "門別", scope: "local", stats: { races: 0, decoded: 0, runners: 0 }, capturedAt: null, error: "2026-11-10T00:00:00+09:00 404" }),
  "pending",
  true
);
// 4) 空壳文档（采集成功但解析出 0 头）
check(
  "成功但空壳：0 头",
  manifestEntry({ venue: "園田", scope: "local", stats: { races: 12, decoded: 0, runners: 0 }, capturedAt: "2026-11-10T00:00:00+09:00" }),
  "pending",
  false
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

