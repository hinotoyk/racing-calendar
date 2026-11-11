// 出馬表分享卡（site/share.js）— canvas 多主题出图 + 分享视图（Excel 式批量编辑 / 手动添加比赛 / 导出 PNG）
// 设计 tokens 与主站 style.css 同源；渲染器设计稿见 design/share-card.html
// app.js 经 dynamic import 调用 show(races)；批量编辑表格见 share-grid.js（就地编辑即时同步本模块数据）

import { createGrid, shortRaceName } from "./share-grid.js";

const SHARE_URL = "https://hinotoyk.github.io/racing-calendar";
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

// 分享卡可追加的列（主表已采集字段；顺序即勾选后的列序）
const EXTRA_COLS = [
  { k:'weight',  label:'负重' },
  { k:'trainer', label:'练马师' },
  { k:'sire',    label:'父' },
  { k:'sireSire',label:'祖父' },
  { k:'bms',     label:'母父' },
  { k:'dam',     label:'母' },
  { k:'owner',   label:'马主' },
  { k:'breeder', label:'生产牧场' },
];

/* ================= 版式（定稿 2026-10-29：单一青绿样式） =================
 * A2 大字字号 + 枠番合一列；比赛块 = table 型网格（外框 + 竖向列分隔 + 表头底色）。
 * tokens 机制保留（fs / ROW_H / COLH / GAP 可整体调节），候选样式已全部下线。 */
const SANS = '"Geist","Noto Sans SC","Microsoft YaHei","PingFang SC",sans-serif';

const THEMES = {
  classic: {
    label: '青绿卡片',
    font: SANS, masthead: 'strip', waku: 'chip', zebra: true, wakuNum: true,
    HEAD_H: 74, MAST_H: 102, COLH: 30, ROW_H: 41,
    fs: { head: 11, horse: 18, body: 15, extra: 14.5, num: 17 },
    G: { headBg: '#f3f5f7', headLine: '#d3d9df', headLineW: 1, v: '#edeff2', outer: '#c7ced5', outerW: 1 },
    T: {
      backdrop: '#eef0f2', paper: '#ffffff',
      bar: '#0aa7a0', teal: '#0aa7a0', tealInk: '#0b6b64',
      ink: '#131418', sub: '#40424a', mut2: '#787b84', mut: '#a1a1aa',
      line: '#e9e9ec', row: '#f0f2f4', zebra: '#f6f8fa',
      g1: '#d5302a', g2: '#0a3b7e', g3: '#087220', listed: '#dca026', nar: '#c2318e',
    },
  },
};

// 枠色（JRA 公式 1白2黒3赤4青5黄6緑7橙8桃）

// 枠色（JRA 公式 1白2黒3赤4青5黄6緑7橙8桃）
const WAKU = [null,
  { bg:'#ffffff', bd:'#c9ccd1', fg:'#0a0a0a' },
  { bg:'#26262a', fg:'#ffffff' },
  { bg:'#d0342c', fg:'#ffffff' },
  { bg:'#2b62b0', fg:'#ffffff' },
  { bg:'#f2c500', fg:'#4a3b00' },
  { bg:'#1e7d46', fg:'#ffffff' },
  { bg:'#e8791e', fg:'#ffffff' },
  { bg:'#ef8bab', fg:'#8c2748' },
];
const GRADE = {
  G1:['GⅠ','g1'], G2:['GⅡ','g2'], G3:['GⅢ','g3'],
  Jpn1:['JpnⅠ','g1'], Jpn2:['JpnⅡ','g2'], Jpn3:['JpnⅢ','g3'],
  JG1:['JGⅠ','g1'], JG2:['JGⅡ','g2'], JG3:['JGⅢ','g3'],
  L:['L','listed'], OP:['OP','teal'], 地方重赏:['地方重賞','nar'],
};

/* ================= 布局常量 ================= */
const W = 880, M = 24, PAD = 32;
const COLH = 27, ROW_H = 36, FOOT_H = 84, GAP = 26;   // FOOT_H 含右下角二维码（58px）所需高度

const esc = (s) => String(s ?? "");
const wdOf = (d) => WEEKDAY[new Date(d + 'T00:00:00Z').getUTCDay()] ?? '';
const subStr = (r) => [r.surface ?? '', r.distance ? `${r.distance}m` : ''].filter(Boolean).join('');
// セン → セ：性齢列由 2 字降到 1 字，不再出现「セ…」截断；同时命中 SEX_C 的「セ」配色键
const normSex = (s) => (s === 'セン' ? 'セ' : (s ?? ''));
const sexAge = (r) => `${normSex(r.sex)}${r.age ?? ''}`;

function bjOf(race) {
  if (!race.startTimeInstant) return null;
  const d = new Date(race.startTimeInstant);
  return isNaN(+d) ? null : new Date(+d + 8 * 3600e3);
}
const p2 = (n) => String(n).padStart(2, '0');
// 「10-22 15:40」文案（跨日自动带日期；无开走时间返回空）— 统一 MM-DD HH:mm 短格式
function bjText(race) {
  const d = bjOf(race);
  if (!d) return '';
  return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
// 「10-22 15:50」当地文案（不带时区标）
function localText(race) {
  if (!race.date || !race.startTime) return '';
  return `${p2(+race.date.slice(5, 7))}-${p2(+race.date.slice(8, 10))} ${race.startTime}`;
}

/* ================= canvas 渲染 ================= */
const canvas = document.getElementById('share-canvas');
const ctx = canvas.getContext('2d');

const font = (w, s) => `${w} ${s}px ${CUR.font}`;
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fit(s, maxW) {
  s = esc(s);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
const tw = (s) => ctx.measureText(esc(s)).width;

let CUR = THEMES.classic, TT = THEMES.classic.T;   // 当前主题 / tokens（draw 前设置）

/* ---- 共用图元：画布开幅 + 报头 + 页脚（分卡 / 紧凑表两种版式同用） ---- */
let CURW = W;   // 当前画布内容宽（紧凑表用更宽画布；报头顶条随宽）
function paperBegin(scale, H, cw = W) {
  CURW = cw;
  canvas.width = Math.round((cw + M * 2) * scale);
  canvas.height = Math.round(H * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = TT.backdrop; ctx.fillRect(0, 0, cw + M * 2, H);
  ctx.save();
  ctx.shadowColor = TT.shadow ?? 'rgba(10,10,10,.13)'; ctx.shadowBlur = 34; ctx.shadowOffsetY = 10;
  ctx.fillStyle = TT.paper;
  rr(M, M, cw, H - M * 2, 16); ctx.fill();
  ctx.restore();
  ctx.save();
  rr(M, M, cw, H - M * 2, 16);
  ctx.clip();
  return [M, M + cw];
}
function masthead(L, R, heads) {
  const top = M;
  ctx.fillStyle = TT.bar; ctx.fillRect(L, M, CURW, 6);
  ctx.fillStyle = TT.teal; ctx.fillRect(L + PAD, top + 24, 4, 62);
  ctx.font = font(700, 10.5); ctx.letterSpacing = '3px';
  ctx.fillStyle = TT.tealInk; ctx.textAlign = 'left';
  ctx.fillText('RACE CARD', L + PAD + 14, top + 38);
  ctx.letterSpacing = '0px';
  ctx.font = font(700, 25); ctx.fillStyle = TT.ink;
  ctx.fillText('出走表', L + PAD + 14, top + 67);
  ctx.font = font(400, 11.5); ctx.fillStyle = TT.mut2;
  ctx.fillText(`共 ${heads} 頭出走 ${races.length} 场`, L + PAD + 14, top + 87);
  ctx.textAlign = 'left';
}
function footer(L, R, tableBot) {
  const fy = tableBot + 10;
  ctx.strokeStyle = TT.line;
  ctx.beginPath(); ctx.moveTo(PAD, fy + .5); ctx.lineTo(R - PAD, fy + .5); ctx.stroke();
  ctx.fillStyle = TT.teal; ctx.fillRect(PAD, fy + 13, 4, 30);
  ctx.font = font(800, 13.5); ctx.fillStyle = TT.ink; ctx.textAlign = 'left';
  ctx.fillText('RACING CALENDAR', PAD + 13, fy + 26);
  ctx.font = font(400, 10.5); ctx.fillStyle = TT.mut;
  ctx.fillText('数据仅供个人学习、研究 · 赛马应援 · 非商业用途 · v1.4.0', PAD + 13, fy + 44);
  // 右下角二维码（替代纯文本链接）：细边框 + 左侧两行引导文案
  const qs = 58, qx = R - PAD - qs, qy = fy + 8;
  drawQR(qx, qy, qs);
  ctx.strokeStyle = TT.line; ctx.lineWidth = 1;
  ctx.strokeRect(qx + .5, qy + .5, qs - 1, qs - 1);
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.font = font(600, 12); ctx.fillStyle = TT.tealInk;
  ctx.fillText('扫码查看出走表', qx - 10, fy + 30);
  ctx.font = font(400, 10); ctx.fillStyle = TT.mut2;
  ctx.fillText(SHARE_URL.replace(/^https:\/\//, ''), qx - 10, fy + 47);
  ctx.font = font(400, 10.5); ctx.fillStyle = TT.mut2; ctx.textAlign = 'center';
  ctx.fillText('power by ディープ求索', R / 2, fy + 38);
  ctx.textAlign = 'left';
}

function chipBox(x, y, text, size, weight, fg, bg, padX, h, r) {
  ctx.font = font(weight, size);
  const w = tw(text) + padX * 2;
  ctx.fillStyle = bg; rr(x, y, w, h, r); ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + .5);
  return w;
}
function gradeChip(x, y, level) {   // 级别徽章：实色圆角芯片
  const g = GRADE[level];
  if (!g) return 0;
  const text = g[0], col = TT[g[1]];
  return chipBox(x, y, text, 11, 700, '#fff', col, 6.5, 19, 4.5) + 4;
}

function drawQR(x, y, size) {
  try {
    if (typeof window.qrcode !== 'function') return;
    const qr = window.qrcode(0, 'M');
    qr.addData(SHARE_URL);
    qr.make();
    const n = qr.getModuleCount();
    const cell = size / (n + 2);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#0a0a0a';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + (c + 1) * cell, y + (r + 1) * cell, cell + .35, cell + .35);
    }
  } catch { /* QR 失败不阻断出图 */ }
}

function draw(scale, races) {
  const cc = colCfg[layout];   // 当前版式的列序 + 显隐（紧凑一览 / 逐场分卡各自独立）
  if (layout === 'dense') drawDense(scale, races, cc);
  else drawCards(scale, races, cc);
}

/* ================= 版式 A · 分卡（每场一块；块头 2026-11-07 改单行头） ================= */
function drawCards(scale, races, cc) {
  const MAST_H = CUR.MAST_H;
  /* 块头高度：两行左对齐块（行1 名字 / 行2 meta），仍比原两行头（74）省 16px/场 */
  const HEAD_H = 58;
  /* 块头几何（drawing 与 H 累加共用，改一处必须同步）：
     by+3..by+39  青绿竖条；by+19 行1基线；by+37 行2基线；by+45 hairline；by+58 表格顶 */
  const HD_BAR_Y = 3, HD_BAR_H = 36, HD_BASE1 = 19, HD_BASE2 = 37, HD_LINE = 45;
  const ROW_H = CUR.ROW_H ?? 36, COLH = CUR.COLH ?? 27;   // 行高/表头高随主题（紧凑/舒展版式用）
  const GAP = CUR.GAP ?? 26;   // 块间距随主题（开放表用更大留白）
  const fs = CUR.fs ?? { head: 10, horse: 16, body: 13.5, extra: 13, num: 15.5 };
  let H = M + MAST_H + 8;
  for (const r of races) {
    H += HEAD_H + COLH + r.runners.length * ROW_H + GAP;
  }
  H += FOOT_H + M - GAP + 8;

  // ---- 背景 + 卡片 ----
  const [L, R] = paperBegin(scale, H);

  // ---- 列布局（每场独立；与 v1 相同的 demand/收缩/均摊算法）----
  const demandW = (race, k, weight, size, min, max) => {
    ctx.font = font(weight, size);
    let w = 0;
    for (const h of race.runners) w = Math.max(w, tw(h[k] ?? '–'));
    return Math.min(max, Math.max(min, w + 24));
  };
  const layoutCols = (race) => {
    const hasWaku = race.runners.some((h) => Number(h.frame) >= 1 && Number(h.frame) <= 8);
    // 彩衣列：该场有已加载的彩衣图才出现（73x55 源图缩至 21x16 居中）
    const hasSilk = race.runners.some((h) => h.silk && silkImgs.get(h.silk));
    const cols = [];
    // 按 col-config 定稿顺序逐列构建（马号/彩衣为条件列：枠番合一 / 该场有图才上卡）
    for (const key of cc.order) {
      if (cc.hidden.includes(key)) continue;
      if (key === 'num' || key === 'wknum') {
        // 枠番合一（2026-11-07 与紧凑一览统一）：有枠番 → 单色块（色=枠番、字=馬番）；
        // 无枠番（海外等）→ 素数字。两种 key 视为同一「马号」列，按场内数据自动二选一。
        if (cols.some((c) => c.k === 'wknum' || c.k === 'num')) continue;
        cols.push(hasWaku ? { k:'wknum', label:'马号', w:46, align:'c' } : { k:'num', label:'马号', w:46, align:'c' });
        continue;
      }
      if (key === 'silk') {
        if (hasSilk) cols.push({ k:'silk', label:'彩衣', w:32, align:'c' });
        continue;
      }
      if (key === 'horse') {
        cols.push({ k:'horse', label:'马名', demand:demandW(race, 'horseName', 600, fs.horse, 120, 340), min:120, align:'l' });
        continue;
      }
      if (key === 'sexage') {
        cols.push({ k:'sexage', label:'性龄', w:58, align:'c', size:fs.body, c:TT.sub });
        continue;
      }
      if (key === 'jockey') {
        cols.push({ k:'jockey', label:'骑手', demand:demandW(race, 'jockey', 400, fs.body, 72, 180), min:72, align:'l', size:fs.body, c:TT.sub });
        continue;
      }
      const e = EXTRA_COLS.find((c) => c.k === key);
      if (e) cols.push({ k:key, label:e.label, w: key === 'weight' ? 50 : demandW(race, key, 400, fs.extra, 60, 158), min:60,
                        align: key === 'weight' ? 'c' : 'l', size:fs.extra, c:TT.mut2 });
    }
    for (const c of cols) c.w = c.demand ?? c.w;
    const content = W - PAD * 2;
    const sum = cols.reduce((n, c) => n + c.w, 0);   // 列间无缝：竖线分隔（table 型网格）
    if (sum < content) {
      const share = (content - sum) / cols.length;
      for (const c of cols) c.w += share;
    } else if (sum > content) {
      const pool = cols.reduce((n, c) => n + Math.max(0, c.w - (c.min ?? c.w)), 0);
      const k = pool > 0 ? Math.min(1, (sum - content) / pool) : 0;
      for (const c of cols) c.w -= Math.max(0, c.w - (c.min ?? c.w)) * k;
    }
    let cx = PAD;
    for (const c of cols) { c.x = cx; cx += c.w; }
    return cols;
  };

  // ---- Masthead ----
  masthead(L, R, races.reduce((n, r) => n + r.runners.length, 0));

  // ---- 比赛块 ----
  let y = M + MAST_H + 8;
  for (const race of races) {
    const by = y;
    /* ---- 块头（2026-11-07 定稿 D「两行左对齐块 · 比赛名在前」）----
       ▎ サラ系３歳上１勝クラス [GⅡ]  [10-22 京都12R]
         芝2000m · 当地 16:25 · 北京 15:25
       演进：右对齐簇（信息散两头）→ 两行左对齐（日期+场次带头）→ 现在把**比赛名提到最前**，
       日期+场次作为跟在名后的标签。块内所有元素共用一条左边界（DATE_X），行2 与行1 首字齐左，
       标签宽度随内容收紧 —— 不留任何直角空白块。 */
    const bjStr = clockOpt.bj ? bjText(race) : '';
    const localStr = clockOpt.local ? localText(race) : '';
    const vn = `${race.venue ?? ''}${race.raceNo ?? ''}R`;
    const hasBadge = !!(race.level && GRADE[race.level]);

    ctx.fillStyle = TT.teal;
    ctx.fillRect(PAD, by + HD_BAR_Y, 4, HD_BAR_H);
    const DATE_X = PAD + 14;   // 块内统一左边界（竖条右 14px）

    /* 行1：只有比赛名 + 级别徽章（日期/场次/赛道/时刻全部下到行2 的赛事标签行）
       2026-11-07 用户定稿：行2 读作「福島6R 芝2600 · 北京 11-07 11:35」——
       场次紧挨赛道（JBIS 习惯的「場R + 芝ダ距離」写法）、距离不带 m、北京时刻带日期。 */
    ctx.font = font(700, 11);
    const badgeW = hasBadge ? tw(GRADE[race.level][0]) + 13 + 4 : 0;
    ctx.font = font(700, 17);
    const nameMax = Math.max(110, R - PAD - (hasBadge ? badgeW + 8 : 0) - DATE_X);
    const tText = fit(shortRaceName(race.raceName), nameMax);
    ctx.textAlign = 'left'; ctx.fillStyle = TT.ink;
    ctx.fillText(tText, DATE_X, by + HD_BASE1);
    if (hasBadge) gradeChip(DATE_X + tw(tText) + 10, by + HD_BASE1 - 15, race.level);

    // 行2：场次 13/600 墨灰 → 赛道 12/400 灰（不带 m）→ 时刻 12.5/700 tealInk（带日期）
    const parts = [];
    parts.push({ t: vn, c: TT.sub, w: 600, s: 13 });
    const subT = subStr(race).replace(/m$/, '');
    if (subT) parts.push({ t: subT, c: TT.mut2, w: 400, s: 12 });
    if (clockOpt.bj && localStr) parts.push({ t: `当地时间 ${localStr}`, c: TT.mut2, w: 400, s: 12 });
    if (clockOpt.bj && bjStr) parts.push({ t: `北京 ${bjStr}`, c: TT.tealInk, w: 700, s: 12.5 });
    else if (localStr) parts.push({ t: `当地时间 ${localStr}`, c: TT.tealInk, w: 700, s: 12.5 });
    let mx = DATE_X;
    parts.forEach((pt, i) => {
      if (i) {
        ctx.font = font(400, 12); ctx.fillStyle = TT.mut; ctx.textAlign = 'left';
        ctx.fillText('·', mx, by + HD_BASE2); mx += tw('·') + 8;
      }
      ctx.font = font(pt.w, pt.s); ctx.fillStyle = pt.c; ctx.textAlign = 'left';
      ctx.fillText(pt.t, mx, by + HD_BASE2); mx += tw(pt.t) + 8;
    });
    ctx.textAlign = 'left';

    // 头底 hairline：把「卡头 / 表格」分成两层（旧版没有这条线，头部像浮在表格上方）
    ctx.strokeStyle = TT.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, by + HD_LINE + .5); ctx.lineTo(R - PAD, by + HD_LINE + .5); ctx.stroke();

    /* ---- table 型网格：外框 + 竖向列分隔 + 表头底色 ---- */
    const cols = layoutCols(race);
    y += HEAD_H;
    const tTop = y, tW = R - PAD - PAD;
    const G = CUR.G;
    const tBot = tTop + COLH + race.runners.length * ROW_H;

    // 斑马纹（先铺底，避免盖线）
    if (CUR.zebra) {
      ctx.fillStyle = TT.zebra;
      for (let i = 1; i < race.runners.length; i += 2) ctx.fillRect(PAD, tTop + COLH + i * ROW_H, tW, ROW_H);
    }
    // 竖向列分隔线
    ctx.strokeStyle = G.v; ctx.lineWidth = 1;
    for (let k = 1; k < cols.length; k++) {
      const vx = Math.round(cols[k].x) + .5;
      ctx.beginPath(); ctx.moveTo(vx, tTop); ctx.lineTo(vx, tBot); ctx.stroke();
    }
    // 行分隔线
    ctx.strokeStyle = TT.row;
    for (let i = 1; i < race.runners.length; i++) {
      const ry = tTop + COLH + i * ROW_H + .5;
      ctx.beginPath(); ctx.moveTo(PAD, ry); ctx.lineTo(R - PAD, ry); ctx.stroke();
    }
    // 表头
    ctx.fillStyle = G.headBg; ctx.fillRect(PAD, tTop, tW, COLH);
    ctx.font = font(600, fs.head);
    ctx.fillStyle = TT.mut2; ctx.textBaseline = 'middle';
    for (const c of cols) {
      ctx.textAlign = c.align === 'l' ? 'left' : 'center';
      ctx.fillText(c.label, c.align === 'l' ? c.x + 9 : c.x + c.w / 2, tTop + COLH / 2 + .5);
    }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    // 表头底线
    ctx.strokeStyle = G.headLine; ctx.lineWidth = G.headLineW;
    ctx.beginPath(); ctx.moveTo(PAD, tTop + COLH + .5); ctx.lineTo(R - PAD, tTop + COLH + .5); ctx.stroke();
    // 外框
    ctx.strokeStyle = G.outer; ctx.lineWidth = G.outerW;
    ctx.strokeRect(PAD + .5, tTop + .5, tW - 1, tBot - tTop - 1);
    ctx.lineWidth = 1;

    // 单元格内容（左右各留 9px 内边距；字号随主题 fs）
    race.runners.forEach((h, i) => {
      const ry = tTop + COLH + i * ROW_H;
      const mid = ry + ROW_H / 2 + 1;
      for (const c of cols) {
        if (c.k === 'wknum') {   // 马号列：整格底色 = 枠番色（2026-11-07 改，旧版是 26×20 小方块）
          const fr = Number(h.frame);
          const wk = (fr >= 1 && fr <= 8) ? WAKU[fr] : { bg: '#eceff2', fg: '#8a949e', bd: '#dfe3e7' };
          /* 铺满整格 —— 底色会盖住网格线，填完把四边重画一遍，表格结构才不散 */
          ctx.fillStyle = wk.bg;
          ctx.fillRect(c.x, ry, c.w, ROW_H);
          if (wk.bd) {
            ctx.strokeStyle = wk.bd; ctx.lineWidth = 1;
            ctx.strokeRect(c.x + .5, ry + .5, c.w - 1, ROW_H - 1);
          }
          ctx.strokeStyle = G.v; ctx.lineWidth = 1;
          const vxR = Math.round(c.x + c.w) + .5;
          ctx.beginPath(); ctx.moveTo(vxR, ry); ctx.lineTo(vxR, ry + ROW_H); ctx.stroke();
          if (Math.abs(c.x - PAD) < 1) {
            ctx.strokeStyle = G.outer; ctx.lineWidth = G.outerW;
            ctx.beginPath(); ctx.moveTo(PAD + .5, ry); ctx.lineTo(PAD + .5, ry + ROW_H); ctx.stroke();
            ctx.lineWidth = 1;
          }
          if (i < race.runners.length - 1) {
            ctx.strokeStyle = TT.row;
            ctx.beginPath(); ctx.moveTo(c.x, ry + ROW_H + .5); ctx.lineTo(c.x + c.w, ry + ROW_H + .5); ctx.stroke();
          }
          ctx.font = font(700, fs.num); ctx.fillStyle = wk.fg;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(h.num ?? '–'), c.x + c.w / 2, ry + ROW_H / 2 + 1);
          ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
          continue;
        }
        if (c.k === 'num') {
          ctx.font = font(700, fs.num); ctx.fillStyle = TT.ink;
          ctx.textAlign = 'center'; ctx.fillText(String(h.num ?? '–'), c.x + c.w / 2, mid + fs.num * 0.34); ctx.textAlign = 'left';
          continue;
        }
        if (c.k === 'silk') {
          const img = silkImgs.get(h.silk);
          if (img) {
            const iw = 21, ih = 16;
            ctx.drawImage(img, c.x + (c.w - iw) / 2, ry + (ROW_H - ih) / 2, iw, ih);
          }
          continue;
        }
        if (c.k === 'horse') {
          ctx.font = font(600, fs.horse); ctx.fillStyle = TT.ink;
          ctx.fillText(fit(h.horseName ?? '', c.w - 18), c.x + 9, mid + fs.horse * 0.34);
          continue;
        }
        if (c.k === 'sexage') {   // 性別配色（与紧凑一览一致：牡青 / 牝粉 / セ青绿）
          const sex = normSex(h.sex), age = h.age != null ? String(h.age) : '';
          ctx.font = font(600, fs.body);
          const wS = tw(sex), wA = age ? tw(age) : 0;
          const x0 = c.x + (c.w - wS - wA) / 2, ty = mid + fs.body * 0.35;
          ctx.textAlign = 'left';
          if (sex) { ctx.fillStyle = SEX_C[sex] ?? TT.sub; ctx.fillText(sex, x0, ty); }
          if (age) { ctx.fillStyle = TT.mut2; ctx.fillText(age, x0 + wS, ty); }
          continue;
        }
        const v = c.k === 'sexage' ? sexAge(h) : h[c.k];
        ctx.font = font(400, c.size ?? fs.body);
        ctx.fillStyle = c.c ?? TT.sub;
        const s = v == null || v === '' ? '–' : String(v);
        ctx.textAlign = c.align === 'l' ? 'left' : 'center';
        ctx.fillText(c.align === 'l' ? fit(s, c.w - 18) : s, c.align === 'l' ? c.x + 9 : c.x + c.w / 2, mid + (c.size ?? fs.body) * 0.35);
        ctx.textAlign = 'left';
      }
    });
    y = tBot + GAP;
  }

  // ---- Footer ----
  footer(L, R, y - GAP);
  ctx.restore();
}

/* ================= 版式 B · 紧凑表（平面大表：比赛级信息合并单元格 + 连续行） =================
 * 参考「吉兆相关出赛表」式平面排版：日期/北京时间/场地/场次/比赛名/赛道作为
 * 纵向合并列融入一张连续表，行高 24px；枠色片 · 性别配色 · 赛道配色做视觉锚点。
 * 比赛级信息不再每场重复块头 —— 这是相对分卡版式的最大密度来源（每场省 ~100px）。 */
const SEX_C = { 牡:'#2b62b0', 牝:'#c2318e', セ:'#0aa7a0' };
const SURF_C = { 芝:'#0b6b64', ダ:'#9a5b1f', 障:'#1e7d46' };

function bjTime(race) {
  const d = bjOf(race);
  return d ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : '–';
}

function drawDense(scale, races, cc) {
  const fsD = { head: 10.5, body: 11.5, horse: 12.5, num: 12 };
  const fsR = { time: 12.5, no: 12.5, rname: 13, dist: 12.5 };   // 比赛级合并列放大后的字号
  const ROW_H = 24, COLH = 24, MAST_H = CUR.MAST_H;

  // ---- 行区间：每场一组连续出走馬行（比赛级信息 = 合并列）----
  const spans = [];
  let ri = 0;
  for (const race of races) {
    const n = Math.max(1, race.runners.length);
    spans.push({ race, start: ri, end: ri + n, runners: n });
    ri += n;
  }
  const rows = ri;
  const heads = races.reduce((n, r) => n + r.runners.length, 0);
  const H = M + MAST_H + 8 + COLH + rows * ROW_H + FOOT_H + M + 8;

  // ---- 列布局：比赛级合并列（时间/场次/比赛名/赛道）+ 逐马列，按 col-config 定稿顺序混排
  //      （2026-11-01 反馈：时间/场次/赛道按内容实测定宽，关键列不再被压缩成「京都1…」；
  //       收缩按优先级分档：追加列 → 騎手 → 比赛名 → 馬名/关键合并列）----
  const timeCol = clockOpt.bj ? 'bj' : 'local';
  // 时间列：按最长时间文案实测（单行「11-01 14:20」或双行模式的两行各自实测）
  ctx.font = font(600, fsR.time);
  let timeNeed = 0;
  for (const r of races) timeNeed = Math.max(timeNeed, tw(bjText(r) || '–'), tw(localText(r) || '–'));
  if (clockOpt.local && clockOpt.bj) {
    ctx.font = font(400, 10);
    for (const r of races) timeNeed = Math.max(timeNeed, r.startTime ? tw(`当地时间 ${r.startTime}`) : 0);
  }
  // 场次列：按最长「競馬場+R」实测（此前固定 48 会把「京都11R」截成「京都1…」）
  ctx.font = font(600, fsR.no);
  let noNeed = 0;
  for (const r of races) noNeed = Math.max(noNeed, tw(`${r.venue ?? ''}${r.raceNo ? r.raceNo + 'R' : ''}` || '–'));
  // 赛道列：按最长「芝/ダ+距离」实测定宽（三列关键合并列 min = w：收缩时保住需求宽）
  ctx.font = font(600, fsR.dist);
  let distNeed = 0;
  for (const r of races) {
    const t = r.distance ? `${r.surface ?? ''}${r.distance}` : (r.surface || '');
    distNeed = Math.max(distNeed, tw(t));
  }
  // 彩衣列：与分卡版式同规则——该场有已加载的图才出现（24px 行高内缩至 18×14）
  const hasSilkD = races.some((r) => (r.runners ?? []).some((h) => h.silk && silkImgs.get(h.silk)));

  // 按 col-config 定稿顺序逐列构建（比赛级列 merge:'race' 整场合并；隐藏列不上卡）
  const cols = [];
  for (const key of cc.order) {
    if (cc.hidden.includes(key)) continue;
    if (key === 'time') {
      cols.push({ k: timeCol, label: clockOpt.bj ? '北京时间' : '当地时间', w: Math.max(78, timeNeed + 16), align: 'c', merge: 'race', prio: 3 });
      continue;
    }
    if (key === 'no')   { cols.push({ k:'no', label:'场次', w: Math.min(120, Math.max(48, noNeed + 14)), align:'c', merge:'race', prio: 3 }); continue; }
    if (key === 'rname'){ cols.push({ k:'rname', label:'比赛', min:96, align:'l', merge:'race', prio: 2 }); continue; }
    if (key === 'dist') { cols.push({ k:'dist', label:'赛道', w:54, align:'c', merge:'race', prio: 2 }); continue; }
    if (key === 'wknum'){ cols.push({ k:'wknum', label:'马号', w:46, align:'c' }); continue; }
    if (key === 'silk') { if (hasSilkD) cols.push({ k:'silk', label:'彩衣', w:26, align:'c', prio: 3 }); continue; }
    if (key === 'horse'){ cols.push({ k:'horse', label:'马名', min:108, align:'l', prio: 3 }); continue; }
    if (key === 'sexage'){ cols.push({ k:'sexage', label:'性龄', w:42, align:'c' }); continue; }
    if (key === 'jockey'){ cols.push({ k:'jockey', label:'骑手', min:64, align:'l', prio: 1 }); continue; }
    const e = EXTRA_COLS.find((c) => c.k === key);
    if (e) cols.push({ k:key, label:e.label, w: key === 'weight' ? 46 : 78, min: key === 'weight' ? 46 : 72,
                       align: key === 'weight' ? 'c' : 'l', c:TT.mut2, prio: 0 });   // 追加列最先收缩
  }
  {
    const dist = cols.find((c) => c.k === 'dist');
    if (dist) { dist.w = Math.max(54, distNeed + 14); dist.min = dist.w; }
    for (const c of cols) if (c.k === 'no' || c.k === timeCol) c.min = c.w;
  }
  const exVis = cc.order.filter((k) => EXTRA_COLS.some((e) => e.k === k) && !cc.hidden.includes(k));
  for (const c of cols) {
    if (c.k === 'rname') {   // 比赛名需求宽含级别徽章位（字号与绘制一致）
      ctx.font = font(600, fsR.rname);
      let w = 0;
      for (const s of spans)
        w = Math.max(w, tw(shortRaceName(s.race.raceName)) + (s.race.level && GRADE[s.race.level] ? 40 : 0));
      c.demand = Math.max(c.min, w + 20);   // 不设上限：海外长比赛名完整显示，画布随之动态开幅
      continue;
    }
    if (!['horse', 'jockey'].includes(c.k) && !(exVis.includes(c.k) && c.k !== 'weight')) continue;
    ctx.font = font(c.k === 'horse' ? 600 : 400, c.k === 'horse' ? fsD.horse : fsD.body);
    let w = 0;
    for (const s of spans) for (const h of s.race.runners)
      w = Math.max(w, tw(c.k === 'horse' ? (h.horseName ?? '') : (h[c.k] ?? '–')));
    c.demand = Math.min(c.k === 'horse' ? 360 : c.k === 'jockey' ? 110 : 150, Math.max(c.min, w + 22));
  }
  // 列宽先按内容需求定稿，再据此动态开幅：长马名（ゴールデンルーキー(USA) 等）不再被 fit() 截断。
  // 旧实现固定 1080 画布，列宽总和超限时整体等比压缩 → horse 列被压回 136px 出现省略号。
  for (const c of cols) if (c.demand != null) c.w = c.demand;
  const needW = cols.reduce((n, c) => n + c.w, 0) + PAD * 2;
  const cw = Math.max(1080, Math.min(2400, Math.ceil(needW)));
  const [L, R] = paperBegin(scale, H, cw);
  masthead(L, R, heads);
  const content = CURW - PAD * 2;
  const wsum = () => cols.reduce((n, c) => n + c.w, 0);
  let sum = wsum();
  if (sum > content) {   // 超宽 → 按优先级分档收缩（0 追加列 → 1 騎手 → 2 比赛名/赛道 → 3 馬名/关键合并列），保关键信息
    let over = sum - content;
    for (const p of [0, 1, 2, 3]) {
      if (over <= 0) break;
      const tier = cols.filter((c) => c.prio === p);
      const pool = tier.reduce((n, c) => n + Math.max(0, c.w - (c.min ?? c.w)), 0);
      if (pool <= 0) continue;
      const k = Math.min(1, over / pool);
      for (const c of tier) { const d = Math.max(0, c.w - (c.min ?? c.w)) * k; c.w -= d; over -= d; }
    }
    if (over > 0) {
      const k2 = content / wsum();
      for (const c of cols) c.w *= k2;   // 全部压到下限仍超 → 整体等比（fit 截断兜底）
    }
  } else if (sum < content) {
    let extra = content - sum;   // 余量：馬名先吃到 +80，其余均分给騎手/追加列
    const horse = cols.find((c) => c.k === 'horse');
    if (horse) { const add = Math.min(80, extra); horse.w += add; extra -= add; }
    const rest = cols.filter((c) => c.demand != null && c.k !== 'horse');
    if (extra > 0 && rest.length) for (const c of rest) c.w += extra / rest.length;
    else if (extra > 0 && horse) horse.w += extra;
  }
  let cx = PAD;
  for (const c of cols) { c.x = cx; cx += c.w; }

  const tTop = M + MAST_H + 8, tW = R - PAD - PAD;
  const tBot = tTop + COLH + rows * ROW_H;
  const G = CUR.G;
  const rowTop = (i) => tTop + COLH + i * ROW_H;
  const rowY = (i) => rowTop(i) + ROW_H / 2 + .5;
  const midOf = (a, b) => tTop + COLH + a * ROW_H + (b - a) * ROW_H / 2 + .5;

  const xPerRow = (cols.find((c) => !c.merge) ?? cols[0]).x;   // 合并列内不穿行线/斑马

  // ---- 定稿 C「冷灰网格」线条系统（与 design/dense-cards-demo.html 的 .v-c 同 token）----
  // 竖线只保留结构边界（合并列区右缘 / 枠番列右缘 / 彩衣列右缘），不再每列都画；
  // 取消时间列右缘加重线与表格外框，层级完全靠「表头底色 + 细横线 + 极浅斑马」组织。
  const C_LINE = '#f0f2f4';        // 行分隔
  const C_VLINE = '#eef1f4';       // 竖向结构线
  const C_ZEBRA = '#fafbfc';       // 斑马
  const C_HEAD_LINE = '#d9dee3';   // 表头下线
  const C_RACE_LINE = '#cfd6dc';   // 比赛分隔
  const C_DAY_LINE = '#c3cad1';    // 换日分隔（更深）

  // 场次界线（全宽）· 换日界线（更深）
  spans.forEach((s, i) => {
    if (!s.start) return;
    ctx.strokeStyle = races[i - 1].date !== s.race.date ? C_DAY_LINE : C_RACE_LINE;
    ctx.lineWidth = 1;
    const ry = rowTop(s.start) + .5;
    ctx.beginPath(); ctx.moveTo(PAD, ry); ctx.lineTo(R - PAD, ry); ctx.stroke();
  });
  // 出走馬行：极浅斑马（全局偶数行，与定稿 C 的 nth-child(even) 同）+ 行分隔线
  // （只画逐马列区间：合并单元格内不穿行）
  ctx.fillStyle = C_ZEBRA;
  for (const s of spans)
    for (let i = 0; i < s.runners; i++) {
      if ((s.start + i) % 2 === 0) continue;
      ctx.fillRect(xPerRow, rowTop(s.start + i), R - PAD - xPerRow, ROW_H);
    }
  ctx.strokeStyle = C_LINE; ctx.lineWidth = 1;
  for (const s of spans) {
    for (let i = 1; i < s.runners; i++) {
      const ry = rowTop(s.start + i) + .5;
      ctx.beginPath(); ctx.moveTo(xPerRow, ry); ctx.lineTo(R - PAD, ry); ctx.stroke();
    }
  }
  // 竖向结构线：每个合并列的右缘 + 枠番 / 彩衣列右缘（其余列留白，不画竖线）
  ctx.strokeStyle = C_VLINE; ctx.lineWidth = 1;
  for (let k = 1; k < cols.length; k++) {
    const prev = cols[k - 1];
    if (!(prev.merge || prev.k === 'wknum' || prev.k === 'silk')) continue;
    const vx = Math.round(cols[k].x) + .5;
    ctx.beginPath(); ctx.moveTo(vx, tTop); ctx.lineTo(vx, tBot); ctx.stroke();
  }
  // 表头
  ctx.fillStyle = G.headBg; ctx.fillRect(PAD, tTop, tW, COLH);
  ctx.font = font(600, fsD.head); ctx.fillStyle = '#7c8792'; ctx.textBaseline = 'middle';
  for (const c of cols) {
    ctx.textAlign = c.align === 'l' ? 'left' : 'center';
    ctx.fillText(c.label, c.align === 'l' ? c.x + 9 : c.x + c.w / 2, tTop + COLH / 2 + .5);
  }
  ctx.strokeStyle = C_HEAD_LINE; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, tTop + COLH + .5); ctx.lineTo(R - PAD, tTop + COLH + .5); ctx.stroke();

  // ---- 单元格 ----
  const drawTimeCell = (c, s, mid) => {
    const race = s.race;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const main = c.k === 'bj' ? bjText(race) : localText(race);   // 「10-31 08:00」
    // 双时间两行：跨 ≥2 行的正常字号；单行场次（如只勾 1 頭）压缩字号收进 24px，不与相邻场重叠
    if (clockOpt.local && clockOpt.bj) {
      const two = s.runners >= 2;
      ctx.font = font(600, two ? fsR.time : 12); ctx.fillStyle = TT.tealInk;
      ctx.fillText(fit(main || '–', c.w - 8), c.x + c.w / 2, two ? mid - 7 : mid - 5.5);
      ctx.font = font(400, two ? 10.5 : 10); ctx.fillStyle = TT.mut2;
      ctx.fillText(race.startTime ? `当地时间 ${race.startTime}` : '', c.x + c.w / 2, two ? mid + 8 : mid + 6.5);
    } else {
      ctx.font = font(600, fsR.time); ctx.fillStyle = TT.tealInk;
      ctx.fillText(fit(main || '–', c.w - 8), c.x + c.w / 2, mid);
    }
  };
  const drawRaceCell = (c, race, mid) => {
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    if (c.k === 'no') {
      ctx.font = font(600, fsR.no); ctx.fillStyle = TT.ink;
      const t = `${race.venue ?? ''}${race.raceNo ? race.raceNo + 'R' : ''}`;
      ctx.fillText(fit(t || '–', c.w - 6), c.x + c.w / 2, mid);
    } else if (c.k === 'rname') {
      // 比赛名在前、级别徽章在后（与主站 levelBadge() 及分卡版式同口径），整组居中；字号放大
      const g = race.level && GRADE[race.level];
      const label = shortRaceName(race.raceName) || '–';
      ctx.font = font(700, 10);
      const badgeW = g ? tw(g[0]) + 10 + 6 : 0;   // chipBox 宽 = tw(text)+padX*2，再加 6px 前间隙
      ctx.font = font(600, fsR.rname);
      const tW = tw(label);
      const x = c.x + Math.max(4, (c.w - tW - badgeW) / 2);
      const avail = Math.max(10, c.x + c.w - 4 - x - badgeW);
      const txt = fit(label, avail);
      ctx.fillStyle = TT.ink; ctx.textAlign = 'left';
      ctx.fillText(txt, x, mid + .5);
      if (g) chipBox(x + tw(txt) + 6, mid - 7.5, g[0], 10, 700, '#fff', TT[g[1]], 5, 15, 4);
    } else if (c.k === 'dist') {
      const t = race.distance ? `${race.surface ?? ''}${race.distance}` : (race.surface || '–');
      ctx.font = font(600, fsR.dist); ctx.fillStyle = SURF_C[race.surface] ?? TT.sub;
      ctx.fillText(fit(t, c.w - 6), c.x + c.w / 2, mid);
    }
  };
  const drawRunCell = (c, h, mid, span) => {
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    if (c.k === 'wknum') {
      /* 马号列：整格底色 = 枠番色（2026-11-07 与分卡统一，旧版是 24×18 小方块）。
         紧凑表无外框，铺满后只需补回右缘结构线与行分隔线。 */
      const fr = Number(h.frame);
      const wk = (fr >= 1 && fr <= 8) ? WAKU[fr] : { bg: '#e9ecef', fg: '#8a949e', bd: '#dfe3e7' };
      const rTop = mid - ROW_H / 2 - .5;
      ctx.fillStyle = wk.bg;
      ctx.fillRect(c.x, rTop, c.w, ROW_H);
      if (wk.bd) {
        ctx.strokeStyle = wk.bd; ctx.lineWidth = 1;
        ctx.strokeRect(c.x + .5, rTop + .5, c.w - 1, ROW_H - 1);
      }
      ctx.strokeStyle = C_VLINE; ctx.lineWidth = 1;
      const vxR = Math.round(c.x + c.w) + .5;
      ctx.beginPath(); ctx.moveTo(vxR, rTop); ctx.lineTo(vxR, rTop + ROW_H); ctx.stroke();
      ctx.strokeStyle = C_LINE;
      ctx.beginPath(); ctx.moveTo(c.x, rTop + ROW_H + .5); ctx.lineTo(c.x + c.w, rTop + ROW_H + .5); ctx.stroke();
      ctx.font = font(700, fsD.num); ctx.fillStyle = wk.fg;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(h.num ?? '–'), c.x + c.w / 2, mid + .5);
      ctx.textAlign = 'left';
      return;
    }
    if (c.k === 'silk') {
      const img = silkImgs.get(h.silk);
      if (img) ctx.drawImage(img, c.x + (c.w - 18) / 2, mid - 7, 18, 14);
      return;
    }
    if (c.k === 'horse') {
      ctx.font = font(600, fsD.horse); ctx.fillStyle = TT.ink;
      ctx.fillText(fit(h.horseName ?? '', c.w - 16), c.x + 8, mid + .5);
      return;
    }
        if (c.k === 'sexage') {
          const sex = normSex(h.sex), age = h.age != null ? String(h.age) : '';
      ctx.font = font(600, fsD.body);
      const wS = tw(sex), wA = age ? tw(age) : 0;
      const x0 = c.x + (c.w - wS - wA) / 2;
      ctx.fillStyle = SEX_C[sex] ?? TT.sub;
      ctx.fillText(sex, x0, mid + .5);
      if (age) { ctx.fillStyle = TT.mut2; ctx.fillText(age, x0 + wS, mid + .5); }
      return;
    }
    const v = h[c.k];
    const s2 = v == null || v === '' ? '–' : String(v);
    ctx.font = font(400, fsD.body); ctx.fillStyle = c.c ?? TT.sub;
    ctx.textAlign = c.align === 'l' ? 'left' : 'center';
    ctx.fillText(c.align === 'l' ? fit(s2, c.w - 16) : s2, c.align === 'l' ? c.x + 8 : c.x + c.w / 2, mid + .5);
    ctx.textAlign = 'left';
  };
  // 单色块版式不再需要「最大馬号宽」居中计算：色块定宽居中，天然对齐
  for (const c of cols) {
    if (c.merge === 'race') {
      for (const s of spans) {
        if (c.k === timeCol) drawTimeCell(c, s, midOf(s.start, s.end));
        else drawRaceCell(c, s.race, midOf(s.start, s.end));
      }
      continue;
    }
    for (const s of spans) s.race.runners.forEach((h, i) => drawRunCell(c, h, rowY(s.start + i), s));
  }

  /* ---- 表格封边（2026-11-07 用户反馈：无外框时表格左右两端直接消失在白底里，很散）----
     只画最外一圈，颜色比分卡的外框略浅（紧凑表本身线条很淡，框太重会像 Excel 框线）。
     日期分组行在 tTop 之上，不纳入框内。 */
  ctx.strokeStyle = '#c7ced5'; ctx.lineWidth = 1;
  ctx.strokeRect(PAD + .5, tTop + .5, tW - 1, tBot - tTop - 1);

  // ---- Footer ----
  footer(L, R, tBot);
  ctx.restore();
}

/* ================= 分享视图状态 ================= */
const LS_SCALE = 'rc.share.scale';
const LS_LAYOUT = 'rc.share.layout.v1';
const LAYOUT_CHIPS = [
  { k: 'dense', label: '紧凑一览' },
  { k: 'cards', label: '逐场分卡' },
];
const ls = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
let layout = ls(LS_LAYOUT, 'dense');   // 默认紧凑表（信息密度优先；参考平面出賽表排版）

let races = [];
/* ---- 列顺序 + 默认显隐（两个版式独立；默认值 = design/col-config.html 定稿 JSON 2026-11-11 v2） ----
 * dense：time/no/rname/dist = 比赛级合并列，可与逐马列任意穿插；wknum/silk/horse… 为逐马列。
 * cards：num = 马号（有枠番时自动按枠番合一色块 wknum 渲染）。
 * 芯片开关（追加列）只改 hidden（当前版式），顺序保持定稿不变。
 * 存储键带版本号：调定稿顺序时换版本，避免旧持久化值盖住新默认。 */
const LS_COLCFG = 'rc.share.cardcols.v2';
const DEF_COLCFG = {
  dense: {
    order: ['time', 'no', 'rname', 'dist', 'wknum', 'silk', 'horse', 'sexage', 'weight', 'jockey',
            'trainer', 'sire', 'dam', 'sireSire', 'bms', 'owner', 'breeder'],
    hidden: ['sireSire', 'dam', 'owner', 'breeder', 'trainer'],
  },
  cards: {
    order: ['num', 'silk', 'horse', 'sexage', 'weight', 'jockey',
            'trainer', 'sire', 'dam', 'sireSire', 'bms', 'owner', 'breeder'],
    hidden: ['sireSire', 'dam', 'breeder', 'owner'],
  },
};
// 合法化：order 去重 + 只认合法 key + 缺失列补回默认位置（防旧版本/手改残留脏数据）
const validCfg = (v) => {
  const out = {};
  for (const lay of ['dense', 'cards']) {
    const all = DEF_COLCFG[lay].order;
    const got = [...new Set((v?.[lay]?.order ?? []).filter((k) => all.includes(k)))];
    out[lay] = {
      order: got.concat(all.filter((k) => !got.includes(k))),
      hidden: (v?.[lay]?.hidden ?? []).filter((k) => all.includes(k)),
    };
  }
  return out;
};
let colCfg = validCfg(ls(LS_COLCFG, DEF_COLCFG));
const LS_CLOCK = 'rc.share.clock.v1';
let clockOpt = ls(LS_CLOCK, { bj: true, local: false });   // 块头时间：默认北京时间，可选加当地时间
if (!clockOpt.bj && !clockOpt.local) clockOpt = { bj: true, local: false };
const urlClock = new URLSearchParams(location.search).get('clock');
if (urlClock === 'local') clockOpt = { bj: true, local: true };   // 自检深链
let wired = false;

const $s = (sel) => document.querySelector(sel);

const CLOCK_CHIPS = [
  { k: 'bj', label: '北京时间' },
  { k: 'local', label: '当地时间' },
];
function renderLayoutChips() {
  const mount = $s('#share-layout');
  if (!mount) return;
  mount.innerHTML = LAYOUT_CHIPS.map((c) =>
    `<button type="button" class="filter-chip${layout === c.k ? ' on' : ''}" data-layout="${c.k}">${c.label}</button>`
  ).join('');
}

function renderClockChips() {
  const mount = $s('#share-clock');
  if (!mount) return;
  mount.innerHTML = CLOCK_CHIPS.map((c) =>
    `<button type="button" class="filter-chip${clockOpt[c.k] ? ' on' : ''}" data-clock="${c.k}">${c.label}</button>`
  ).join('');
}

function drawCanvas() {
  CUR = THEMES.classic;
  TT = CUR.T;
  draw(+($s('#share-scale').value || 2), races);
}

/* ---- 彩衣图预加载（canvas drawImage 需先有 Image；同 src 缓存，失败记 null 不重试） ---- */
const silkImgs = new Map();   // src → Image|null
async function ensureSilks(rs) {
  const srcs = [...new Set(rs.flatMap((r) => (r.runners ?? []).map((h) => h.silk).filter(Boolean)))];
  await Promise.all(srcs.map((src) => new Promise((res) => {
    if (silkImgs.has(src)) return res();
    const img = new Image();
    img.onload = () => { silkImgs.set(src, img); res(); };
    img.onerror = () => { silkImgs.set(src, null); res(); };
    img.src = src;
  })));
}

let grid = null;
async function renderAll() {
  await ensureSilks(races);   // 先加载彩衣图再绘制，避免首帧缺图
  drawCanvas();
  const heads = races.reduce((n, r) => n + r.runners.length, 0);
  $s('#share-count').textContent = `${races.length} 场 · ${heads}頭`;
}

/* 追加列芯片：按当前版式的列序排布芯片，开关 = 改当前版式的 hidden（每版式独立） */
function renderColChips() {
  const cc = colCfg[layout];
  const extrasInOrder = cc.order.filter((k) => EXTRA_COLS.some((e) => e.k === k));
  $s('#share-cols').innerHTML = extrasInOrder.map((k) => {
    const e = EXTRA_COLS.find((c) => c.k === k);
    return `<button type="button" class="filter-chip${cc.hidden.includes(k) ? '' : ' on'}" data-k="${k}">${e.label}</button>`;
  }).join('');
}

async function blob() { return new Promise((res) => canvas.toBlob(res, 'image/png')); }
async function exportPNG() {
  const ds = [...new Set(races.map((r) => r.date))].sort();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await blob());
  a.download = `racecard-${ds[0] ?? 'share'}${ds.length > 1 ? `_${ds[ds.length - 1]}` : ''}.png`;
  a.click(); URL.revokeObjectURL(a.href);
}

function wire() {
  wired = true;
  renderLayoutChips();
  renderClockChips();
  renderColChips();
  $s('#share-layout').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-layout]'); if (!b || b.dataset.layout === layout) return;
    layout = b.dataset.layout;
    try { localStorage.setItem(LS_LAYOUT, JSON.stringify(layout)); } catch {}
    renderLayoutChips(); renderColChips(); renderAll();
  });
  $s('#share-clock').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-clock]'); if (!b) return;
    const next = { ...clockOpt, [b.dataset.clock]: !clockOpt[b.dataset.clock] };
    if (!next.bj && !next.local) return;   // 至少保留一路时间
    clockOpt = next;
    try { localStorage.setItem(LS_CLOCK, JSON.stringify(clockOpt)); } catch {}
    renderClockChips(); renderAll();
  });
  $s('#share-cols').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const cc = colCfg[layout];   // 开关只作用于当前版式（两版式显隐互不影响）
    const set = new Set(cc.hidden);
    set.has(b.dataset.k) ? set.delete(b.dataset.k) : set.add(b.dataset.k);
    cc.hidden = [...set];
    try { localStorage.setItem(LS_COLCFG, JSON.stringify(colCfg)); } catch {}
    renderColChips(); renderAll();
  });
  const scaleSel = $s('#share-scale');
  scaleSel.value = String(ls(LS_SCALE, 2));
  scaleSel.onchange = () => { try { localStorage.setItem(LS_SCALE, scaleSel.value); } catch {} drawCanvas(); };
  $s('#share-dl').onclick = exportPNG;
  $s('#share-copy').onclick = async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await blob() })]);
      btn.textContent = '已复制 ✓';
    } catch { btn.textContent = '复制失败，请用导出'; }
    setTimeout(() => (btn.textContent = '复制到剪贴板'), 1600);
  };
  $s('#share-back').onclick = () => {
    if (new URLSearchParams(location.search).get('share') === 'open') { window.close(); return; }
    document.body.classList.remove('share-open');
    $s('#share-view').hidden = true;
  };
  // 新标签打开：载荷经 sessionStorage 复制给新页（app.js 页内切换的主路径之外的备选）
  $s('#share-newtab').onclick = () => {
    try {
      sessionStorage.setItem('rc.share.payload', JSON.stringify(races));
      window.open('?share=open', '_blank');
    } catch (e) { console.error(e); }
  };
  $s('#share-add').onclick = () => {
    const f = $s('#share-form');
    f.hidden = !f.hidden;
    if (!f.hidden) { $s('#sf-date').value ||= new Date().toLocaleDateString('en-CA'); $s('#sf-venue').focus(); }
  };
  $s('#sf-cancel').onclick = () => { $s('#share-form').hidden = true; };
  $s('#share-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const date = $s('#sf-date').value || new Date().toLocaleDateString('en-CA');
    const venue = $s('#sf-venue').value.trim() || '自定义';
    const no = +$s('#sf-no').value || 1;
    const name = $s('#sf-name').value.trim() || `${venue} ${no}R`;
    const off = $s('#sf-tz').value;
    const time = $s('#sf-time').value || '12:00';
    const runners = $s('#sf-runners').value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const t = line.split(/\s+/);
      const fw = (s) => +String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
      const sa = t[3] ? /^([牡牝セ])/.exec(t[3]) : null;
      const age = sa ? fw(t[3].slice(1)) : null;
      return {
        frame: /^\d+$/.test(t[0] ?? '') ? +t[0] : (t[0] ?? null),
        num: /^\d+$/.test(t[1] ?? '') ? +t[1] : (t[1] ?? null),
        horseName: t[2] ?? '馬名未入力',
        sex: sa ? sa[1] : null,
        age: age || null,
        jockey: t.slice(4).join(' ') || null,
      };
    });
    races.push({
      manual: true, raceKey: `manual:${Date.now()}`,
      date, dateLabel: date.slice(5), weekday: WEEKDAY[new Date(date + 'T00:00:00Z').getUTCDay()] ?? '',
      scope: '自定义', country: null, venue, raceNo: no, raceName: name,
      level: $s('#sf-level').value || null, surface: $s('#sf-surface').value,
      distance: +$s('#sf-dist').value || null, heads: runners.length,
      startTime: time, startTimeTz: off === '+09:00' ? 'Asia/Tokyo' : off,
      startTimeInstant: `${date}T${time}:00${off}`,
      runners: runners.length ? runners : [{ frame: 1, num: 1, horseName: '馬名未入力', sex: null, age: null, jockey: null }],
    });
    $s('#share-form').hidden = true;
    $s('#sf-venue').value = $s('#sf-no').value = $s('#sf-name').value = $s('#sf-runners').value = '';
    grid?.hydrate();
    renderAll();
  });

  // Excel 式批量编辑表（share-grid.js）：就地编辑 → onChange 即时重绘画布
  grid = createGrid({
    root: $s('#share-grid'),
    grid: 'sg-grid', thead: 'sg-thead', tbody: 'sg-tbody', meta: 'sg-meta',
    addBtn: 'sg-addBtn', delBtn: 'sg-delBtn', undoBtn: 'sg-undoBtn', redoBtn: 'sg-redoBtn',
    pasteBtn: 'sg-pasteBtn', colBtn: 'sg-colBtn', colMenu: 'sg-colMenu', fsBtn: 'sg-fsBtn',
    toast: 'sg-toast',
    races: () => races,
    onChange: renderAll,
  });
}

/* ================= 入口（app.js 调用） ================= */
export function show(picked) {
  races = structuredClone(picked ?? []);
  document.body.classList.add('share-open');
  $s('#share-view').hidden = false;
  if (!wired) wire();
  grid.clearHistory();
  grid.hydrate();
  document.fonts.ready.then(renderAll).catch(renderAll);
}
