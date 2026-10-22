// Racing Post 源探测：RP 直连 vs Sporting Life（RP 集团同源数据）
// 用法：node src/sources/racingpost.probe.js
import https from "node:https";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function get(url, { headers = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, Accept: "*/*", ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function getFollow(url, hops = 5) {
  let cur = url;
  for (let i = 0; i < hops; i++) {
    const r = await get(cur);
    if ([301, 302, 307, 308].includes(r.status) && r.headers.location) {
      cur = new URL(r.headers.location, cur).href;
      continue;
    }
    return { ...r, finalUrl: cur };
  }
  return { ...r, finalUrl: cur };
}

const nextData = (html) => {
  const m = html?.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};
const shape = (o, d = 0) => {
  if (d > 4 || o === null || typeof o !== "object") return typeof o;
  if (Array.isArray(o)) return o.length ? `array[${o.length}]<${shape(o[0], d + 1)}>` : "array[0]";
  const e = {};
  for (const k of Object.keys(o).slice(0, 60)) e[k] = shape(o[k], d + 1);
  return e;
};

// ---------- 1) RP 直连探测 ----------
console.log("== 1. racingpost.com direct ==");
for (const u of ["https://www.racingpost.com/racecards/", "https://www.racingpost.com/api/mobile/v2/racecards"]) {
  const r = await get(u).catch((e) => ({ status: 0, text: String(e) }));
  console.log(`  ${r.status} ${u} len=${r.text?.length ?? 0}`);
  await sleep(1200);
}

// ---------- 2) SL 当日 racecards（内嵌 JSON） ----------
console.log("== 2. sportinglife.com/racing/racecards ==");
const page = await get("https://www.sportinglife.com/racing/racecards");
const j = nextData(page.text);
const meetings = j?.props?.pageProps?.meetings ?? [];
console.log("  status", page.status, "buildId", j?.buildId, "meetings", meetings.length);

// ---------- 3) 会议/场次/时间全景 ----------
console.log("== 3. all meetings (time locale check) ==");
for (const mt of meetings) {
  const cs = mt.meeting_summary.course;
  const rs = (mt.races ?? []).map((r) => `${r.date.slice(5)} ${r.time}`);
  console.log(
    `  ${cs.name.padEnd(24)} ${cs.country.short_name.padEnd(4)} ${rs[0]} .. ${rs[rs.length - 1]}  (${rs.length}R)`
  );
}

// ---------- 4) 单场详情 ----------
console.log("== 4. race detail ==");
const hrefs = [...new Set([...page.text.matchAll(/href="(\/racing\/racecards\/[^"]+)"/g)].map((x) => x[1]))];
const raceUrl = "https://www.sportinglife.com" + hrefs.find((h) => /\d{6,}/.test(h) && h.split("/").length >= 6);
console.log("  race page:", raceUrl);
const rp = await get(raceUrl);
const rj = nextData(rp.text);
const race = rj?.props?.pageProps?.race ?? null;
const rides = race?.rides ?? [];
console.log("  status", rp.status, "rides", rides.length);
const ride = rides[0];
console.log("  ride keys:", Object.keys(ride ?? {}).join(", "));
console.log("  trainer:", JSON.stringify(ride?.trainer).slice(0, 300));
console.log("  jockey:", JSON.stringify(ride?.jockey).slice(0, 300));
console.log("  horseColour:", JSON.stringify(ride?.horseColour));
const ridesJson = JSON.stringify(rides);
for (const k of ["sire", "dam", "breeder", "draw", "breeding", "sex", "colour"]) {
  const idx = ridesJson.toLowerCase().indexOf('"' + k.toLowerCase());
  console.log(`  "${k}" in rides:`, idx >= 0 ? ridesJson.slice(idx, idx + 160).replace(/\s+/g, " ") : "ABSENT");
}

// ---------- 5) 马匹档案 URL ----------
console.log("== 5. horse profile url ==");
const horseHrefs = [...new Set([...rp.text.matchAll(/href="([^"]*(?:horses|horse)\/[^"]*)"/g)].map((x) => x[1]))];
console.log("  candidate hrefs:", horseHrefs.slice(0, 6));

// ---------- 6) 明日页 / Next data 路由（未来日期可行性） ----------
console.log("== 6. tomorrow / next-data route ==");
const tm = await getFollow("https://www.sportinglife.com/racing/racecards/tomorrow");
const tj = nextData(tm.text);
const tmeet = tj?.props?.pageProps?.meetings ?? [];
const tdates = [...new Set(tmeet.map((x) => x.meeting_summary?.date))];
console.log("  tomorrow page:", tm.status, "->", tm.finalUrl, "meetings", tmeet.length, "dates", tdates.join(","), "races", tmeet.reduce((n, x) => n + (x.races?.length ?? 0), 0));
for (const p of ["racing/racecards/tomorrow", "racing/racecards/2026-10-24"]) {
  const u = `https://www.sportinglife.com/_next/data/${j.buildId}/${p}.json`;
  const r3 = await get(u);
  let info = "";
  try {
    const jj = JSON.parse(r3.text);
    const mm = jj?.pageProps?.meetings ?? [];
    const dd = [...new Set(mm.map((x) => x.meeting_summary?.date))];
    info = `meetings=${mm.length} dates=${dd.join(",")} races=${mm.reduce((n, x) => n + (x.races?.length ?? 0), 0)}`;
  } catch {
    info = r3.text.slice(0, 120);
  }
  console.log(`  data-route ${p}: ${r3.status} ${info}`);
  await sleep(1200);
}

// ---------- 7) SL robots.txt ----------
console.log("== 7. sportinglife robots.txt ==");
const rb = await get("https://www.sportinglife.com/robots.txt");
console.log(rb.text.slice(0, 900));

// ---------- 8) 马匹档案（正确 URL）：血统字段 ----------
console.log("== 8. horse profile /racing/profiles/horse/1215694 ==");
const hp = await getFollow("https://www.sportinglife.com/racing/profiles/horse/1215694");
console.log("  status", hp.status, "->", hp.finalUrl, "len", hp.text.length);
const hj = nextData(hp.text);
if (hj) {
  const hprops = hj.props?.pageProps ?? {};
  console.log("  pageProps keys:", Object.keys(hprops).join(", "));
  const hs = JSON.stringify(hprops);
  for (const k of ['"sire"', '"dam"', '"damsire"', '"breeder"', '"breeding"', '"sex"', '"colour"', '"foaled"']) {
    const idx = hs.toLowerCase().indexOf(k.toLowerCase());
    console.log(`  ${k}:`, idx >= 0 ? hs.slice(idx, idx + 240).replace(/\s+/g, " ") : "ABSENT");
  }
} else {
  console.log("  no NEXT_DATA");
}

// ---------- 9) 翻 JS bundle 找 JSON API ----------
console.log("== 9. api endpoints in JS bundles ==");
const scripts = [...new Set([...page.text.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((x) => x[1]))];
console.log("  bundles:", scripts.length);
const apiPaths = new Set();
for (const s of scripts.slice(0, 12)) {
  const r = await get("https://www.sportinglife.com" + s).catch(() => null);
  if (!r) continue;
  for (const m of r.text.matchAll(/["'`](\/(?:ps\/)?api\/[A-Za-z0-9_\-\/{}$\.]+)["'`]/g)) apiPaths.add(m[1]);
  await sleep(300);
}
console.log("  api paths found:", [...apiPaths].slice(0, 40).join("\n    "));
