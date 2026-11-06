// 临时演示：5 种完全不同风格的出馬表分享卡（数据 = 2026-11-08 東京11R アルゼンチン共和国杯，真实采集数据）
// 生成 design/share-cards-demo.html；彩衣 GIF 转 base64 内嵌，单文件自包含
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const race = JSON.parse(fs.readFileSync(path.join(ROOT, "design/.race-tmp.json"), "utf8"));

// 彩衣内嵌
for (const r of race) {
  const p = path.join(ROOT, r.silk);
  r.silkData = "data:image/gif;base64," + fs.readFileSync(p).toString("base64");
}

// 北京时间
const bj = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(race[0].startTimeInstant));

const meta = {
  date: "2026-11-08（日）",
  venue: "東京", raceNo: 11, name: "アルゼンチン共和国杯", klass: "GⅡ",
  surface: "芝", dist: "2500m", start: race[0].startTime, bj, heads: race.length,
};
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// JRA 枠番官方色（1白 2黒 3赤 4青 5黄 6緑 7橙 8桃）
const WAKU = ["", "#ffffff", "#111111", "#e60012", "#0072bc", "#f5c400", "#00a651", "#f08300", "#f4a7b9"];

const card1 = `<!-- ① 复古赛马报纸 Form Guide 风：粉纸、玛瑙小字、细线、彩衣是唯一彩色 -->
<article class="card c1">
  <div class="c1-mast">THE DAILY RACING FORM</div>
  <div class="c1-dateline">${meta.date} · ${meta.venue} ${meta.raceNo}R · ${meta.heads} runners · 発走 ${meta.start}（北京 ${meta.bj}）</div>
  <div class="c1-rule-double"></div>
  <h2 class="c1-title">${esc(meta.name)} <span>${meta.klass} · ${meta.surface}${meta.dist}</span></h2>
  <div class="c1-rule"></div>
  <table class="c1-t">
    <thead><tr><th>枠馬</th><th></th><th class="l">馬名</th><th>性齢</th><th>斤量</th><th>騎手</th><th>母父</th></tr></thead>
    <tbody>${race.map((r) => `
      <tr>
        <td class="mono">${r.frame}・${r.num}</td>
        <td class="silkc"><img src="${r.silkData}" alt=""></td>
        <td class="l strong">${esc(r.horseName)}</td>
        <td class="mono">${esc(r.sex)}${r.age}</td>
        <td class="mono">${r.weight}</td>
        <td>${esc(r.jockey)}</td>
        <td class="dim">${esc(r.bms)}</td>
      </tr>`).join("")}
    </tbody>
  </table>
  <div class="c1-foot">集計：racing-calendar · 出走確定時点 · 斤量単位 kg</div>
</article>`;

const card2 = `<!-- ② Racing Post 英式现代报头风：白底红标、粗报头、加粗数字列 -->
<article class="card c2">
  <div class="c2-mast">RACING POST<span>SHARE EDITION</span></div>
  <div class="c2-head">
    <div class="c2-race">
      <span class="c2-badge">${meta.venue} ${meta.raceNo}R</span>
      <h2>${esc(meta.name)} <em>${meta.klass}</em></h2>
      <p>${meta.surface} ${meta.dist} · ${meta.start} JST（北京 ${meta.bj}） · ${meta.heads} runners · ${meta.date}</p>
    </div>
  </div>
  <table class="c2-t">
    <thead><tr><th>No</th><th></th><th class="l">Horse</th><th>Sex/Age</th><th>Wgt</th><th class="l">Jockey</th><th class="l">Trainer</th></tr></thead>
    <tbody>${race.map((r) => `
      <tr>
        <td class="num-strong"><span class="c2-waku" style="background:${WAKU[r.frame]};${r.frame===1||r.frame===5?"border-color:#999;color:#111;":""}">${r.frame}</span>${r.num}</td>
        <td class="silkc"><img src="${r.silkData}" alt=""></td>
        <td class="l strong">${esc(r.horseName)}</td>
        <td class="mono">${esc(r.sex)}${r.age}</td>
        <td class="mono">${r.weight}</td>
        <td>${esc(r.jockey)}</td>
        <td class="dim">${esc(r.trainer)}</td>
      </tr>`).join("")}
    </tbody>
  </table>
</article>`;

const card3 = `<!-- ③ 暗色体育 App 风：近黑底、荧光点缀、圆角徽章 -->
<article class="card c3">
  <header class="c3-head">
    <div class="c3-meta"><span class="c3-chip on">${meta.venue}</span><span class="c3-chip">${meta.raceNo}R</span><span class="c3-chip">${meta.klass}</span></div>
    <h2>${esc(meta.name)}</h2>
    <div class="c3-sub"><b>${meta.surface} ${meta.dist}</b><i></i>${meta.start} JST<i></i>北京 ${meta.bj}<i></i>${meta.heads}頭</div>
  </header>
  <div class="c3-list">${race.map((r) => `
    <div class="c3-row">
      <span class="c3-frame" style="--wc:${WAKU[r.frame]};${r.frame===1||r.frame===5?"--wc-text:#111;":""}">${r.frame}</span>
      <span class="c3-num mono">${r.num}</span>
      <img class="c3-silk" src="${r.silkData}" alt="">
      <span class="c3-name">${esc(r.horseName)}<small>${esc(r.sex)}${r.age} · ${esc(r.jockey)}</small></span>
      <span class="c3-w mono">${r.weight}<small>kg</small></span>
    </div>`).join("")}
  </div>
  <footer class="c3-foot">racing-calendar · LIVE CARD</footer>
</article>`;

const card4 = `<!-- ④ 日式赛马新聞印刷风：米色纸、枠番色块、竖排见出し -->
<article class="card c4">
  <div class="c4-body">
    <div class="c4-side"><span>${esc(meta.name)}</span></div>
    <div class="c4-main">
      <div class="c4-head">
        <div class="c4-title"><b>${meta.venue}${meta.raceNo}R</b> ${esc(meta.name)}<span class="c4-g">${meta.klass}</span></div>
        <div class="c4-meta">${meta.date} ／ ${meta.surface}・${meta.dist} ／ 発走 ${meta.start}（北京 ${meta.bj}） ／ ${meta.heads}頭立</div>
      </div>
      <div class="c4-wakulegend">${WAKU.slice(1).map((c, i) => `<i style="background:${c};${i===0||i===4?"box-shadow:inset 0 0 0 1px #bbb;":""}"></i><em>${i + 1}</em>`).join("")}</div>
      <table class="c4-t">
        <thead><tr><th>枠</th><th>馬番</th><th></th><th class="l">馬名</th><th>性齢</th><th>斤量</th><th class="l">騎手</th><th class="l">父</th></tr></thead>
        <tbody>${race.map((r) => `
          <tr>
            <td><i class="c4-waku" style="background:${WAKU[r.frame]};${r.frame===1||r.frame===5?"box-shadow:inset 0 0 0 1px #bbb;":""}"></i></td>
            <td class="mono strong">${r.num}</td>
            <td class="silkc"><img src="${r.silkData}" alt=""></td>
            <td class="l strong">${esc(r.horseName)}</td>
            <td class="mono">${esc(r.sex)}${r.age}</td>
            <td class="mono">${r.weight}</td>
            <td>${esc(r.jockey)}</td>
            <td class="dim">${esc(r.sire)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div class="c4-foot">出走表（自動生成）・単位：kg</div>
    </div>
  </div>
</article>`;

const card5 = `<!-- ⑤ 瑞士国际主义极简海报风：巨型标题、单一强调色、极淡网格线 -->
<article class="card c5">
  <div class="c5-top">
    <h2>TOKYO<span>R11</span></h2>
    <div class="c5-meta">
      <b>${esc(meta.name)}</b>
      <p>${meta.klass} · TURF ${meta.dist} · ${meta.start} JST / ${meta.bj} BJT · ${meta.heads} STARTERS · ${meta.date}</p>
    </div>
  </div>
  <table class="c5-t">
    <thead><tr><th>FM</th><th></th><th class="l">HORSE</th><th>S/A</th><th>KG</th><th class="l">JOCKEY</th></tr></thead>
    <tbody>${race.map((r) => `
      <tr>
        <td class="mono c5-fm">${r.frame}<em>·</em>${r.num}</td>
        <td class="silkc"><img src="${r.silkData}" alt=""></td>
        <td class="l strong">${esc(r.horseName)}</td>
        <td class="mono">${esc(r.sex)}${r.age}</td>
        <td class="mono">${r.weight}</td>
        <td class="c5-j">${esc(r.jockey)}</td>
      </tr>`).join("")}
    </tbody>
  </table>
  <div class="c5-foot">RACING-CALENDAR · FORM CARD №1108-11</div>
</article>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>出馬表分享卡 · 5 风格提案</title>
<style>
  :root { --waku1:#fff; --waku5:#f5c400; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #e9e7e2; font-family: "Helvetica Neue", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Microsoft YaHei", sans-serif; padding: 32px 16px 64px; }
  .wrap { max-width: 780px; margin: 0 auto; display: flex; flex-direction: column; gap: 48px; }
  .tag { font-size: 13px; color: #666; margin-bottom: 10px; font-weight: 600; letter-spacing: .04em; }
  .tag small { font-weight: 400; color: #999; display: block; margin-top: 2px; }
  .card { width: 100%; box-shadow: 0 2px 14px rgba(0,0,0,.10); }
  .mono { font-variant-numeric: tabular-nums; }
  .strong { font-weight: 700; }
  .dim { opacity: .62; }
  .l { text-align: left; }
  .silkc img { height: 24px; display: block; }

  /* ① 复古粉纸 Form Guide */
  .c1 { background: #f6d9cc; color: #241a16; padding: 26px 22px 18px; font-family: Georgia, "Times New Roman", "Noto Serif SC", "Hiragino Mincho ProN", serif; }
  .c1-mast { text-align: center; font-size: 26px; letter-spacing: .28em; font-weight: 700; }
  .c1-dateline { text-align: center; font-size: 10.5px; letter-spacing: .12em; margin-top: 6px; text-transform: uppercase; }
  .c1-rule-double { border-top: 2.5px solid #241a16; border-bottom: .5px solid #241a16; height: 4px; margin: 10px 0 0; }
  .c1-title { text-align: center; font-size: 19px; margin: 12px 0 0; font-weight: 700; }
  .c1-title span { font-size: 12px; font-weight: 400; margin-left: 8px; opacity: .75; }
  .c1-rule { border-bottom: .5px solid #241a16; margin-top: 10px; }
  .c1-t { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .c1-t th { font-size: 9.5px; letter-spacing: .1em; padding: 6px 6px 4px; border-bottom: 1px solid #241a16; text-align: right; font-weight: 700; }
  .c1-t th.l { text-align: left; }
  .c1-t td { padding: 4.5px 6px; border-bottom: .5px solid rgba(36,26,22,.35); text-align: right; }
  .c1-t td.l { text-align: left; }
  .c1-t .strong { font-weight: 700; }
  .c1-foot { margin-top: 10px; font-size: 9px; letter-spacing: .08em; text-align: center; opacity: .6; }

  /* ② Racing Post 风 */
  .c2 { background: #fff; color: #111; }
  .c2-mast { background: #d0021b; color: #fff; font-size: 30px; font-weight: 800; font-style: italic; padding: 12px 20px; letter-spacing: .02em; display: flex; justify-content: space-between; align-items: baseline; }
  .c2-mast span { font-size: 10px; font-weight: 700; font-style: normal; letter-spacing: .3em; opacity: .85; }
  .c2-head { padding: 16px 20px 12px; border-bottom: 3px solid #111; }
  .c2-badge { background: #111; color: #fff; font-size: 11px; font-weight: 800; padding: 3px 8px; letter-spacing: .06em; }
  .c2-race h2 { font-size: 24px; font-weight: 800; margin-top: 8px; }
  .c2-race h2 em { color: #d0021b; font-style: normal; font-size: 16px; vertical-align: middle; margin-left: 6px; }
  .c2-race p { font-size: 12px; color: #555; margin-top: 4px; }
  .c2-t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .c2-t th { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #d0021b; border-bottom: 1.5px solid #111; padding: 8px 6px 5px; text-align: right; }
  .c2-t th.l { text-align: left; }
  .c2-t td { padding: 6.5px 6px; border-bottom: .5px solid #ddd; text-align: right; }
  .c2-t td.l { text-align: left; }
  .num-strong { font-weight: 800; white-space: nowrap; }
  .c2-waku { display: inline-block; width: 16px; height: 16px; border: 1.5px solid #111; margin-right: 6px; vertical-align: -3px; color: #fff; font-size: 10px; line-height: 13.5px; text-align: center; font-weight: 800; }
  .c2-t .silkc img { height: 26px; }

  /* ③ 暗色 App 风 */
  .c3 { background: #0e1116; color: #e8eaed; border-radius: 18px; overflow: hidden; }
  .c3-head { padding: 22px 22px 16px; background: linear-gradient(135deg, #14202e 0%, #0e1116 70%); border-bottom: 1px solid rgba(255,255,255,.08); }
  .c3-chip { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.22); color: #b8c0ca; margin-right: 6px; }
  .c3-chip.on { background: #c6f432; color: #111; border-color: #c6f432; }
  .c3-head h2 { font-size: 22px; font-weight: 800; margin-top: 10px; color: #fff; }
  .c3-sub { margin-top: 6px; font-size: 12px; color: #9aa3ad; display: flex; align-items: center; gap: 8px; }
  .c3-sub b { color: #c6f432; }
  .c3-sub i { width: 3px; height: 3px; border-radius: 50%; background: #555; }
  .c3-list { padding: 6px 22px 12px; }
  .c3-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
  .c3-row:last-child { border-bottom: none; }
  .c3-frame { width: 22px; height: 22px; border-radius: 50%; background: var(--wc); color: var(--wc-text, #fff); font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,.15); }
  .c3-num { width: 18px; text-align: center; color: #b8c0ca; font-size: 13px; flex: none; }
  .c3-silk { height: 26px; flex: none; filter: drop-shadow(0 1px 3px rgba(0,0,0,.5)); }
  .c3-name { flex: 1; font-weight: 700; font-size: 13.5px; color: #fff; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .c3-name small { display: block; font-weight: 400; font-size: 10.5px; color: #8b95a1; margin-top: 1px; }
  .c3-w { color: #c6f432; font-weight: 700; font-size: 14px; text-align: right; flex: none; }
  .c3-w small { font-size: 9px; color: #8b95a1; font-weight: 400; margin-left: 2px; }
  .c3-foot { padding: 10px 22px 16px; font-size: 9.5px; letter-spacing: .25em; color: #5a636d; text-align: right; }

  /* ④ 日式新聞印刷风 */
  .c4 { background: #fbf7ec; border: 1px solid #d8d0bc; padding: 14px; color: #26221a; }
  .c4-body { display: flex; gap: 12px; }
  .c4-side { writing-mode: vertical-rl; font-family: "Hiragino Mincho ProN", "Noto Serif SC", "Yu Mincho", serif; font-size: 17px; font-weight: 700; letter-spacing: .3em; border-left: 2px solid #b3241c; border-right: 2px solid #b3241c; padding: 10px 7px; color: #b3241c; flex: none; }
  .c4-main { flex: 1; min-width: 0; }
  .c4-title { font-size: 18px; font-weight: 700; font-family: "Hiragino Mincho ProN", "Noto Serif SC", serif; }
  .c4-g { display: inline-block; background: #b3241c; color: #fff; font-size: 11px; padding: 2px 7px; margin-left: 8px; vertical-align: 3px; }
  .c4-meta { font-size: 10.5px; color: #6d6552; margin: 5px 0 8px; }
  .c4-wakulegend { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
  .c4-wakulegend i { width: 13px; height: 13px; display: inline-block; }
  .c4-wakulegend em { font-style: normal; font-size: 9.5px; color: #6d6552; margin-right: 6px; }
  .c4-t { width: 100%; border-collapse: collapse; font-size: 12px; }
  .c4-t th { font-size: 10px; border-top: 2px solid #26221a; border-bottom: 1px solid #26221a; padding: 5px 4px; text-align: right; background: #f3eddb; }
  .c4-t th.l { text-align: left; }
  .c4-t td { padding: 5px 4px; border-bottom: .5px solid #d8d0bc; text-align: right; }
  .c4-t td.l { text-align: left; }
  .c4-waku { width: 14px; height: 14px; display: inline-block; }
  .c4-t .silkc img { height: 25px; }
  .c4-foot { margin-top: 8px; font-size: 9px; color: #6d6552; text-align: right; }

  /* ⑤ 瑞士极简海报风 */
  .c5 { background: #fff; color: #0a0a0a; padding: 30px 28px 20px; border-top: 6px solid #002fa7; }
  .c5-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; border-bottom: 2px solid #0a0a0a; padding-bottom: 14px; }
  .c5-top h2 { font-size: 58px; font-weight: 800; letter-spacing: -.03em; line-height: .9; color: #002fa7; }
  .c5-top h2 span { display: block; font-size: 20px; letter-spacing: .18em; color: #0a0a0a; margin-top: 6px; font-weight: 700; }
  .c5-meta { text-align: right; }
  .c5-meta b { font-size: 15px; font-weight: 700; }
  .c5-meta p { font-size: 10px; letter-spacing: .1em; color: #777; margin-top: 4px; text-transform: uppercase; }
  .c5-t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .c5-t th { font-size: 9px; letter-spacing: .22em; color: #002fa7; padding: 10px 4px 6px; border-bottom: 1px solid #eee; text-align: right; }
  .c5-t th.l { text-align: left; }
  .c5-t td { padding: 7px 4px; border-bottom: 1px solid #f0f0f0; text-align: right; }
  .c5-t td.l { text-align: left; }
  .c5-fm { font-size: 14px; font-weight: 700; white-space: nowrap; }
  .c5-fm em { font-style: normal; color: #002fa7; padding: 0 1px; }
  .c5-j { color: #555; }
  .c5-foot { margin-top: 14px; font-size: 9px; letter-spacing: .28em; color: #999; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="tag">① 复古赛马报纸 Form Guide 风<small>调研依据：Curio《Racing Form Guide》——粉纸、玛瑙小字、细栏线、彩衣是全页唯一彩色</small></div>
  ${card1}
  <div class="tag">② Racing Post 英式现代报头风<small>调研依据：Racing Post 版面解剖——红色报头条、加粗数字、上划线列头</small></div>
  ${card2}
  <div class="tag">③ 暗色体育 App 风<small>调研依据：FotMob/ESPN 类暗色直播卡——荧光强调色、圆角徽章、行内主从信息</small></div>
  ${card3}
  <div class="tag">④ 日式赛马新聞印刷风<small>调研依据：JRA 新聞——枠番官方色块、竖排见出し、米色印刷纸</small></div>
  ${card4}
  <div class="tag">⑤ 瑞士国际主义极简海报风<small>调研依据：Matt Ström《Design better data tables》——少着墨、单一强调色、大字号层级</small></div>
  ${card5}
</div>
</body>
</html>`;

fs.writeFileSync(path.join(ROOT, "design/share-cards-demo.html"), html);
console.log("OK ->", path.join(ROOT, "design/share-cards-demo.html"), (html.length / 1024).toFixed(0) + "KB");
