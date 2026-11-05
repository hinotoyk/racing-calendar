// netkeiba 解析（彩衣/勝負服，docs 探索结论 2026-11-03）
// 彩衣属马主：马页（db.netkeiba.com/horse/{id}/，EUC-JP）「馬主」格内嵌
//   <img class="OwnerColours" src=".../img/db/colours/{ownerId}.{gif|png}" alt="马主名">
//   <a href=".../owner/{ownerId}/">马主名</a>
// NAR 出馬表（nar.netkeiba.com/race/shutuba.html?race_id=YYYY+jyo+MM+DD+RR）
//   每匹马: <a href="https://db.netkeiba.com/horse/{nkId}" title="馬名" id="umalink_{nkId}">

// ---------- 出馬表：马名 → netkeiba 马号 ----------
// 返回 Map<马名, nkId>；马名已做归一（去空白/去尾缀括注），与 JBIS 侧同名归一对齐
export function parseNkShutuba(html) {
  const map = new Map();
  const re = /<a\s[^>]*id="umalink_(\d+)"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const nkId = m[1];
    const tag = m[0];
    const tm = tag.match(/title="([^"]*)"/);
    if (!tm) continue;
    const name = nkNameKey(tm[1]);
    if (name) map.set(name, nkId);
  }
  return map;
}

// 马名归一：JBIS 与 netkeiba 写法差异（空白、"(USA)" 国名括注、出马表装备标记 " B" 等）
// 装备标记（ブリンカー等）仅 JBIS 出马表显示用，登录名无此尾缀；
// 只剥「主体含假名/汉字」的 ASCII 大写字母尾缀——纯 ASCII 外语名的字母可能是真名
// 一部分（如 Indy B），不可剥。已穷举全量 13799 名：假名/汉字主体+字母尾缀仅 " B"（190例）
export function nkNameKey(name) {
  let s = String(name ?? "").replace(/\s+/g, "");
  // 尾缀可叠加（"ディープスリー(USA) B"），循环剥到稳定（最多3层足够）
  for (let i = 0; i < 3; i++) {
    const before = s;
    if (/[\u3040-\u30FF\u4E00-\u9FFF々〆]/.test(s)) {
      s = s.replace(/[A-Z]$/u, ""); // 装备标记尾缀
    }
    s = s.replace(/[\(（][^)）]*[\)）]$/u, ""); // 国名括注尾缀
    if (s === before) break;
  }
  return s;
}

// ---------- 马页：馬主格 → 彩衣图 + 马主 ----------
// 返回 { colours, owner } 或 null（非马页/解析失败）
export function parseNkHorse(html) {
  const at = html.indexOf("<th>馬主</th>");
  if (at < 0) return null;
  const seg = html.slice(at, at + 1500);

  // OwnerColours img：属性序不定，src/class 两个方向都试
  const img =
    seg.match(/<img[^>]*class="OwnerColours"[^>]*src="([^"]+)"/) ??
    seg.match(/<img[^>]*src="([^"]+)"[^>]*class="OwnerColours"/);
  // noimage / no_data 占位图视为无彩衣（马主未登记时 netkeiba 回退占位）
  const rawUrl = img ? img[1] : null;
  const colours =
    rawUrl && !/(noimage|no_data)/i.test(rawUrl)
      ? rawUrl.replace(/^\/\//, "https://")
      : null;

  const om = seg.match(/\/owner\/(\d+)\/?"[^>]*>([^<]+)</);
  const owner = om ? { id: om[1], name: om[2].trim() } : null;
  if (!colours && !owner) return null;
  return { colours, owner };
}

// ---------- 马名搜索（ajax_horse_search.html，EUC-JP）----------
// 返回 [{ id, name, sex, birthYear, owner }]；无匹配返回 []
// 行结构：<a href=".../horse/{id}/">馬名</a> … birthyear={YYYY} … /owner/race.html?id={oid} title="馬主"
export function parseNkSearchRows(html) {
  if (!html || html.includes("見つかりません")) return [];
  const out = [];
  // 逐 <tr> 切行（马名锚点所在行为准）
  for (const m of html.matchAll(/<a href="https?:\/\/db\.netkeiba\.com\/horse\/(\w{6,12})\/"[^>]*>([^<]+)<\/a>/g)) {
    const id = m[1];
    const name = m[2].trim();
    // 该锚点所在行：向前取 <tr> 起点、向后取行尾
    const rowStart = html.lastIndexOf("<tr", m.index);
    const rowEnd = html.indexOf("</tr>", m.index);
    const row = html.slice(rowStart, rowEnd > rowStart ? rowEnd : m.index + 2000);
    const by = row.match(/birthyear=(\d{4})/) ?? row.match(/>(\d{4})</);
    const om = row.match(/\/owner\/race\.html\?id=(\d+)"[^>]*title="([^"]+)"/);
    out.push({
      id,
      name,
      birthYear: by ? parseInt(by[1], 10) : null,
      owner: om ? { id: om[1], name: om[2].trim() } : null,
    });
  }
  return out;
}
