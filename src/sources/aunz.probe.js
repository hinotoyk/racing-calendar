// 澳大利亚 + 新西兰 出马表源探测：抓取 + 归一 + 字段覆盖率统计（不落 data/，区别于正式采集）
//
// 站点结构（2026-11-18 实测，详见《澳大利亚+新西兰赛马出走表免费获取方案.md》）：
// - Racing Australia（澳，八州统一入口 /FreeFields/，服务端渲染 ASP.NET）：
//   * 州日历 `Calendar.aspx?State={NSW|VIC|QLD|WA|SA|TAS|ACT|NT}`：一页列未来约 10 天，
//     每场带当前阶段链接（Nominations/Weights/Acceptances/Form），Key=`YYYYMonDD,州,赛场` 完全可预测。
//   * `Form.aspx?Key=...` 主抓页：每场一页含全部场次。
//     - 正式出马表行：<td class="no|last|horse|trainer|jockey|barrier|weight|penalty|penalty|hcp">
//     - 每匹马资料块（class="horse-form-table"）：<span class="horse-number"> + horse-name +
//       "4 year old bay gelding (17-10-2022) Sire: ... Dam: ... (母父) Breeder: ... Owners: ..."
//     - 含 Gear Changes（装备变更）与 Scratch（退赛）区块。
//   * 阶段不足（只有 Nominations/Weights）时 Form 可能无出马行 → 回退 Acceptances.aspx（仅出马行，无资料块）。
// - LOVERACING.NZ（新西兰官方，/RaceInfo/）：
//   * 首页 RaceInfo.aspx：`<li class="... meeting nominations|fields">` + `<span class="ml-auto date">Wed 18 Nov</span>`
//     一次解析即得未来数日全部 meeting（id 递增）。
//   * Meeting-Overview.aspx：`<li id="raceN" class="race {nominations|fields|results}">` 分场；
//     马匹表列随阶段演进，解析走表头驱动（不写死列序）。
//     - nominations 列：Silk/Horse/Trainer/Age/Sex/Order/Rating/Weight
//     - fields 阶段另有 Jockey/Barrier/Weight/Owner/Breeder/父系/母系等
//     - results 列：# / Horse / Jockey / Trainer / Win / Place / Lgth
//
// 用法：
//   node src/sources/aunz.probe.js                       # 2026-11-18 + 11-19 两天全量探测
//   node src/sources/aunz.probe.js --date 2026-11-18     # 指定单日
//   node src/sources/aunz.probe.js --limit 6             # 每国每日最多抓 N 场 meeting（快速验证）
//   node src/sources/aunz.probe.js --out report.json     # 结果另存 JSON
//   node src/sources/aunz.probe.js --offline-ra x.html --key "2026Nov18,NSW,Warwick Farm"
//                                                        # 离线跑 RA 解析（不联网）
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";

const RA = "https://racingaustralia.horse/FreeFields";
const NZ = "https://loveracing.nz";
const SLEEP_MS = 4000; // 礼貌间隔（RA 在 Zenedge 后面，过频触发人机验证）
const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

const argv = process.argv.slice(2);
const argOf = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const LIMIT = Number(argOf("--limit") ?? 0); // 0 = 不限
const NZ_MODAL = Number(argOf("--nz-modal") ?? 10); // 每场最多富化的模态数（0=不富化）
const OUT = argOf("--out");
const OFFLINE_RA = argOf("--offline-ra");
const OFFLINE_KEY = argOf("--key");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RA 有 Zenedge 防护：高频请求后返回 200 但内容是 "Are you human?" 挑战页（~9KB 空壳）。
// **实测（2026-11-18）同一时刻同一 URL：curl 200 真内容，Node fetch（undici）被挑战**
// → Zenedge 按 HTTP 客户端指纹区分，RA 请求一律走 curl 子进程；仍 challenged 时长退避重试。
import { execFile } from "node:child_process";
function curlGet(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-s", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", BROWSER_UA, "-H", "Accept: text/html,application/xhtml+xml", "-H", "Accept-Language: en-US,en;q=0.9", url], { maxBuffer: 30 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
    });
  });
}
const isZenedgeChallenge = (html) => !html || html.length < 500 || /Are you human\?/i.test(html); // __zenedge 脚本所有正常页都有，不作判据
async function fetchRa(url, { attempts = 3 } = {}) {
  for (let i = 0; ; i++) {
    const html = await curlGet(url);
    if (!isZenedgeChallenge(html)) return html;
    if (i + 1 >= attempts) throw new Error("zenedge challenge (rate limited)");
    console.log(`    [RA] zenedge 挑战页 → 退避 60s 后重试（${i + 1}/${attempts - 1}）`);
    await sleep(60000);
  }
}

// ---------- 文本工具 ----------
const decodeEnt = (s) =>
  String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const strip = (s) => decodeEnt(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const isoFromKey = (k) => {
  // "2026Nov18" → "2026-11-18"
  const m = String(k).match(/^(\d{4})([A-Za-z]{3})(\d{1,2})/);
  if (!m) return null;
  const mon = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" }[m[2]];
  return mon ? `${m[1]}-${mon}-${m[3].padStart(2, "0")}` : null;
};
// NZ 日期 "Sat 26 Dec" → iso（缺年：按当前年推，早于当前 6 个月以上则 +1 年）
const nzDateIso = (s) => {
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!m) return null;
  const mon = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[m[2].toLowerCase()];
  if (!mon) return null;
  const now = new Date();
  let y = now.getUTCFullYear();
  let dt = Date.UTC(y, mon - 1, Number(m[1]));
  if (dt < Date.UTC(y, now.getUTCMonth(), now.getUTCDate()) - 180 * 864e5) dt = Date.UTC(++y, mon - 1, Number(m[1]));
  return new Date(dt).toISOString().slice(0, 10);
};
const SEX_WORDS = ["gelding", "mare", "filly", "colt", "entire", "horse", "brown"];
const COLOUR_WORDS = ["bay", "brown", "black", "chestnut", "grey", "roan", "buckskin", "palomino", "white"];
// "4 year old bay or brown gelding (17-10-2022)" / "3 year old grey-bay gelding (14-9-2023)"
// （日/月可为 1-2 位数字）
function parseProfileDesc(desc) {
  const m = desc.match(/(\d+)\s*year\s*old\s+(.*?)\s*\((\d{1,2})-(\d{1,2})-(\d{4})\)/i);
  if (!m) return {};
  const rest = m[2].toLowerCase();
  const out = { age: Number(m[1]), foaled: `${m[5]}-${m[4].padStart(2, "0")}-${m[3].padStart(2, "0")}` };
  const words = rest.split(/\s+or\s+|-|\s+/);
  out.colour = words.filter((w) => COLOUR_WORDS.includes(w)).join(" / ") || null;
  out.sex = words.find((w) => SEX_WORDS.includes(w)) ?? null;
  return out;
}

// ---------- Racing Australia ----------
// 8 州日历 → [{date, state, venue, stage}]（去重，日历同一场会按阶段给 1 个链接）
async function collectAuMeetings(dates) {
  const seen = new Map();
  for (const st of AU_STATES) {
    await sleep(SLEEP_MS);
    let html = null;
    try {
      html = await fetchRa(`${RA}/Calendar.aspx?State=${st}`);
    } catch (e) {
      console.log(`  [AU] Calendar ${st}: FAIL ${e.message}`);
      continue;
    }
    if (!html) continue;
    const re = /href="\/FreeFields\/(\w+)\.aspx\?Key=([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const key = decodeEnt(m[2]).replace(/%2C/gi, ",").replace(/%20/gi, " ");
      const [d, state, venue] = key.split(",");
      const date = isoFromKey(d);
      if (!date || !dates.includes(date)) continue;
      const id = `${date}|${state}|${venue}`;
      const prev = seen.get(id);
      // 阶段优先级：Form > Acceptances > Weights > Nominations（供回退选页）
      const rank = { Form: 4, Acceptances: 3, Weights: 2, Nominations: 1 };
      if (!prev || (rank[m[1]] ?? 0) > (rank[prev.stage] ?? 0)) seen.set(id, { date, state, venue, stage: m[1] });
    }
  }
  return [...seen.values()];
}

// Form.aspx / Acceptances.aspx 解析：分场（<span class='raceNum'>Race N</span>，
// Acceptances 侧为 "Race 1 - 2:55PM TAB PLATE (1200 METRES)"）→ 出马行 + 每马资料块
function parseRaForm(html) {
  const races = [];
  const spans = [...html.matchAll(/<span[^>]*>\s*(Race\s+\d+[^\n<]*)<\/span>/gi)];
  for (let i = 0; i < spans.length; i++) {
    const head = strip(spans[i][1]); // "Race 1 - 2:55PM TAB PLATE (1200 METRES)"
    const no = Number(head.match(/Race\s+(\d+)/i)?.[1]);
    const rest = head.replace(/^Race\s+\d+\s*-?\s*/i, "");
    const time = rest.match(/\d{1,2}:\d{2}\s*(?:AM|PM)/i)?.[0]?.toUpperCase() ?? null;
    const name = rest.replace(/\d{1,2}:\d{2}\s*(?:AM|PM)\s*/i, "").replace(/\s*\(\d+\s*METRES\)\s*$/i, "").trim() || null;
    const distance = rest.match(/\((\d{3,4})\s*METRES\)/i)?.[1] ?? null;
    const start = spans[i].index + spans[i][0].length;
    const body = html.slice(start, i + 1 < spans.length ? spans[i + 1].index : undefined);
    races.push({ no, name, time, distance, ...parseRaRaceBody(body) });
  }
  return races;
}

function parseRaRaceBody(body) {
  const runners = [];
  const gearChanges = [];
  let scratched = 0;
  // 正式出马行：td class 序列 no/last/horse/trainer/jockey/barrier/weight/penalty/penalty/hcp
  const rowRe = /<tr[^>]*>((?:(?!<\/tr>)[\s\S])*?<td[^>]*class=["']?no["']?[^>]*>[\s\S]*?)<\/tr>/g;
  for (const rm of body.matchAll(rowRe)) {
    const row = rm[1];
    const cell = (cls) => {
      const c = row.match(new RegExp(`<td[^>]*class=["']?${cls}["']?[^>]*>([\\s\\S]*?)</td>`, "i"));
      return c ? strip(c[1]) || null : null;
    };
    runners.push({
      horse_no: Number(cell("no")),
      form: cell("last"),
      horse_name: cell("horse")?.replace(/\s*\((?:AUS|NZ|GB|IRE|USA|FR|GER|JPN|SAF)\)\s*$/, "").trim() ?? null,
      trainer: cell("trainer"),
      jockey: cell("jockey")?.replace(/\s*\(a\d+(?:\/[\d.]+kg)?\)\s*$/, "").trim() ?? null, // 去学徒让磅后缀
      barrier: cell("barrier") != null ? Number(cell("barrier")) : null,
      weight: cell("weight"),
      probable_weight: null,
      hcp_rating: cell("hcp") != null && cell("hcp") !== "" ? Number(cell("hcp")) : null,
      status: "ACCEPTED",
      sex: null, age: null, colour: null, foaled: null,
      sire: null, dam: null, dam_sire: null, owner: null, breeder: null,
    });
    if (/Scratched/i.test(row)) runners[runners.length - 1].status = "SCRATCHED";
  }
  // 每马资料块（与出马行按 horse-number 关联）
  const profRe = /class="horse-number">(\d+)<[\s\S]*?class="horse-name"[^>]*>([\s\S]*?)<\/span>[\s\S]*?class="plain">([\s\S]*?)<\/span>/gi;
  for (const pm of body.matchAll(profRe)) {
    const no = Number(pm[1]);
    const plain = strip(pm[3]);
    const r = runners.find((x) => x.horse_no === no && !x._prof);
    if (!r) continue;
    r._prof = true;
    Object.assign(r, parseProfileDesc(plain));
    const sire = plain.match(/Sire:\s*(.+?)\s+Dam:/s);
    const dam = plain.match(/Dam:\s*([\s\S]*?)(?:View Pedigree Report|Breeder:)/);
    if (sire) r.sire = sire[1].trim();
    if (dam) {
      let seg = dam[1].replace(/\s+/g, " ").trim();
      // "Improvement (NZ) ( Swiss Ace )" / "Istanford (USA) ( Istan (USA) )" / "Rough Ride ( Flying Spur )"
      // 取最后一个括号组为母父（清理尾部国家码残段），其余为母系名（保留国家码后缀）
      const groups = [...seg.matchAll(/\(([^)]+)\)/g)];
      if (groups.length) {
        const last = groups[groups.length - 1];
        r.dam_sire = last[1].replace(/\(.*$/, "").replace(/\s+/g, " ").trim()
          .replace(/\s*\((?:AUS|NZ|GB|IRE|USA|FR|GER|JPN|SAF)\)\s*$/, "").trim() || null;
        seg = seg.slice(0, last.index).replace(/\($/, "").trim();
      }
      r.dam = seg || null;
    }
    const breeder = plain.match(/Breeder:\s*(.*?)\s*Owners?:/s);
    if (breeder) r.breeder = breeder[1].trim();
    const owner = plain.match(/Owners?:\s*(.+?)\s*(?:Gear|Trainer:|$)/s);
    if (owner) r.owner = owner[1].replace(/\(.*?share.*?\)/gi, "").trim() || null;
  }
  // 装备变更 / 退赛条目计数
  for (const gm of body.matchAll(/class="gear[^"]*"[^>]*>([\s\S]{0,200}?)<\/(?:td|div)>/gi)) {
    const t = strip(gm[1]);
    if (t) gearChanges.push(t);
  }
  scratched = [...body.matchAll(/Scratched/gi)].length;
  return { runners, gearChanges, scratchedCount: scratched };
}

async function probeAu(dates) {
  const out = { meetings: [], runners: [] };
  const meetings = await collectAuMeetings(dates);
  for (const date of dates) {
    const dayMeetings = meetings.filter((m) => m.date === date);
    console.log(`\n[AU] ${date}: ${dayMeetings.length} meetings（8 州日历合计）`);
    let picked = dayMeetings;
    if (LIMIT) picked = dayMeetings.slice(0, LIMIT);
    for (const mt of picked) {
      const key = encodeURIComponent(`${mt.date.replace(/-/g, "").replace(/^(\d{4})(\d{2})(\d{2})$/, (s, y, mo, d) => `${y}${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(mo) - 1]}${Number(d)}`)},${mt.state},${mt.venue}`);
      let html = null;
      let page = "Form";
      await sleep(SLEEP_MS);
      try {
        html = await fetchRa(`${RA}/Form.aspx?Key=${key}`);
      } catch { html = null; }
      if (!html || !/<td[^>]*class=["']?no["']?/i.test(html)) {
        // Form 未出/无出马行 → 回退 Acceptances
        page = "Acceptances";
        await sleep(SLEEP_MS);
        try {
          html = await fetchRa(`${RA}/Acceptances.aspx?Key=${key}`);
        } catch { html = null; }
      }
      if (!html) {
        console.log(`  ${mt.venue}: 页面不可得（Form+Acceptances 均失败）`);
        out.meetings.push({ ...mt, error: "no page" });
        continue;
      }
      const races = parseRaForm(html);
      const heads = races.reduce((n, r) => n + r.runners.length, 0);
      const prof = races.reduce((n, r) => n + r.runners.filter((x) => x.sex || x.sire).length, 0);
      const gear = races.reduce((n, r) => n + r.gearChanges.length, 0);
      console.log(`  ${mt.venue}（${mt.state}）: ${races.length} R / ${heads} 頭 / 资料块 ${prof} / gear ${gear} / scratched ${races.reduce((n, r) => n + (r.scratchedCount ? 1 : 0), 0)} 场次 [${page}]${heads === 0 ? " ← 无表（已完赛或未发布）" : ""}`);
      out.meetings.push({ ...mt, page, races: races.length, heads });
      for (const r of races) for (const x of r.runners) out.runners.push({ ...x, country: "AUS", date: mt.date, venue: mt.venue, state: mt.state, race_no: r.no });
    }
  }
  return out;
}

// NZ 站有间歇性 403 反爬（实测同 headers 先 403 后 200，无 set-cookie）：403 时退避重试
async function fetchNz(url) {
  for (let i = 0; ; i++) {
    try {
      return await fetchHtmlSoft(url, { src: "nz", ua: BROWSER_UA, retries: 0 });
    } catch (e) {
      if (e.status === 403 && i < 3) {
        await sleep(3000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

// ---------- LOVERACING.NZ ----------
async function probeNz(dates) {
  const out = { meetings: [], runners: [] };
  let idx;
  try {
    idx = await fetchNz(`${NZ}/RaceInfo.aspx`);
  } catch (e) {
    console.log(`\n[NZ] RaceInfo.aspx FAIL: ${e.message}`);
    return out;
  }
  const meetings = new Map(); // id → {id, name, date, kind}
  // ① 首页主日历表：<td>Wed 18 November</td><td><a href="/RaceInfo/{id}/Meeting-Overview.aspx">Name</a>...
  for (const rm of idx.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rm[1];
    const lm = row.match(/\/RaceInfo\/(\d+)\/Meeting-Overview\.aspx[^>]*>([^<]*)</i);
    if (!lm) continue;
    const d = nzDateIso(strip(row.match(/<td[^>]*>([^<]*\d{1,2}\s+\w{3,9})</i)?.[1]));
    if (!d) continue;
    meetings.set(Number(lm[1]), { id: Number(lm[1]), name: strip(lm[2]), date: d, kind: "calendar" });
  }
  // ② 侧栏分组（nominations/fields/results，带当前阶段提示）——补充并标记阶段
  for (const lm of idx.matchAll(/class="[^"]*meeting\s+(nominations|fields|results)"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const body = lm[2];
    const id = body.match(/\/RaceInfo\/(\d+)\/Meeting-Overview\.aspx/);
    if (!id) continue;
    const d = nzDateIso((body.match(/class="ml-auto date">([^<]*)</) ?? [])[1]);
    const prev = meetings.get(Number(id[1]));
    const name = strip((body.match(/<a[^>]*>([\s\S]*?)<\/a>/) ?? [])[1]);
    meetings.set(Number(id[1]), {
      id: Number(id[1]),
      name: name || prev?.name,
      date: d ?? prev?.date,
      kind: lm[1].toLowerCase(),
    });
  }
  const allMeetings = [...meetings.values()].filter((m) => m.date && m.name);
  for (const date of dates) {
    const dayMeetings = allMeetings.filter((m) => m.date === date);
    console.log(`\n[NZ] ${date}: ${dayMeetings.length} meetings（首页 Nominations/Fields 分组）`);
    let picked = dayMeetings;
    if (LIMIT) picked = dayMeetings.slice(0, LIMIT);
    for (const mt of picked) {
      await sleep(SLEEP_MS);
      let html = null;
      try {
        html = await fetchNz(`${NZ}/RaceInfo/${mt.id}/Meeting-Overview.aspx`);
      } catch { html = null; }
      if (!html) {
        console.log(`  ${mt.name}: overview 不可得`);
        out.meetings.push({ ...mt, error: "no page" });
        continue;
      }
      const races = parseNzOverview(html);
      // 模态富化：fields-download 阶段概览只有 马号/Form/马名/年龄性别/父母系，
      // 骑师/练马师/毛色/装备/马主/生产牧场/出生日 在 EntryDetail 模态（~130KB/马）里。
      // results 阶段表格已有骑师/练马师，跳过富化。
      const stageSet = new Set(races.map((r) => r.stage));
      const skipModal = stageSet.size === 1 && [...stageSet][0].startsWith("results");
      const modalBudget = skipModal ? 0 : NZ_MODAL;
      let modalUsed = 0;
      const enriched = { jockey: 0, trainer: 0, gear: 0, owner: 0 };
      for (const r of races) {
        for (let i = 0; i < r.runners.length && modalUsed < modalBudget; i++) {
          const x = r.runners[i];
          const entryUrl = r.entries[i % Math.max(r.entries.length, 1)];
          if (!entryUrl) break;
          await sleep(SLEEP_MS);
          let mh = null;
          try {
            mh = await fetchNz(`${NZ}${entryUrl}`);
          } catch { mh = null; }
          modalUsed++;
          if (!mh) continue;
          const md = parseNzModal(mh);
          if (md.jockey && !x.jockey) { x.jockey = md.jockey; enriched.jockey++; }
          if (md.trainer && !x.trainer) { x.trainer = md.trainer; enriched.trainer++; }
          if (md.owner && !x.owner) { x.owner = md.owner; enriched.owner++; }
          if (md.colour) x.colour = md.colour;
          if (md.foaled) x.foaled = md.foaled;
          if (md.age && x.age == null) x.age = md.age;
          if (md.sex && !x.sex) x.sex = md.sex;
          if (md.sire && !x.sire) x.sire = md.sire;
          if (md.dam && !x.dam) x.dam = md.dam;
          if (md.breeder && !x.breeder) x.breeder = md.breeder;
          if (md.gear) x.gear_changes = md.gear;
          if (md.flat_rating) x.flat_rating = md.flat_rating;
          if (md.gear) enriched.gear++;
          x._modal = true;
        }
      }
      const heads = races.reduce((n, r) => n + r.runners.length, 0);
      const stages = [...new Set(races.map((r) => r.stage))].join("/");
      console.log(`  ${mt.name}（#${mt.id}）: ${races.length} R / ${heads} 頭 / 阶段=${stages || mt.kind}${modalUsed ? ` / 模态富化 ${modalUsed} 頭 (J ${enriched.jockey} T ${enriched.trainer} G ${enriched.gear} O ${enriched.owner})` : ""}`);
      out.meetings.push({ ...mt, races: races.length, heads, stages });
      for (const r of races) for (const x of r.runners) out.runners.push({ ...x, country: "NZL", date: mt.date, venue: mt.name, meeting_id: mt.id, race_no: r.no });
    }
  }
  return out;
}

function parseNzOverview(html) {
  const races = [];
  // 注意 stage 可能是 "fields-download"（连字符）：class="race fields-download"
  const parts = html.split(/<li\s+id\s*=\s*"race(\d+)"[^>]*class="race\s+([a-z-]+)"/i);
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const no = Number(parts[i]);
    const stage = parts[i + 1].toLowerCase();
    const body = parts[i + 2];
    // 场次信息表：col1=Race no, col2=Start, col3=Name, col4=Conditions & Distance
    const info = {};
    const c2 = body.match(/<td\s+class="col2">([\s\S]*?)<\/td>/i);
    const c3 = body.match(/<td\s+class="col3">([\s\S]*?)<\/td>/i);
    const c4 = body.match(/<td\s+class="col4">([\s\S]*?)<\/td>/i);
    if (c2) info.time = strip(c2[1]);
    if (c3) info.name = strip(c3[1]);
    if (c4) info.conditions = strip(c4[1]);
    const dist = (info.conditions ?? "").match(/(\d{3,4})m\b/i);
    if (dist) info.distance = Number(dist[1]);
    const runners = parseNzHorseTable(body, stage);
    races.push({ no, stage, ...info, runners, entries: parseNzEntryLinks(body) });
  }
  return races;
}

// 两种马匹形态：
// A) 表格（nominations / fields / results）：th>Horse 驱动
// B) div 行（fields-download）：col-number / col-form / col-horse(+subtext)
function parseNzHorseTable(body, stage) {
  const runners = [];
  const tbl = body.match(/<table[\s\S]*?<th[^>]*>\s*Horse\s*<\/th>[\s\S]*?<\/table>/i);
  if (tbl) {
    const tableHtml = tbl[0];
    const ths = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => strip(m[1]).toLowerCase());
    const col = (...names) => {
      for (const n of names) {
        const i = ths.findIndex((t) => t === n || t.startsWith(n));
        if (i >= 0) return i;
      }
      return -1;
    };
    const idxMap = {
      horse: col("horse"), jockey: col("jockey"), trainer: col("trainer"), age: col("age"),
      sex: col("sex"), weight: col("weight"), barrier: col("barrier"), no: col("#"),
      owner: col("owner"), breeder: col("breeder"), sire: col("sire"), dam: col("dam", "dam/sire"),
      form: col("form"),
    };
    for (const rm of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
      if (cells.length < ths.length - 1 || !cells[idxMap.horse]) continue;
      const get = (k) => (idxMap[k] >= 0 ? cells[idxMap[k]] || null : null);
      runners.push({
        horse_no: get("no") ? Number(get("no")) || null : runners.length + 1,
        horse_name: get("horse"),
        jockey: get("jockey"), trainer: get("trainer"),
        age: get("age") && /^\d+$/.test(get("age")) ? Number(get("age")) : null,
        sex: get("sex"), weight: get("weight"), barrier: get("barrier") != null ? Number(get("barrier")) || null : null,
        owner: get("owner"), breeder: get("breeder"), sire: get("sire"), dam: get("dam"),
        colour: null, foaled: null, dam_sire: null, form: get("form"), gear_changes: [],
        status: /Scratch/i.test(rm[1]) ? "SCRATCHED" : stage.startsWith("results") ? "FINISHED" : "ACCEPTED",
      });
    }
    return runners;
  }
  // B) fields-download div 行：# / Silk / Form / Horse(+subtext "(5g Zed - Hermione)")
  const NZ_SEX = { g: "gelding", m: "mare", c: "colt", f: "filly", h: "horse", s: "stallion" };
  const rowMarks = [...body.matchAll(/class="col col-number">(\d+)<\/div>/g)];
  for (let i = 0; i < rowMarks.length; i++) {
    const seg = body.slice(rowMarks[i].index, i + 1 < rowMarks.length ? rowMarks[i + 1].index : undefined);
    const form = seg.match(/class="col col-form">([^<]*)</)?.[1]?.trim() ?? null;
    const horseSeg = seg.match(/class="col col-horse">([\s\S]*?)(?:<\/div>\s*(?:<\/div>)?\s*$|class="col col-number")/);
    const horseHtml = horseSeg?.[1] ?? seg.match(/class="col col-horse">([\s\S]*)/)?.[1] ?? "";
    const name = strip((horseHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/) ?? [])[1]);
    if (!name) continue;
    const sub = strip((horseHtml.match(/class="subtext">([^<]*)</) ?? [])[1]);
    const r = {
      horse_no: Number(rowMarks[i][1]),
      horse_name: name,
      form,
      age: null, sex: null, sire: null, dam: null, dam_sire: null,
      jockey: null, trainer: null, weight: null, barrier: null,
      owner: null, breeder: null, colour: null, foaled: null, gear_changes: [],
      status: stage.startsWith("results") ? "FINISHED" : "ACCEPTED",
    };
    // "(5g Zed - Hermione)" / "(4g Proisir (AUS) - Kay's Awake)" —— 整体包在一个括号里
    const sm = sub.match(/^\((\d+)\s*([a-z])\s+([\s\S]+)\)$/i);
    if (sm) {
      r.age = Number(sm[1]);
      r.sex = NZ_SEX[sm[2].toLowerCase()] ?? sm[2];
      const parts2 = sm[3].split(/\s+-\s+/);
      if (parts2.length >= 2) {
        r.sire = parts2[0].trim();
        r.dam = parts2.slice(1).join(" - ").trim();
      }
    }
    runners.push(r);
  }
  return runners;
}

// 每马的 EntryDetail 模态链接（含 HorseID/JockeyID/RaceID）
function parseNzEntryLinks(body) {
  return [...new Set([...body.matchAll(/href="(\/Common\/SystemTemplates\/Modal\/EntryDetail\.aspx\?[^"]+?)#/g)].map((m) => m[1]))];
}

// EntryDetail 模态富化（~130KB/马）：骑师/练马师/毛色/装备/马主/生产牧场/出生日/评分
function parseNzModal(html) {
  const plain = strip(html);
  const out = {};
  const jm = plain.match(/With Jockey \(([^)]+)\)/);
  if (jm) out.jockey = jm[1].trim();
  const tm = plain.match(/Trainer:\s*(.*?)\s*Training Location:/s);
  if (tm) out.trainer = tm[1].trim();
  const hd = plain.match(/Horse Details\s*(\d+)\s*YO\s+([A-Za-z-]+)\s+([A-Za-z]+)/);
  if (hd) {
    out.age = Number(hd[1]);
    out.colour = hd[2].toLowerCase();
    out.sex = hd[3].toLowerCase();
  }
  const om = plain.match(/Owner:\s*(.*?)\s*Breeder:/s);
  if (om) out.owner = om[1].trim() || null;
  const bm = plain.match(/Breeder:\s*(.*?)\s*Sire:/s);
  if (bm) out.breeder = bm[1].trim();
  const sire = plain.match(/Sire:\s*(.*?)\s*Dam:/s);
  if (sire) out.sire = sire[1].replace(/\s+\d{4}\s*$/, "").trim();
  const dam = plain.match(/Dam:\s*(.*?)\s*Foaling:/s);
  if (dam) out.dam = dam[1].replace(/\s+\d{4}\s*$/, "").trim();
  const fm = plain.match(/Foaling:\s*(\d{1,2}\s+\w{3}\s+\d{4})/);
  if (fm) {
    const [d, mon, y] = fm[1].split(/\s+/);
    const mm = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" }[mon];
    if (mm) out.foaled = `${y}-${mm}-${d.padStart(2, "0")}`;
  }
  // 装备区块：HTML 内每项一行，替换标签为换行后取非空行
  const gearSeg = html.match(/Current Gear:([\s\S]*?)Horse Details\b/s);
  if (gearSeg) {
    const items = gearSeg[1]
      .replace(/<[^>]+>/g, "\n")
      .split("\n").map((s) => strip(s)).filter((s) => s && !/^-A$|N\/A/i.test(s));
    if (items.length) out.gear = items;
  }
  const fr = plain.match(/Flat Rating:\s*(\d+)/);
  if (fr) out.flat_rating = Number(fr[1]);
  return out;
}

// ---------- 覆盖率统计 ----------
function coverage(runners) {
  if (!runners.length) return "（无 runner）";
  const cov = (f) => {
    const n = runners.filter((r) => r[f] != null && r[f] !== "").length;
    return `${f} ${(n * 100 / runners.length).toFixed(0)}%`;
  };
  const fields = ["horse_no", "horse_name", "jockey", "trainer", "barrier", "weight", "sex", "age", "colour", "foaled", "sire", "dam", "dam_sire", "owner", "breeder", "form"];
  return runners.length + " 頭  " + fields.map(cov).join(" / ");
}

// ---------- main ----------
const TZ_NZ = "Pacific/Auckland";
const todayNz = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ_NZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const tomorrowNz = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10); // 近似即可（UTC 与 NZ 日界差 4-5h，探针用）

const dates = argOf("--date") ? [argOf("--date")] : [todayNz(), tomorrowNz()];
console.log(`== AU/NZ fields probe  dates=${dates.join(",")}  limit=${LIMIT || "无"}\n`);

let au, nz;
if (OFFLINE_RA) {
  const [d, state, ...venue] = (OFFLINE_KEY ?? "").split(",");
  const html = await import("node:fs").then((fs) => fs.readFileSync(OFFLINE_RA, "utf8"));
  const races = parseRaForm(html);
  console.log(`[AU offline] ${OFFLINE_KEY}: ${races.length} R`);
  for (const r of races) console.log(`  R${r.no}: ${r.runners.length} 頭 / 资料 ${r.runners.filter((x) => x.sex || x.sire).length} / gear ${r.gearChanges.length}`);
  const rs = races.flatMap((r) => r.runners);
  console.log("\n== RA 覆盖 ==\n" + coverage(rs));
  au = { runners: rs.map((x) => ({ ...x, country: "AUS", date: d, venue: venue.join(","), state })) };
  nz = { runners: [] };
} else {
  const nzOnly = process.argv.includes("--nz-only");
  au = nzOnly ? { runners: [] } : await probeAu(dates);
  nz = await probeNz(dates);
}

console.log("\n================ 覆盖率 ================");
for (const date of dates) {
  const a = au.runners.filter((r) => r.date === date);
  const n = nz.runners.filter((r) => r.date === date);
  console.log(`\n[AUS ${date}] ${coverage(a)}`);
  console.log(`[NZL ${date}] ${coverage(n)}`);
}
const all = [...au.runners, ...nz.runners];
const report = {
  generated: new Date().toISOString(),
  dates,
  au_meetings: au.meetings?.length ?? 0,
  nz_meetings: nz.meetings?.length ?? 0,
  runners: all.length,
  au: au.runners?.length ?? 0,
  nz: nz.runners?.length ?? 0,
  coverage: Object.fromEntries(["horse_no", "horse_name", "jockey", "trainer", "barrier", "weight", "sex", "age", "colour", "foaled", "sire", "dam", "dam_sire", "owner", "breeder", "form"].map((f) => {
    const vals = all.filter((r) => r[f] != null && r[f] !== "");
    return [f, { n: vals.length, pct: all.length ? +(vals.length * 100 / all.length).toFixed(1) : 0 }];
  })),
  detail: { au_meetings: au.meetings, nz_meetings: nz.meetings },
};
if (OUT) {
  await import("node:fs").then((fs) => fs.writeFileSync(OUT, JSON.stringify(report, null, 2)));
  console.log(`\n报告已写入 ${OUT}`);
} else {
  console.log("\n总体: runners=" + report.runners + " (AU " + report.au + " / NZ " + report.nz + ")");
}
