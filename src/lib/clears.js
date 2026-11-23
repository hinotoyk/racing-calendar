// 「故意清空」账本（2026-11-23）
//
// 为什么需要它：审计/恢复的判据是「无值不能覆盖有值」，但有些清空是**人为校验后的纠正**
// （例：audit-homonym --fix 会把「父马性别为牝」这种不可能成立的祖父绑定置 null）。
// 若不区分，恢复逻辑会把错数据又填回去，审计也会天天报警。
//
// 账本落在 data/clears.json（入库，CI 可读）：
//   { "version":1, "entries": { "data/races/2026-11-01/x.json.gz|rk:945412|h:rp:1": { "fields":["sireSire"], "reason":"性别矛盾（牝）", "at":"..." } } }
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve("data", "clears.json");

/** 统一成仓库内的相对 POSIX 路径（并去掉 .gz 后缀），避免 Windows 绝对路径/分隔符差异导致匹配失败 */
export function normFile(f) {
  let s = String(f).replace(/\\/g, "/");
  const i = s.indexOf("data/");
  if (i > 0) s = s.slice(i);
  return s.replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\.gz$/, "");
}

export function loadClears() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return j.entries ?? {};
  } catch {
    return {};
  }
}

function save(entries) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 1));
}

/** 记录一批「故意清空」。list: [{key, field, reason}] */
export function recordClears(list) {
  if (!list?.length) return 0;
  const entries = loadClears();
  const at = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const { key, field, reason } of list) {
    const k = normKey(key);
    const e = entries[k] ?? { fields: [], reason: reason ?? "", at };
    if (!e.fields.includes(field)) e.fields.push(field);
    if (reason) e.reason = reason;
    entries[k] = e;
    n++;
  }
  save(entries);
  return n;
}

/** 归一键：file|rk:...|h:... */
export function normKey(key) {
  const parts = String(key).split("|");
  return [normFile(parts[0]), ...parts.slice(1)].join("|");
}

/**
 * 把 diffDowngrades 的路径解析成账本键。
 * 例：races[rk:945412].runners[h:rp:1243224].sireSire → key=rk:945412|h:rp:1243224, field=sireSire
 */
export function parseDropPath(p) {
  const m = /^races\[([^\]]+)\]\.runners\[([^\]]+)\]\.([A-Za-z0-9_.]+)$/.exec(p ?? "");
  if (!m) return null;
  return { raceKey: m[1], horseKey: m[2], field: m[3] };
}

/**
 * 该降级点是否已被账本登记为「故意清空」。
 * @param {object} entries loadClears() 的结果
 * @param {string} file 文档相对路径
 */
export function isClearedDrop(entries, file, dropPath) {
  const parsed = parseDropPath(dropPath);
  if (!parsed) return false;
  const rec = entries[`${normFile(file)}|${parsed.raceKey}|${parsed.horseKey}`];
  if (!rec) return false;
  return (rec.fields ?? []).includes(parsed.field);
}
