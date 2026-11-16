// name-lookup.json v1 → v2 迁移：一个名字从「一名一答」升级为「按语境两答」。
//
// 为什么改：v1 记录只有 resolvedId 一个答案，同名异马（Silver State(USA) vs シルバーステート(JPN)）
// 在结构上装不下，只能靠下游硬判。v2 让记录自己表达「日系语境答案 / 海外语境答案」，
// 其中海外侧可以明确为 null（= 名字对上了，但不是同一匹马），而不是被压成「无数据」。
//
// 幂等：已是 v2 的记录原样保留（只在缺字段时补齐），可重复运行。
// 用法：node src/migrate-lookup-v2.js [--dry]
import fs from "node:fs";
import { loadHomonym } from "./lib/homonym.js";
import { normalizeHorseName } from "./lib/horse-name.mjs";

const FILE = "data/pedigree/name-lookup.json";
const DRY = process.argv.includes("--dry");

// 两个答案是否同解（intl 稀疏覆盖的判定；null 与 null 同解）
const sameAnswer = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && (a.sire?.id ?? null) === (b.sire?.id ?? null) && (a.name ?? null) === (b.name ?? null);
};

const homonym = loadHomonym();
const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
const out = {};
const stat = { total: 0, already: 0, migrated: 0, answered: 0, ambiguous: 0, preferred: 0, intlBlocked: 0, unresolved: 0 };

for (const [key, rec] of Object.entries(raw)) {
  stat.total++;
  stat.already += rec.schema === "ped.lookup.jbis/v2" ? 1 : 0;

  const name = rec.name ?? key;
  const blocked = homonym.blockedForIntl(name);
  const adjudicated = Boolean(homonym.get(name));

  // v1 → 答案对象（旧字段是唯一答案）；intl 只在「与 jpn 不同」时才写出（稀疏覆盖）
  const legacy = rec.resolvedId
    ? {
        id: rec.resolvedId,
        name: rec.resolvedName ?? rec.name ?? null,
        birth: rec.birth ?? null,
        sex: rec.sex ?? null,
        stallion: Boolean(rec.stallion),
        sire: rec.sire ?? null,
        dam: rec.dam ?? null,
      }
    : null;

  const jpn = rec.answers?.jpn ?? legacy;
  const answers = { jpn };
  const prevIntl = rec.answers && "intl" in rec.answers ? rec.answers.intl : undefined;
  if (blocked) answers.intl = null; // 裁决：海外语境明确无答案
  else if (prevIntl !== undefined && !sameAnswer(prevIntl, jpn)) answers.intl = prevIntl;
  // 其余情况省略 intl = 与 jpn 同解

  const next = {
    schema: "ped.lookup.jbis/v2",
    key: rec.key ?? key,
    name,
    answers,
    candidates: rec.candidates ?? [],
    hits: rec.hits ?? 0,
    via: rec.via ?? (rec.viaPreferred ? "preferred" : rec.viaEn ? "nameEn" : "search"),
    viaEn: Boolean(rec.viaEn),
    viaPreferred: Boolean(rec.viaPreferred),
    // 答案不是唯一证据：多候选靠「種 + 年龄」挑，或直接采信现役种公马缓存没搜过
    ambiguous: rec.ambiguous ?? ((rec.candidates ?? []).length > 1 || Boolean(rec.viaPreferred)),
    adjudicated,
    capturedAt: rec.capturedAt ?? null,
  };
  // 旧字段（resolvedId/resolvedName/birth/sex/stallion/sire/dam）不再写：v2 里 answers.jpn 就是它，
  // 读取端一律走 answerOf()，避免同一份数据存两遍（体积翻倍）。

  if (next.answers.jpn) stat.answered++;
  else stat.unresolved++;
  if (next.ambiguous) stat.ambiguous++;
  if (next.viaPreferred) stat.preferred++;
  if (next.adjudicated) stat.intlBlocked++;
  if (rec.schema !== "ped.lookup.jbis/v2") stat.migrated++;

  out[key] = next;
}

console.log(
  `[migrate] 总 ${stat.total} / 已 v2 ${stat.already} / 本次迁移 ${stat.migrated} / 有日系答案 ${stat.answered} / 未解析 ${stat.unresolved}\n` +
    `[migrate] 其中 ambiguous ${stat.ambiguous}（多候选或缓存直采）/ viaPreferred ${stat.preferred} / 裁决命中 ${stat.intlBlocked}`
);

if (DRY) {
  console.log("[migrate] --dry：未写盘");
} else {
  fs.writeFileSync(FILE, JSON.stringify(out));
  console.log(`[migrate] 已写回 ${FILE}`);
}
