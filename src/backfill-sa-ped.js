// 南美出走表血统/性别回填（离线，只改已落盘 docs，不联网）
//
// 背景：LP/TK 源页面只给「父 - 母」（LP）或「父」（TK），母父/父父/性别缺失；
// SI 源自带父/母/母父（带 id），si-horse / si-sire 缓存里存了马与种马的血统。
// 本脚本做两件事：
//   1. 性别推断补齐：LP/TK 源只有条件文本（race.lp.condicion / race.tk.headRaw），
//      用 sexFromConditionEs 补赛事级性别（新采集已内置，此步覆盖已落盘的旧文档）。
//   2. 名字级交叉回填（仅 ARG —— 阿根廷马名全国唯一，匹配安全）：
//      - 父父：本马在 SI 缓存 → sire id → si-sire 缓存；或 sire 名在 SI 缓存（作为马）→ 其父亲
//      - 母父：本马在 SI 缓存 → 直接 bms；或 dam 名在 SI 缓存 → dam 的父亲
// 幂等：只填缺失字段，不覆盖已有值；无变化不写盘。
// 用法：node src/backfill-sa-ped.js
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { sexFromConditionEs } from "./sources/normalize.js";

const key = (s) => String(s ?? "").trim().toUpperCase();

function loadCaches(horses) {
  const sire = JSON.parse(fs.readFileSync("data/pedigree/si-sire.json", "utf8"));
  // pedByName: 马名 → { sireId, bms }（SI 马页缓存，按马名索引）
  // sireIdByName: 种马名 → 种马 id（SI 缓存里出现的父系）
  // sireSireById: 种马 id → 父父名（si-sire 缓存，503 负缓存条目自然跳过）
  const pedByName = new Map();
  const sireIdByName = new Map();
  for (const [hid, rec] of Object.entries(horses)) {
    if (rec?.sire?.name) {
      pedByName.set(key(rec.name ?? hid.replace("si:", "")), { sireId: rec.sire.id ?? null, bms: rec.bms?.name ?? null });
      if (rec.sire.id) sireIdByName.set(key(rec.sire.name), rec.sire.id);
    }
  }
  const sireSireById = new Map();
  for (const [sid, rec] of Object.entries(sire)) {
    if (rec?.sire?.name) sireSireById.set(sid, rec.sire.name);
  }
  // id → 马名（供 dam 父亲反查）
  const nameById = new Map();
  for (const [hid, rec] of Object.entries(horses)) {
    nameById.set(hid, rec?.name ?? hid.replace("si:", ""));
  }
  return { pedByName, sireIdByName, sireSireById, nameById };
}

function patchDoc(doc, caches) {
  const country = doc.country ?? null;
  let changed = 0;
  const stat = { sireSireFills: 0, bmsFills: 0, sexFills: 0 };
  for (const race of doc.races ?? []) {
    for (const r of race.runners ?? []) {
      const patch = {};

      // --- 性别（LP/TK 条件文本；SI 已有；TOL 无源不动） ---
      if (!r.sex) {
        const text = race?.lp?.condicion ?? race?.tk?.headRaw ?? null;
        const sex = sexFromConditionEs(text);
        if (sex) {
          patch.sex = sex;
          stat.sexFills++;
        }
      }

      if (country === "ARG") {
        // --- 父父：本马在 SI 缓存 → sire id → si-sire；或 sire 名在 SI 缓存（作为马）→ 其父亲 ---
        if (!r.sireSire) {
          const own = caches.pedByName.get(key(r.horse?.name));
          const sid = own?.sireId ?? caches.sireIdByName.get(key(r.sire?.name));
          const ss = sid ? caches.sireSireById.get(sid) : null;
          if (ss) {
            patch.sireSire = { id: null, name: ss };
            stat.sireSireFills++;
          }
        }

        // --- 母父：本马在 SI 缓存 → bms；或 dam 名在 SI 缓存 → dam 的父亲（id 反查马名） ---
        if (!r.bms) {
          const own = caches.pedByName.get(key(r.horse?.name));
          if (own?.bms) {
            patch.bms = { id: null, name: own.bms };
            stat.bmsFills++;
          } else {
            const dam = caches.pedByName.get(key(r.dam?.name));
            const damSireId = dam?.sireId ?? caches.sireIdByName.get(key(r.dam?.name));
            const damSireName = damSireId ? caches.nameById.get(damSireId) ?? caches.nameById.get(damSireId.replace("si:", "si:")) : null;
            if (damSireName) {
              patch.bms = { id: null, name: damSireName };
              stat.bmsFills++;
            }
          }
        }
      }

      if (Object.keys(patch).length) {
        Object.assign(r, patch);
        changed++;
      }
    }
  }
  return { changed, ...stat };
}

function main() {
  const horses = JSON.parse(fs.readFileSync("data/pedigree/si-horse.json", "utf8"));
  const caches = loadCaches(horses);
  const racesDir = "data/races";
  const tags = new Set(["si", "lp", "tk", "tol"]);
  const totals = { files: 0, changed: 0, sireSire: 0, bms: 0, sex: 0 };
  for (const day of fs.readdirSync(racesDir)) {
    const dir = path.join(racesDir, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json.gz")) continue;
      // 文件名形态：si-1 / lp-1 / tk-chc / tk-vsc / tol-gavea → 源 tag 取第一个 "-" 前
      const tag = f.replace(/\.json\.gz$/, "").split("-")[0];
      if (!tags.has(tag)) continue;
      const file = path.join(dir, f);
      const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
      const stat = patchDoc(doc, caches);
      if (stat.changed) {
        fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 }));
        totals.files++;
        console.log(`${day}/${f}: +sex ${stat.sexFills} +bms ${stat.bmsFills} +sireSire ${stat.sireSireFills}（${stat.changed} runners）`);
      }
      totals.changed += stat.changed;
      totals.sireSire += stat.sireSireFills;
      totals.bms += stat.bmsFills;
      totals.sex += stat.sexFills;
    }
  }
  console.log(`\n[backfill-sa] 改动 ${totals.files} 文件：sex +${totals.sex}，bms +${totals.bms}，sireSire +${totals.sireSire}，runners ${totals.changed}`);
}

main();
