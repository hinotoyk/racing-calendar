// 血统缓存「单文件存储」：CI 在 GitHub Actions 上增量累积。
// 逐 id 小文件（sire/{id}.json / horse/{id}.json）会把仓库撑成十万级文件（git 索引/检出变慢），
// 故每个来源一个 JSON 包 { "<id>": record }：体积线性、文件数恒定（3 个）。
// 写盘策略：每 flushEvery 次 set 落一次盘（崩溃最多丢几十条，重抓即可），进程结束前显式 save()。
import fs from "node:fs";
import path from "node:path";

export function pedCache(file, { flushEvery = 50 } = {}) {
  let map = null;
  let dirty = 0;
  const load = () => {
    if (map) return map;
    try {
      map = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      map = {};
    }
    return map;
  };
  const save = () => {
    if (!dirty) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map));
    dirty = 0;
    return true;
  };
  return {
    get(key) {
      return load()[key] ?? null;
    },
    set(key, rec) {
      load()[key] = rec;
      if (++dirty >= flushEvery) save();
    },
    save,
    size() {
      return Object.keys(load()).length;
    },
  };
}
