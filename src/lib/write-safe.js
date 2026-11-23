// 统一的「安全写盘」入口：所有重建整份赛事文档的地方都走它。
//
// 语义：读已存文档 → 与本轮结果做字段级合并（merge-safe.mjs）→ 落盘。
//   有值覆盖无值 ✅        无值覆盖有值 ❌（保留已存值）
//
// opts.raw = true 可跳过合并（仅用于「本来就是清字段」的脚本，如 strip-foreign-frame）。
import fs from "node:fs";
import { readGz, writeGz } from "./bundle.js";
import { mergeDocSafe } from "./merge-safe.mjs";

/** 读取文档：base 可带或不带 .gz（与 writeGz 同风格） */
export function readDocSafe(base) {
  const gz = base.endsWith(".gz") ? base : `${base}.gz`;
  for (const p of [gz, base]) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = p.endsWith(".gz") ? readGz(p) : fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 安全写盘。
 * @param {string} base 目标路径（.json 或 .json.gz 均可）
 * @param {object} doc 本轮产出
 * @param {{raw?:boolean, label?:string, log?:boolean}} [opts]
 * @returns {{doc:object, merged:boolean, preserved:number, keptRaces:string[]}}
 */
export function writeDocSafe(base, doc, { raw = false, label = "", log = true } = {}) {
  const existing = raw ? null : readDocSafe(base);
  const { doc: out, stats } = existing ? mergeDocSafe(existing, doc) : { doc, stats: { preserved: 0, keptRaces: [] } };
  writeGz(base, JSON.stringify(out));
  if (log && existing && (stats.preserved || stats.keptRaces.length)) {
    const tag = label || base;
    const parts = [];
    if (stats.preserved) parts.push(`保住 ${stats.preserved} 处空值覆盖`);
    if (stats.keptRaces.length) parts.push(`保留缺席场次 ${stats.keptRaces.join(",")}`);
    console.log(`[merge] ${tag}: ${parts.join(" / ")}`);
  }
  return { doc: out, merged: !!existing, ...stats };
}
