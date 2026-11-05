// 欧美源（Racing Post / Sporting Life）彩衣回填（2026-11-04）
//
// 背景：rp-*.json.gz 的彩衣字段是 2026-11-04 才接入的，此前 6,828 头全是空。
//       SL 的历史 racecard 页仍在线，__NEXT_DATA__.rides[].silk_filename 依然有效，
//       所以用文档里存的 raceKey 重建单场 URL 重抓即可补齐，不需要重新采集赛事。
//
// URL 规则：{doc.sourceUrl 去掉 /racecard/ 之后}/racecard/{raceKey}/x
//           （实测 slug 段被忽略，任意占位字符串都返回 200）
//
// 幂等：sl-silk.json 以 silk_filename 为 key 缓存（命中 0 请求）；
//       文档内所有 runner 都已有 silk 的赛事直接跳过页面请求。
//
// 用法：node src/backfill-silks-rp.js [--dates 2026-11-01,...] [--tracks FNT,ASC]
//                                    [--delay 600] [--limit-docs N] [--dry] [--no-image]
import fs from "node:fs";
import path from "node:path";
import { readGz, writeGz } from "./lib/bundle.js";
import { get, nextData } from "./sources/http.js";
import { slSilk, slSilkStore } from "./sources/racingpost.js";
import { reqStats } from "./lib/reqlog.js";

const SL = "https://www.sportinglife.com";
const DATA_DIR = path.resolve("data", "races");

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const DATES = argOf("--dates")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const TRACKS = argOf("--tracks")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) ?? null;
const DELAY = parseInt(argOf("--delay") ?? "600", 10);
const LIMIT_DOCS = parseInt(argOf("--limit-docs") ?? "0", 10);
const DRY = argv.includes("--dry");
const NO_IMAGE = argv.includes("--no-image");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (s) => String(s ?? "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// 文档级 base：https://.../racing/racecards/2026-11-02/fontainebleau
function baseOf(doc) {
  const src = doc.sourceUrl ?? doc.srcUrl ?? null;
  if (src && src.includes("/racecard/")) return src.split("/racecard/")[0];
  if (!src) return null;
  return src.replace(/\/$/, "");
}

function raceUrl(doc, race) {
  const base = baseOf(doc);
  if (!base || !race.raceKey) return null;
  return `${base}/racecard/${race.raceKey}/x`;
}

// SL 会 308 重定向到规范 slug（get() 不跟随跳转），这里手动跟 3 跳
async function getFollow(url, hops = 3) {
  let u = url;
  for (let i = 0; i <= hops; i++) {
    const res = await get(u).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.headers?.location) {
      const loc = res.headers.location;
      u = loc.startsWith("http") ? loc : `${SL}${loc.startsWith("/") ? "" : "/"}${loc}`;
      continue;
    }
    return res;
  }
  return null;
}

const dates = (
  DATES ??
  fs
    .readdirSync(DATA_DIR)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
)
  .filter((d) => fs.existsSync(path.join(DATA_DIR, d)))
  .sort()
  .reverse(); // 新日期优先（先补要在站上展示的）

const st = {
  docs: 0,
  docSkipped: 0,
  changedDocs: 0,
  races: 0,
  raceSkipped: 0,
  pagesOk: 0,
  pagesBad: 0,
  rides: 0,
  matched: 0,
  silkHit: 0,
  silkMiss: 0,
  noSilkField: 0,
};
const t0 = Date.now();
const startedAt = new Date().toISOString();

for (const date of dates) {
  const dir = path.join(DATA_DIR, date);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("rp-") && f.endsWith(".json.gz")).sort();
  for (const f of files) {
    if (LIMIT_DOCS && st.docs >= LIMIT_DOCS) break;
    const file = path.join(dir, f);
    let doc;
    try {
      doc = JSON.parse(readGz(file));
    } catch (e) {
      console.log(`[err] ${date}/${f}: ${e.message}`);
      continue;
    }
    if (TRACKS && !TRACKS.includes(String(doc.track ?? "").toUpperCase())) continue;

    // 已全部带彩衣 → 无需请求
    const allRunners = doc.races.flatMap((r) => r.runners ?? []);
    if (allRunners.length && allRunners.every((r) => r.silk?.url)) {
      st.docSkipped++;
      continue;
    }

    st.docs++;
    const before = JSON.stringify(doc);

    for (const race of doc.races) {
      st.races++;
      const url = raceUrl(doc, race);
      if (!url) {
        st.raceSkipped++;
        continue;
      }
      const res = await getFollow(url);
      if (DELAY) await sleep(DELAY);
      if (!res || res.status !== 200) {
        st.pagesBad++;
        console.log(`[page] ${date} R${race.no} status=${res?.status ?? "ERR"} ${url}`);
        continue;
      }
      st.pagesOk++;
      const j = nextData(res.text);
      const rides = j?.props?.pageProps?.race?.rides ?? [];
      if (!rides.length) {
        st.pagesBad++;
        continue;
      }
      st.rides += rides.length;

      const byCloth = new Map();
      const byName = new Map();
      for (const ride of rides) {
        const cn = ride.cloth_number ?? ride.number ?? null;
        if (cn != null) byCloth.set(String(cn), ride);
        const hn = norm(ride.horse?.name);
        if (hn) byName.set(hn, ride);
      }

      for (const runner of race.runners ?? []) {
        if (runner.silk?.url) continue; // 已有，不覆盖
        const ride =
          (runner.num != null && byCloth.get(String(runner.num))) ||
          byName.get(norm(runner.horse?.name)) ||
          null;
        if (!ride) continue;
        st.matched++;

        // 马主名兜底（原文档偶有缺失）
        if (!runner.owner && ride.owner?.name) runner.owner = { id: null, name: ride.owner.name };

        if (!ride.silk_filename) {
          st.noSilkField++;
          continue;
        }
        if (NO_IMAGE) continue;
        const silk = await slSilk(ride.silk_filename, ride.owner?.name ?? runner.owner?.name ?? null, DELAY, () => {});
        if (silk) {
          runner.silk = silk;
          st.silkHit++;
        } else {
          st.silkMiss++;
        }
      }
    }

    const after = JSON.stringify(doc);
    if (after !== before) {
      st.changedDocs++;
      if (!DRY) writeGz(file, after);
    }
    console.log(
      `[doc] ${date}/${f.replace(".json.gz", "")} ${doc.track} races=${doc.races.length} silk累计=${st.silkHit} 改=${after === before ? 0 : 1}`
    );
    if (st.docs % 10 === 0) slSilkStore().save();
    if (LIMIT_DOCS && st.docs >= LIMIT_DOCS) break;
    await sleep(30);
  }
  if (LIMIT_DOCS && st.docs >= LIMIT_DOCS) break;
}

if (!DRY) slSilkStore().save();
const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(
  `done: docs=${st.docs}（跳过${st.docSkipped}） races=${st.races} pages=${st.pagesOk}/${st.pagesOk + st.pagesBad} ` +
    `rides=${st.rides} matched=${st.matched} silk新增=${st.silkHit} 无图=${st.silkMiss} 无字段=${st.noSilkField} ` +
    `改档=${st.changedDocs} 请求=${reqStats().total} 耗时=${mins}min${DRY ? "（dry-run 未写盘）" : ""}`
);
console.log(`startedAt=${startedAt} finishedAt=${new Date().toISOString()}`);
