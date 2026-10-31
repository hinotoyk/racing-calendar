// 出馬表分享卡（site/share.js）— canvas 多主题出图 + 分享视图（Excel 式批量编辑 / 手动添加比赛 / 导出 PNG）
// 设计 tokens 与主站 style.css 同源；渲染器设计稿见 design/share-card.html
// app.js 经 dynamic import 调用 show(races)；批量编辑表格见 share-grid.js（就地编辑即时同步本模块数据）

import { createGrid, shortRaceName } from "./share-grid.js";

const SHARE_URL = "https://hinotoyk.github.io/racing-calendar";
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

// 分享卡可追加的列（主表已采集字段；顺序即勾选后的列序）
const EXTRA_COLS = [
  { k:'weight',  label:'斤量' },
  { k:'trainer', label:'調教師' },
  { k:'sire',    label:'父' },
  { k:'sireSire',label:'父父' },
  { k:'bms',     label:'母父' },
  { k:'dam',     label:'母' },
  { k:'color',   label:'毛色' },
  { k:'belongs', label:'所属' },
  { k:'owner',   label:'馬主' },
  { k:'breeder', label:'生産牧場' },
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
const COLH = 27, ROW_H = 36, FOOT_H = 70, GAP = 26;

const esc = (s) => String(s ?? "");
const wdOf = (d) => WEEKDAY[new Date(d + 'T00:00:00Z').getUTCDay()] ?? '';
const subStr = (r) => [r.surface ?? '', r.distance ? `${r.distance}m` : ''].filter(Boolean).join('');
const sexAge = (r) => `${r.sex ?? ''}${r.age ?? ''}`;

function bjOf(race) {
  if (!race.startTimeInstant) return null;
  const d = new Date(race.startTimeInstant);
  return isNaN(+d) ? null : new Date(+d + 8 * 3600e3);
}
const p2 = (n) => String(n).padStart(2, '0');
// 「10月22日 15:40」文案（跨日自动带日期；无开走时间返回空）
function bjText(race) {
  const d = bjOf(race);
  if (!d) return '';
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
// 「10月22日 15:50」当地文案（不带时区标）
function localText(race) {
  if (!race.date || !race.startTime) return '';
  return `${+race.date.slice(5, 7)}月${+race.date.slice(8, 10)}日 ${race.startTime}`;
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

function draw(scale, races, extras) {
  const MAST_H = CUR.MAST_H, HEAD_H = CUR.HEAD_H;
  const ROW_H = CUR.ROW_H ?? 36, COLH = CUR.COLH ?? 27;   // 行高/表头高随主题（紧凑/舒展版式用）
  const GAP = CUR.GAP ?? 26;   // 块间距随主题（开放表用更大留白）
  const fs = CUR.fs ?? { head: 10, horse: 16, body: 13.5, extra: 13, num: 15.5 };
  let H = M + MAST_H + 8;
  for (const r of races) {
    H += HEAD_H + COLH + r.runners.length * ROW_H + GAP;
  }
  H += FOOT_H + M - GAP + 8;
  canvas.width = Math.round((W + M * 2) * scale);
  canvas.height = Math.round(H * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'alphabetic';

  // ---- 列布局（每场独立；与 v1 相同的 demand/收缩/均摊算法）----
  const demandW = (race, k, weight, size, min, max) => {
    ctx.font = font(weight, size);
    let w = 0;
    for (const h of race.runners) w = Math.max(w, tw(h[k] ?? '–'));
    return Math.min(max, Math.max(min, w + 24));
  };
  const layoutCols = (race) => {
    const hasWaku = race.runners.some((h) => Number(h.frame) >= 1 && Number(h.frame) <= 8);
    const cols = [];
    if (hasWaku) {
      // 枠番合一：枠色片 + 馬番同格，省出的列宽让给馬名（无枠的海外场只画馬番列）
      cols.push({ k:'wknum', label:'枠番', w:60, align:'c' });
    } else {
      cols.push({ k:'num', label:'馬番', w:46, align:'c' });
    }
    cols.push(
      { k:'horse',  label:'馬名', demand:demandW(race, 'horseName', 600, fs.horse, 120, 340), min:120, align:'l' },
      { k:'sexage', label:'性齢', w:58, align:'c', size:fs.body, c:TT.sub },
      { k:'jockey', label:'騎手', demand:demandW(race, 'jockey', 400, fs.body, 72, 180), min:72, align:'l', size:fs.body, c:TT.sub },
    );
    for (const k of extras) {
      const e = EXTRA_COLS.find((c) => c.k === k);
      cols.push({ k, label:e.label, w: k === 'weight' ? 50 : demandW(race, k, 400, fs.extra, 60, 158), min:60,
                  align: k === 'weight' ? 'c' : 'l', size:fs.extra, c:TT.mut2 });
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

  // ---- 背景 + 卡片 ----
  ctx.fillStyle = TT.backdrop; ctx.fillRect(0, 0, W + M * 2, H);
  ctx.save();
  ctx.shadowColor = TT.shadow ?? 'rgba(10,10,10,.13)'; ctx.shadowBlur = 34; ctx.shadowOffsetY = 10;
  ctx.fillStyle = TT.paper;
  rr(M, M, W, H - M * 2, 16); ctx.fill();
  ctx.restore();
  ctx.save();
  rr(M, M, W, H - M * 2, 16);
  ctx.clip();
  const L = M, R = M + W;

  // ---- Masthead（strip：顶部色条 + 青绿竖标）----
  {
    const top = M;
    const heads = races.reduce((n, r) => n + r.runners.length, 0);
    ctx.fillStyle = TT.bar; ctx.fillRect(L, M, W, 6);
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

  // ---- 比赛块（定稿 2026-10-29：不再画日期/场地分组标题，日期并入块头时间文案，避免重复） ----
  let y = M + MAST_H + 8;
  for (const race of races) {
    const by = y;
    /* 块头两段式：行1 = 比赛名 + 级别徽章 + 北京时间（同一基线）；
       行2 = 副标题（場R · 距离 · 当地时间） */
    const bjStr = clockOpt.bj ? bjText(race) : '';
    const localStr = clockOpt.local ? localText(race) : '';
    ctx.font = font(700, 16.5);
    const bjW = bjStr ? tw(`北京 ${bjStr}`) : 0;
    const hasBadge = !!(race.level && GRADE[race.level]);
    const tText = fit(shortRaceName(race.raceName), Math.max(180, R - PAD * 2 - bjW - (hasBadge ? 66 : 0) - 48));
    ctx.font = font(700, 19.5);
    ctx.fillStyle = TT.ink; ctx.textAlign = 'left';
    ctx.fillText(tText, PAD, by + 31);
    let nx = PAD + tw(tText) + 10;
    if (hasBadge) nx += gradeChip(nx, by + 15, race.level) || 0;
    if (bjStr) {
      ctx.font = font(700, 16.5); ctx.fillStyle = TT.tealInk;
      ctx.fillText(`北京 ${bjStr}`, nx + 18, by + 27);   // 实测对齐：时间字面底缘 = 比赛名字面底缘（CJK 底缘在基线上方 ~2px）
    }
    const sub = [`${race.venue ?? ''}${race.raceNo ?? ''}R`, subStr(race), localStr ? `当地 ${localStr}` : ''].filter(Boolean).join(' · ');
    ctx.font = font(500, 12); ctx.fillStyle = TT.sub;
    ctx.fillText(fit(sub, R - PAD * 2 - 14), PAD, by + 53);
    ctx.textAlign = 'left';

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
        if (c.k === 'wknum') {   // 枠番合一：左侧枠色片 + 馬番
          const fr = Number(h.frame);
          if (fr >= 1 && fr <= 8) {
            const wk = WAKU[fr];
            const s = 24, wx = c.x + 10, wy = mid - s / 2;
            ctx.fillStyle = wk.bg; rr(wx, wy, s, s, 6); ctx.fill();
            if (wk.bd) { ctx.strokeStyle = wk.bd; ctx.lineWidth = 1; ctx.stroke(); ctx.lineWidth = 1; }
            ctx.font = font(700, 12); ctx.fillStyle = wk.fg;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(fr), wx + s / 2, wy + s / 2 + .5);
            ctx.textBaseline = 'alphabetic';
            ctx.font = font(700, fs.num); ctx.fillStyle = TT.ink;
            ctx.fillText(String(h.num ?? '–'), c.x + (c.w + 34) / 2, mid + fs.num * 0.34);
          } else {
            ctx.font = font(700, fs.num); ctx.fillStyle = TT.ink;
            ctx.fillText(String(h.num ?? '–'), c.x + c.w / 2, mid + fs.num * 0.34);
          }
          ctx.textAlign = 'left';
          continue;
        }
        if (c.k === 'num') {
          ctx.font = font(700, fs.num); ctx.fillStyle = TT.ink;
          ctx.textAlign = 'center'; ctx.fillText(String(h.num ?? '–'), c.x + c.w / 2, mid + fs.num * 0.34); ctx.textAlign = 'left';
          continue;
        }
        if (c.k === 'horse') {
          ctx.font = font(600, fs.horse); ctx.fillStyle = TT.ink;
          ctx.fillText(fit(h.horseName ?? '', c.w - 18), c.x + 9, mid + fs.horse * 0.34);
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
  {
    const fy = y - GAP + 10;
    ctx.strokeStyle = TT.line;
    ctx.beginPath(); ctx.moveTo(PAD, fy + .5); ctx.lineTo(R - PAD, fy + .5); ctx.stroke();
    ctx.fillStyle = TT.teal; ctx.fillRect(PAD, fy + 13, 4, 30);
    ctx.font = font(800, 13.5); ctx.fillStyle = TT.ink; ctx.textAlign = 'left';
    ctx.fillText('RACING CALENDAR', PAD + 13, fy + 26);
    ctx.font = font(400, 10.5); ctx.fillStyle = TT.mut;
    ctx.fillText('数据仅供个人学习、研究 · 赛马应援 · 非商业用途 · v1.3.0', PAD + 13, fy + 44);
    const qs = 40;
    /* QR 码暂不生成（drawQR 保留，需要时取消注释即可恢复）
    drawQR(R - PAD - qs, fy + (FOOT_H - qs) / 2, qs);
    */
    ctx.font = font(600, 12.5); ctx.fillStyle = TT.tealInk; ctx.textAlign = 'right';
    ctx.fillText(SHARE_URL, R - PAD, fy + 38);
    ctx.font = font(400, 10.5); ctx.fillStyle = TT.mut2; ctx.textAlign = 'center';
    ctx.fillText('power by ディープ求索', R / 2, fy + 38);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/* ================= 分享视图状态 ================= */
const LS_COLS = 'rc.share.cols.v3', LS_SCALE = 'rc.share.scale';
const ls = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };

let races = [];
const norm = (ks) => EXTRA_COLS.filter((c) => ks.includes(c.k)).map((c) => c.k);
let extras = norm(ls(LS_COLS, ['weight', 'sire', 'bms']));
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
  draw(+($s('#share-scale').value || 2), races, extras);
}

let grid = null;
function renderAll() {
  drawCanvas();
  const heads = races.reduce((n, r) => n + r.runners.length, 0);
  $s('#share-count').textContent = `${races.length} 场 · ${heads}頭`;
}

function renderColChips() {
  $s('#share-cols').innerHTML = EXTRA_COLS.map((c) =>
    `<button type="button" class="filter-chip${extras.includes(c.k) ? ' on' : ''}" data-k="${c.k}">${c.label}</button>`
  ).join('');
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
  renderClockChips();
  renderColChips();
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
    const set = new Set(extras);
    set.has(b.dataset.k) ? set.delete(b.dataset.k) : set.add(b.dataset.k);
    extras = norm([...set]);
    try { localStorage.setItem(LS_COLS, JSON.stringify(extras)); } catch {}
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
