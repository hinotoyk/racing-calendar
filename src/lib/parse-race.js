// JBIS レース页解析（docs/RACES.md §2）
// 站点为 div 块布局，非 <table>：
//   赛历   /race/calendar/?year=&month=      li.calendar__track-1|2 + a[href=/race/calendar/YYYYMMDD/CCC/]
//   当日   /race/calendar/YYYYMMDD/CCC/      div.data-6-12（中央）/ div.data-6-35（地方）
//   出馬表 /race/YYYYMMDD/CCC/RR/            div.data-6-27
//   血统   /horse/{id}/                      div.data-3__inner
import { klassOf } from "../race-config.js";

function txt(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// 按顶层 <div> 切分（返回闭合的块），与 lib/parse.js 同一实现
function topLevelDivs(html) {
  const out = [];
  let depth = 0;
  let start = -1;
  const re = /<div\b|<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0] === "</div>") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(html.slice(start, m.index + m[0].length));
        start = -1;
      }
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return out;
}

// 取 div 块内部内容（去掉自身开闭标签）
function innerOf(block) {
  const a = block.indexOf(">");
  const b = block.lastIndexOf("</div>");
  return a >= 0 ? block.slice(a + 1, b > a ? b : undefined) : block;
}

function cellsOf(block) {
  return topLevelDivs(innerOf(block));
}

function nameOf(m, textIdx) {
  return m && m[textIdx] ? txt(m[textIdx]) : null;
}

// ---------- 赛历 ----------
// 返回 [{ date:"2026-10-24", track:"231", scope:"local", gradeTag:"Jpn3"|null }]
export function parseCalendar(html) {
  const out = [];
  const re =
    /<li class="calendar__track-([12])">\s*[\s\S]{0,600}?<a href="\/race\/calendar\/(\d{4})(\d{2})(\d{2})\/(\d{3})\/">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const g = m[6].match(/class="tag-race-([^"]+)"/);
    out.push({
      date: `${m[2]}-${m[3]}-${m[4]}`,
      track: m[5],
      scope: m[1] === "1" ? "central" : "local",
      gradeTag: g ? g[1] : null,
    });
  }
  // 去重（同一 date+track 只留一条）
  const seen = new Set();
  return out.filter((x) => {
    const k = x.date + ":" + x.track;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- 当日页 ----------
// 返回 { layout:"central"|"local", races:[...] }
export function parseDayPage(html) {
  let cls = null;
  if (html.includes('<div class="data-6-12"')) cls = "data-6-12";
  else if (html.includes('<div class="data-6-35"')) cls = "data-6-35";
  if (!cls) return { layout: null, races: [] };

  const block = topLevelDivs(html.slice(html.indexOf(`<div class="${cls}"`)))[0];
  if (!block) return { layout: null, races: [] };

  const parts = cellsOf(block);
  if (parts.length < 2) return { layout: null, races: [] };

  const hdr = cellsOf(parts[0]).map(txt);
  const idx = {};
  hdr.forEach((t, i) => {
    if (/^R$/i.test(t)) idx.no = i;
    else if (/レース名/.test(t)) idx.name = i;
    else if (/芝ダ/.test(t)) idx.surface = i;
    else if (/距離/.test(t)) idx.distance = i;
    else if (/頭数/.test(t)) idx.heads = i;
    else if (/発走/.test(t)) idx.time = i;
    else if (/勝馬/.test(t)) idx.winner = i;
  });

  const races = [];
  for (const row of parts.slice(1)) {
    const cells = cellsOf(row);
    if (cells.length < 4) continue;

    const nameCell = cells[idx.name ?? 1] ?? "";
    const link = nameCell.match(/href="\/race\/(result\/)?(\d{4})(\d{2})(\d{2})\/(\d{3})\/(\d{2})\//);
    const nameA = nameCell.match(/<a [^>]*>([\s\S]*?)<\/a>/);
    const g = nameCell.match(/class="tag-race-([^"]+)"/);
    const gradeTag = g ? g[1] : null;

    const surface = txt(cells[idx.surface ?? 2] ?? "").match(/芝|ダ|障/);
    const distM = txt(cells[idx.distance ?? 3] ?? "").match(/(\d{3,4})\s*m/);
    const headsM = txt(cells[idx.heads ?? 4] ?? "").match(/(\d+)\s*頭/);
    const timeM = idx.time != null ? txt(cells[idx.time]).match(/\d{1,2}:\d{2}/) : null;
    const winnerTxt = idx.winner != null ? txt(cells[idx.winner]) : "";

    if (!link || !nameA) continue;

    const raceNo = parseInt(link[6], 10);
    const name = txt(nameA[1]);
    const k = klassOf({ name, gradeTag, scope: cls === "data-6-12" ? "central" : "local" });

    races.push({
      no: raceNo,
      startTime: timeM ? timeM[0] : null,
      name,
      surface: surface ? surface[0] : null,
      distance: distM ? parseInt(distM[1], 10) : null,
      heads: headsM ? parseInt(headsM[1], 10) : null,
      gradeTag,
      klass: k.klass,
      klassGroup: k.group,
      raceKey: `${link[2]}${link[3]}${link[4]}/${link[5]}/${link[6]}`,
      // 已出结果的场次不再当作"出走表"目标；头数未定 = 尚未公开
      status: !headsM ? "pending" : winnerTxt === "-" || winnerTxt === "" ? "entries" : "result",
    });
  }
  return { layout: cls === "data-6-12" ? "central" : "local", races };
}

// ---------- 出馬表 ----------
// 返回 null 表示该页不是出馬表（未公开 / 已转为结果页）
export function parseEntryPage(html) {
  const at = html.indexOf('<div class="data-6-27"');
  if (at < 0) return null;

  const block = topLevelDivs(html.slice(at))[0];
  if (!block) return null;
  const parts = cellsOf(block);
  if (parts.length < 2) return null;

  const hdr = cellsOf(parts[0]).map(txt);
  const idx = {};
  hdr.forEach((t, i) => {
    // 枠番：中央写「枠番」、地方可能只写「枠」；馬番同理。未確定页可能整列缺失 →
    // 必须严格按表头定位（parseRunner 里不再按位置回退，避免把馬名/性齢格误当番号）
    if (/枠/.test(t)) idx.frame = i;
    else if (/馬番/.test(t)) idx.num = i;
    else if (/競走馬名/.test(t)) idx.horse = i;
    else if (/性齢/.test(t)) idx.sex = i;
    else if (/騎手/.test(t)) idx.jockey = i;
    else if (/指数/.test(t)) idx.speed = i;
    else if (/調教師/.test(t)) idx.conn = i;
    else if (/1走前/.test(t)) idx.r1 = i;
    else if (/2走前/.test(t)) idx.r2 = i;
    else if (/3走前/.test(t)) idx.r3 = i;
  });

  const runners = [];
  for (const row of parts.slice(1)) {
    const cells = cellsOf(row);
    if (cells.length < 4) continue;
    const r = parseRunner(cells, idx);
    if (r) runners.push(r);
  }
  return { header: hdr, runners };
}

function parseRunner(cells, idx) {
  const get = (k, fallback) => cells[idx[k] ?? fallback] ?? "";

  const horseCell = get("horse", 2);
  const hm = horseCell.match(/<a href="\/horse\/(\d{10})\/"[^>]*>([\s\S]*?)<\/a>/);
  if (!hm) return null;

  const sire = horseCell.match(/>\s*父：\s*<a href="\/horse\/(\d{10})\/"[^>]*>([\s\S]*?)<\/a>/);
  const dam = horseCell.match(/>\s*母：\s*<a href="\/horse\/(\d{10})\/"[^>]*>([\s\S]*?)<\/a>/);
  const bms = horseCell.match(/>\s*母父：\s*<a href="\/horse\/(\d{10})\/"[^>]*>([\s\S]*?)<\/a>/);
  const sale = horseCell.match(/href="\/seri\/([^"]+)\/"[^>]*>([\s\S]*?)<\/a>/);
  const price = txt(horseCell).match(/([\d,.]+\s*万円)/);

  // 枠番/馬番：仅认表头列。未確定页（只有基本参赛信息、番号次日才公开）或列值
  // 为「--」时正则不命中 → null；UI/CSV 对 null 显示空。绝不按位置猜列。
  const frameCell = idx.frame != null ? cells[idx.frame] ?? "" : "";
  const numCell = idx.num != null ? cells[idx.num] ?? "" : "";
  // 性齢/騎手/調教師：表头列优先（缺列不再按位置回退，避免误抓）
  const sexCell = idx.sex != null ? cells[idx.sex] ?? "" : "";
  const jockeyCell = idx.jockey != null ? cells[idx.jockey] ?? "" : "";
  const connCell = idx.conn != null ? cells[idx.conn] ?? "" : "";

  // 骟马 JBIS 写作「セン」（两字符）：须先于单字 セ 匹配，否则「セン5」整条匹配失败
  const sex = sexCell.match(/(牡|牝|セン|セ|騸)\s*(\d{1,2})/);
  const color = sexCell.match(/(黒鹿毛|青鹿毛|鹿毛|栗毛|青毛|芦毛|白毛|粕毛|月毛|桃毛|河原毛|駁毛|不正毛)/);
  const jockey = jockeyCell.match(/\/race\/jockey\/([^/"]+)\/"[^>]*>([\s\S]*?)<\/a>/);
  const weight = jockeyCell.match(/(\d{2,3}(?:\.\d)?)\s*</);
  const trainer = connCell.match(/\/race\/trainer\/([^/"]+)\/"[^>]*>([\s\S]*?)<\/a>/);
  const belongs = connCell.match(/<\/a>\s*\(([^)]+)\)/);
  const owner = connCell.match(/\/race\/owner\/([^/"]+)\/"[^>]*>([\s\S]*?)<\/a>/);
  const breeder = connCell.match(/\/breeder\/(\d{10})\/"[^>]*>([\s\S]*?)<\/a>/);

  const pid = (m, textIdx) => (m ? { id: m[1], name: txt(m[textIdx]) } : null);

  return {
    frame: (frameCell.match(/\d+/) || [null])[0] ? parseInt(frameCell.match(/\d+/)[0], 10) : null,
    num: (numCell.match(/(\d+)\s*番/) || [])[1] ? parseInt(numCell.match(/(\d+)\s*番/)[1], 10) : null,
    horse: { id: hm[1], name: txt(hm[2]) },
    sex: sex ? sex[1] : null,
    age: sex ? parseInt(sex[2], 10) : null,
    color: color ? color[1] : null,
    jockey: jockey ? { id: jockey[1], name: txt(jockey[2]) } : null,
    weight: weight ? parseFloat(weight[1]) : null,
    trainer: trainer ? { id: trainer[1], name: txt(trainer[2]) } : null,
    belongs: belongs ? belongs[1].trim() : null,
    owner: owner ? { id: owner[1], name: txt(owner[2]) } : null,
    breeder: pid(breeder, 2),
    sire: pid(sire, 2),
    dam: pid(dam, 2),
    bms: pid(bms, 2),
    sale: sale ? { path: sale[1], name: txt(sale[2]) } : null,
    price: price ? price[1].replace(/\s+/g, "") : null,
    speedIndex: parseFloat(txt(get("speed", 5))) || null,
    recent: [get("r1", 7), get("r2", 8), get("r3", 9)]
      .map(parseRecent)
      .filter(Boolean),
  };
}

// 前走块：着順 span + 日期/场 + 赛名链接 + 明细行
function parseRecent(cell) {
  if (!cell) return null;
  const rank = cell.match(/<span class="number-\d+"><b>([\s\S]*?)<\/b><\/span>/);
  const dateM = cell.match(/(\d{4}\.\d{2}\.\d{2})\s+([^\s<]+)/);
  const race = cell.match(/href="\/race\/result\/(\d{8})\/(\d{3})\/(\d{2})\/"[^>]*>([\s\S]*?)<\/a>/);
  if (!dateM && !race) return null;

  const raw = txt(cell).replace(/\n/g, " ");
  const course = raw.match(/(芝|ダ|障)\s*(\d{3,4})\s*(良|稍重|重|不良)?/);
  const time = raw.match(/(\d:\d{2}\.\d)/);
  const margin = raw.match(/（([\d.]+)）/);
  const body = raw.match(/(\d{3})\s*([+\-－]\d+|\s*－)\s*([^\s（]+)（([\d.]+)）/);

  return {
    rank: rank ? txt(rank[1]) : null,
    date: dateM ? dateM[1].replace(/\./g, "-") : null,
    venue: dateM ? dateM[2].trim() : null,
    raceKey: race ? `${race[1]}/${race[2]}/${race[3]}` : null,
    raceName: race ? txt(race[4]) : null,
    surface: course ? course[1] : null,
    distance: course ? parseInt(course[2], 10) : null,
    going: course ? course[3] ?? null : null,
    time: time ? time[1] : null,
    margin: margin ? parseFloat(margin[1]) : null,
    bodyWeight: body ? parseInt(body[1], 10) : null,
    bodyDelta: body ? parseInt(body[2].replace(/[－\s]/g, "-"), 10) || 0 : null,
    jockey: body ? body[3] : null,
    jockeyWeight: body ? parseFloat(body[4]) : null,
    raw,
  };
}

// ---------- 血统页 ----------
// 返回 { sire, sireSire, sireDam, dam, damSire, damDam }（各为 {id,name} 或 null）
export function parsePedigree(html) {
  const at = html.indexOf('<div class="data-3__inner"');
  if (at < 0) return null;

  const profileAt = html.indexOf("プロフィール", at);
  const block = html.slice(at, profileAt > at ? profileAt : at + 8000);
  const items = block.split('class="data-3__items"').slice(1);
  const pick = (s) =>
    [...s.matchAll(/<a href="\/horse\/(\d{10})\/"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
      id: m[1],
      name: txt(m[2]),
    }));

  const male = pick(items[0] || "");
  const female = pick(items[1] || "");
  return {
    sire: male[0] ?? null,
    sireSire: male[1] ?? null,
    sireDam: male[2] ?? null,
    dam: female[0] ?? null,
    damSire: female[1] ?? null,
    damDam: female[2] ?? null,
  };
}
