// 已知「父马 → 祖父」补全表（South America / 日本血统）
//
// ## 为什么需要
// 智利、巴西的节目源只给父马（padrillo），不给祖父；日本/欧美源一般都有。
// 于是同一匹种马在智利跑出来的产驹，祖父一栏是空的 —— 前端「按祖父筛选」
// （血统快捷标签 sireSire，默认就带「ディープインパクト」）因此筛不到它们。
// 这不是赛场上没有该血统，是字段缺。
//
// ## 维护规则
// 只收「已在当地配种、且有产驹出赛/登记」的种马，键用小写去符号的归一化名（同 horse-name.mjs 口径），
// 值必须是「名字 + 国别」两段（build 的 nameWithCountry 负责拼成 "Deep Impact (JPN)"）。
// 每条都要能追溯到公开来源，写在 comment 里。
//
// 注意：这是**兜底**，不覆盖已有值 —— 卡片里已经有 sireSire 的以卡片为准（日本/欧美源更权威）。
export const KNOWN_SIRE_OF_SIRE = {
  // ヒラボクディープ / Hiraboku Deep（2010, 父 Deep Impact × Cat Ali）
  // 日本 24 战 4 胜，2013 青叶赏 GII；退役后到智利 Haras Matriarca 配种，配种费 USD 1,000 + IVA。
  // 来源：https://en.netkeiba.com/db/horse/ped/2010100460
  //      https://harasmatriarca.com/（种马名单含 Hiraboku Deep (2010) JPN）
  hirabokudeep: { name: "Deep Impact", country: "JPN" },

  // サトノフラッグ / Satono Flag（2017, 父 Deep Impact × Balada Sale）
  // 2020 弥生賞ディープインパクト記念 GII；2023-03 起在阿根廷 Haras Vacación 配种，
  // 是首匹被卖到南美大陆做种马的 Deep Impact 直系。
  // 来源：https://harasvacacion.com/vacacion/ejemplares-home?id_ejemplar=1004307
  //      https://asianracingreport.com/deep-impacts-boys-secure-stud-berths/
  satonoflag: { name: "Deep Impact", country: "JPN" },

  // ---- 澳大利亚 / 新西兰在种（2026-11 出走数据实测有产驹，配种地点经公开来源核实）----

  // トーセンスタードム / Tosen Stardom（2012, 父 Deep Impact）
  // 在澳 2017 Toorak Hcp G1 + Mackinnon Stakes G1；Woodside Park Stud (VIC) 配种。
  // 来源：https://www.racingandsports.com.au/news/breeding/news/2019-07-31/deep-impact-leaves-lasting-influence-in-australia/491381
  tosenstardom: { name: "Deep Impact", country: "JPN" },

  // サクソンウォリアー / Saxon Warrior（2015, 父 Deep Impact × Maybe）
  // 2018 2000 Guineas G1 + Racing Post Trophy G1；Coolmore Australia 配种。
  // 来源：同上 racingandsports 2019-07-31
  saxonwarrior: { name: "Deep Impact", country: "JPN" },

  // フィアスインパクト / Fierce Impact（2015, 父 Deep Impact）
  // 在澳 G1 三胜（Cantala S. / Makybe Diva S. / Futurity S.）；Leneva Park 配种。
  // 来源：https://lenevapark.com.au/ + Breednet stallion directory
  fierceimpact: { name: "Deep Impact", country: "JPN" },

  // サトノアラジン / Satono Aladdin（2014, 父 Deep Impact）
  // 2017 安田記念 G1；Rich Hill Stud (NZ) 配种。
  // 来源：同上 racingandsports 2019-07-31
  satonoaladdin: { name: "Deep Impact", country: "JPN" },

  // スタファノス / Staphanos（2013, 父 Deep Impact）
  // 在日 G3 胜ち（2018 Autumn S. G2 等）；Novara Park (NZ) 配种。
  // 来源：同上 racingandsports 2019-07-31
  staphanos: { name: "Deep Impact", country: "JPN" },

  // ミッキアイル / Mikki Isle（2011, 父 Deep Impact）
  // 2016 NHK マイルカップ G1；Arrowfield Stud (NSW) 配种。
  // 来源：同上 racingandsports 2019-07-31
  mikkiisle: { name: "Deep Impact", country: "JPN" },

  // リアルインパクト / Real Impact（2008, 父 Deep Impact）
  // 2011 安田記念 G1 + 在澳 2017 George Ryder S. G1；2015-17 Arrowfield 在种后回日，
  // 澳洲产驹仍在出赛中（2026-11 数据实测 1 頭）。
  // 来源：同上 racingandsports 2019-07-31
  realimpact: { name: "Deep Impact", country: "JPN" },
};

// 归一化：与 site/horse-name.mjs 的 normalizeHorseName 同口径（小写、去括号国别、去标点空白）
export const sireKey = (v) => {
  const raw = v && typeof v === "object" ? String(v.name ?? "") : String(v ?? "");
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]/g, "")
    .trim();
};

// 给 runner 取祖父：卡片有值用卡片值，否则查表（返回与卡片同形态的对象或 null）
export function sireSireOf(runner) {
  if (runner?.sireSire && (typeof runner.sireSire !== "object" || runner.sireSire.name)) return runner.sireSire;
  const hit = KNOWN_SIRE_OF_SIRE[sireKey(runner?.sire)];
  return hit ? { id: null, name: hit.name, country: hit.country } : null;
}
