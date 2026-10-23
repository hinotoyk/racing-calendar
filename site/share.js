// 出馬表分享卡（site/share.js）— canvas 渲染出图 + 分享视图（块编辑 / 手动添加比赛 / 导出 PNG）
// 设计 tokens 与主站 style.css 同源；渲染器设计稿见 design/share-card.html
// app.js 经 dynamic import 调用 show(races)；本模块自持 DOM 事件，不回写主表状态

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

/* ================= 设计 tokens ================= */
const FONT = '"Geist","Noto Sans SC","Microsoft YaHei","PingFang SC",sans-serif';
const T = {
  backdrop: '#eef0f2', paper: '#ffffff',
  bar: '#0aa7a0', teal: '#0aa7a0', tealInk: '#0b6b64',
  ink: '#0a0a0a', sub: '#3f3f46', mut2: '#737373', mut: '#a1a1aa',
  line: '#e9e9ec', row: '#f2f2f4',
  g1: '#d5302a', g2: '#0a3b7e', g3: '#087220', listed: '#dca026', nar: '#c2318e',
};
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
  G1:['GⅠ',T.g1], G2:['GⅡ',T.g2], G3:['GⅢ',T.g3],
  Jpn1:['JpnⅠ',T.g1], Jpn2:['JpnⅡ',T.g2], Jpn3:['JpnⅢ',T.g3],
  JG1:['JGⅠ',T.g1], JG2:['JGⅡ',T.g2], JG3:['JGⅢ',T.g3],
  L:['L',T.listed], OP:['OP',T.teal], 地方重赏:['重賞',T.nar],
};

/* ================= 布局常量 ================= */
const W = 880, M = 24, PAD = 32;
const MAST_H = 100, HEAD_H = 58, COLH = 27, ROW_H = 36, FOOT_H = 62, GAP = 26;
const DATE_H = 42, VEN_H = 30;   // 日期 / 场地分组标题行高

const esc = (s) => String(s ?? "");
const wdOf = (d) => WEEKDAY[new Date(d + 'T00:00:00Z').getUTCDay()] ?? '';   // 2026-10-23 → 金
const subStr = (r) => [r.surface ?? '', r.distance ? `${r.distance}m` : ''].filter(Boolean).join('');   // ダ800m
const sexAge = (r) => `${r.sex ?? ''}${r.age ?? ''}`;

function bjOf(race) {
  if (!race.startTimeInstant) return null;
  const d = new Date(race.startTimeInstant);
  return isNaN(+d) ? null : new Date(+d + 8 * 3600e3);
}
const p2 = (n) => String(n).padStart(2, '0');
function bjText(race) {           // 北京时间；跨日带 MM-dd
  const d = bjOf(race);
  if (!d) return '';
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  const md = `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  return md === race.dateLabel ? hm : `${md} ${hm}`;
}
function tzTag(race) {            // 当地钟面的时区标（JBIS=JST；海外按绝对时刻偏移）
  if (!race.startTimeTz || race.startTimeTz === 'Asia/Tokyo') return 'JST';
  const m = /([+-])(\d{2}):(\d{2})$/.exec(race.startTimeInstant ?? '');
  return m ? `UTC${m[1]}${+m[2]}` : race.startTimeTz;
}

/* ================= canvas 渲染 ================= */
const canvas = document.getElementById('share-canvas');
const ctx = canvas.getContext('2d');

const font = (w, s) => `${w} ${s}px ${FONT}`;
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

function chipBox(x, y, text, size, weight, fg, bg, padX, h, r) {
  ctx.font = font(weight, size);
  const w = tw(text) + padX * 2;
  ctx.fillStyle = bg; rr(x, y, w, h, r); ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + .5);
  return w;
}

function drawQR(x, y, size) {     // 页脚二维码（vendor/qrcode.js，MIT · Kazuhiko Arase）
  try {
    if (typeof window.qrcode !== 'function') return;
    const qr = window.qrcode(0, 'M');
    qr.addData(SHARE_URL);
    qr.make();
    const n = qr.getModuleCount();
    const cell = size / (n + 2);   // 内置 2 模块静区
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#0a0a0a';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + (c + 1) * cell, y + (r + 1) * cell, cell + .35, cell + .35);
    }
  } catch { /* QR 失败不阻断出图 */ }
}

function draw(scale, races, extras) {
  // 注意：width/height 赋值会重置画布状态（含变换矩阵），必须先设尺寸再 setTransform
  let H = M + MAST_H + 8;
  let hd = null, hv = null;
  for (const r of races) {
    if (r.date !== hd) { H += DATE_H; hd = r.date; hv = null; }   // 换天 → 日期标题
    if (r.venue !== hv) { H += VEN_H; hv = r.venue; }             // 换场地 → 场地标题
    H += HEAD_H + COLH + r.runners.length * ROW_H + GAP;
  }
  H += FOOT_H + M - GAP + 8;
  canvas.width = Math.round((W + M * 2) * scale);
  canvas.height = Math.round(H * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'alphabetic';

  // ---- 列布局（每场独立算：无枠番数据的比赛不展示枠番列；列序 固定基列 + 追加列；余量均摊占满行宽）----
  const demandW = (race, k, weight, size, min, max) => {
    ctx.font = font(weight, size);
    let w = 0;
    for (const h of race.runners) w = Math.max(w, tw(h[k] ?? '–'));
    return Math.min(max, Math.max(min, w + 24));
  };
  const layoutCols = (race) => {
    // 海外 / 未確定等没有枠番数据的比赛（无任何有效 1-8 枠）→ 整列不画
    const hasWaku = race.runners.some((h) => Number(h.frame) >= 1 && Number(h.frame) <= 8);
    const cols = [];
    if (hasWaku) cols.push({ k:'waku', label:'枠番', w:48, align:'c' });
    cols.push(
      { k:'num',    label:'馬番', w:46, align:'c' },
      { k:'horse',  label:'馬名', demand:demandW(race, 'horseName', 600, 16, 120, 340), min:120, align:'l' },
      { k:'sexage', label:'性齢', w:58, align:'c', size:13.5, c:T.sub },
      { k:'jockey', label:'騎手', demand:demandW(race, 'jockey', 400, 13.5, 72, 180), min:72, align:'l', size:13.5, c:T.sub },
    );
    for (const k of extras) {
      const e = EXTRA_COLS.find((c) => c.k === k);
      cols.push({ k, label:e.label, w: k === 'weight' ? 50 : demandW(race, k, 400, 13, 60, 158), min:60,
                  align: k === 'weight' ? 'c' : 'l', size:13, c:T.mut2 });
    }
    for (const c of cols) c.w = c.demand ?? c.w;
    const content = W - PAD * 2;
    const sum = cols.reduce((n, c) => n + c.w, 0) + (cols.length - 1) * 2;
    if (sum < content) {
      const share = (content - sum) / cols.length;   // 余量均摊：列越少每列越宽，匀而有序地占满一行
      for (const c of cols) c.w += share;
    } else if (sum > content) {
      const pool = cols.reduce((n, c) => n + Math.max(0, c.w - (c.min ?? c.w)), 0);
      const k = pool > 0 ? Math.min(1, (sum - content) / pool) : 0;
      for (const c of cols) c.w -= Math.max(0, c.w - (c.min ?? c.w)) * k;
    }
    let cx = PAD;
    for (const c of cols) { c.x = cx; cx += c.w + 2; }
    return cols;
  };

  // ---- 背景 + 卡片 ----
  ctx.fillStyle = T.backdrop; ctx.fillRect(0, 0, W + M * 2, H);
  ctx.save();
  ctx.shadowColor = 'rgba(10,10,10,.13)'; ctx.shadowBlur = 34; ctx.shadowOffsetY = 10;
  ctx.fillStyle = T.paper; rr(M, M, W, H - M * 2, 16); ctx.fill();
  ctx.restore();
  ctx.save();
  rr(M, M, W, H - M * 2, 16); ctx.clip();
  const L = M, R = M + W;

  // 顶部品牌条
  ctx.fillStyle = T.bar; ctx.fillRect(L, M, W, 6);

  // ---- Masthead ----
  {
    const top = M;
    const heads = races.reduce((n, r) => n + r.runners.length, 0);
    ctx.fillStyle = T.teal; ctx.fillRect(L + PAD, top + 24, 4, 62);
    ctx.font = font(700, 10.5);
    ctx.letterSpacing = '3px';
    ctx.fillStyle = T.tealInk; ctx.textAlign = 'left';
    ctx.fillText('RACE CARD', L + PAD + 14, top + 38);
    ctx.letterSpacing = '0px';
    ctx.font = font(700, 25);
    ctx.fillStyle = T.ink;
    ctx.fillText('出走表', L + PAD + 14, top + 67);
    ctx.font = font(400, 11.5);
    ctx.fillStyle = T.mut2;
    ctx.fillText(`共 ${heads} 頭出走 ${races.length} 场`, L + PAD + 14, top + 87);
    ctx.textAlign = 'left';
  }

  // ---- 比赛块（按 天 / 场地 分组标题 + 块头「场地NRR 比赛名」+ 副标题「ダ800m」）----
  let y = M + MAST_H + 8;
  let pd = null, pv = null;
  for (const race of races) {
    if (race.date !== pd) {   // 换天：日期标题单独起行
      pd = race.date; pv = null;
      ctx.fillStyle = T.teal; ctx.fillRect(PAD, y + 10, 4, 18);
      ctx.font = font(700, 15.5); ctx.fillStyle = T.ink; ctx.textAlign = 'left';
      ctx.fillText(`${+race.date.slice(5, 7)}月${+race.date.slice(8, 10)}日（${wdOf(race.date)}）`, PAD + 13, y + 25);
      y += DATE_H;
    }
    if (race.venue !== pv) {  // 换场地：场地小标题
      pv = race.venue;
      ctx.font = font(700, 13); ctx.fillStyle = T.tealInk; ctx.textAlign = 'left';
      ctx.fillText(esc(race.venue ?? ''), PAD, y + 19);
      y += VEN_H;
    }

    const by = y;
    // 块头：场地+R 与 比赛名同字号同行；随后 距离徽章 + 级别徽章
    const title = `${race.venue ?? ''}${race.raceNo ?? ''}R　${race.raceName ?? ''}`;
    const titleMax = R - PAD - 130;   // 右侧留双时钟
    ctx.font = font(700, 19.5);
    const tText = fit(title, titleMax);
    ctx.fillStyle = T.ink; ctx.textAlign = 'left';
    ctx.fillText(tText, PAD, by + 33);
    let nx = PAD + tw(tText) + 8;
    const dist = subStr(race);
    if (dist && nx < R - PAD - 60) nx += chipBox(nx, by + 16.5, dist, 11, 600, T.sub, '#f4f4f5', 6.5, 19, 4.5) + 5;
    const g = GRADE[race.level];
    if (g && nx < R - PAD - 60) nx += chipBox(nx, by + 16.5, g[0], 11, 700, '#fff', g[1], 6.5, 19, 4.5) + 4;

    // 双时钟：当地 → 北京
    ctx.textAlign = 'right';
    ctx.font = font(500, 11.5);
    ctx.fillStyle = T.mut;
    ctx.fillText(`当地 ${race.startTime ?? ''} ${tzTag(race)}`, R - PAD, by + 24);
    ctx.font = font(700, 16);
    ctx.fillStyle = T.tealInk;
    ctx.fillText(`北京 ${bjText(race)}`, R - PAD, by + 47);
    ctx.textAlign = 'left';

    // 表头（每场独立列布局：枠番按数据有无、追加列顺序固定）
    const cols = layoutCols(race);
    y += HEAD_H;
    ctx.font = font(600, 10);
    ctx.fillStyle = T.mut; ctx.textBaseline = 'middle';
    for (const c of cols) {
      ctx.textAlign = c.align === 'l' ? 'left' : 'center';
      ctx.fillText(c.label, c.align === 'l' ? c.x : c.x + c.w / 2, y + COLH / 2);
    }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.strokeStyle = T.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, y + COLH + .5); ctx.lineTo(R - PAD, y + COLH + .5); ctx.stroke();

    // 行
    y += COLH;
    race.runners.forEach((h, i) => {
      const ry = y + i * ROW_H;
      if (i) { ctx.strokeStyle = T.row; ctx.beginPath(); ctx.moveTo(PAD, ry + .5); ctx.lineTo(R - PAD, ry + .5); ctx.stroke(); }
      const mid = ry + ROW_H / 2 + 1;
      for (const c of cols) {
        if (c.k === 'waku') {
          const fr = Number(h.frame);
          if (fr >= 1 && fr <= 8) {
            const wk = WAKU[fr], s = 23;
            const wx = c.x + c.w / 2 - s / 2, wy = ry + (ROW_H - s) / 2;
            ctx.fillStyle = wk.bg; rr(wx, wy, s, s, 6); ctx.fill();
            if (wk.bd) { ctx.strokeStyle = wk.bd; ctx.lineWidth = 1; ctx.stroke(); }
            ctx.font = font(700, 12); ctx.fillStyle = wk.fg;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(fr), wx + s / 2, wy + s / 2 + .5);
            ctx.textBaseline = 'alphabetic';
          } else {
            ctx.font = font(500, 12); ctx.fillStyle = T.mut;
            ctx.textAlign = 'center'; ctx.fillText('–', c.x + c.w / 2, mid + 4); ctx.textAlign = 'left';
          }
          continue;
        }
        if (c.k === 'num') {
          ctx.font = font(700, 15.5); ctx.fillStyle = T.ink;
          ctx.textAlign = 'center'; ctx.fillText(String(h.num ?? '–'), c.x + c.w / 2, mid + 5); ctx.textAlign = 'left';
          continue;
        }
        if (c.k === 'horse') {
          ctx.font = font(600, 16); ctx.fillStyle = T.ink;
          ctx.fillText(fit(h.horseName ?? '', c.w - 6), c.x, mid + 5);
          continue;
        }
        const v = c.k === 'sexage' ? sexAge(h) : h[c.k];
        ctx.font = font(400, c.size ?? 13);
        ctx.fillStyle = c.c ?? T.sub;
        const s = v == null || v === '' ? '–' : String(v);
        ctx.textAlign = c.align === 'l' ? 'left' : 'center';
        ctx.fillText(c.align === 'l' ? fit(s, c.w - 6) : s, c.align === 'l' ? c.x : c.x + c.w / 2, mid + 4.5);
        ctx.textAlign = 'left';
      }
    });
    y += race.runners.length * ROW_H + GAP;
  }

  // ---- Footer（品牌 + 链接 + QR）----
  {
    const fy = y - GAP + 10;
    ctx.strokeStyle = T.line;
    ctx.beginPath(); ctx.moveTo(PAD, fy + .5); ctx.lineTo(R - PAD, fy + .5); ctx.stroke();
    const fc = fy + 38;
    ctx.fillStyle = T.teal; ctx.fillRect(PAD, fc - 15, 4, 20);
    ctx.font = font(800, 13.5);
    ctx.fillStyle = T.ink;
    ctx.fillText('RACING CALENDAR', PAD + 13, fc);
    const uw = tw('RACING CALENDAR');
    ctx.font = font(400, 11.5); ctx.fillStyle = T.mut;
    ctx.fillText('出走表分享', PAD + 13 + uw + 10, fc);
    const qs = 40;
    /* QR 码暂不生成（drawQR 与 vendor/qrcode.js 都保留，需要时取消注释即可恢复）
    drawQR(R - PAD - qs, fy + (FOOT_H - qs) / 2, qs);
    */
    ctx.font = font(600, 12.5); ctx.fillStyle = T.tealInk; ctx.textAlign = 'right';
    ctx.fillText(SHARE_URL, R - PAD, fc - 2);   // 完整打印链接
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/* ================= 分享视图状态 ================= */
const LS_COLS = 'rc.share.cols.v3', LS_SCALE = 'rc.share.scale';   // v3：默认 斤量+父+母父、騎手提前，重置一次旧偏好
const ls = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };

let races = [];                                   // 当前分享卡比赛（可编辑：删/排序/手动加）
// 追加列顺序恒按 EXTRA_COLS 排列（默认 斤量、父、母父），勾选先后不影响列序
const norm = (ks) => EXTRA_COLS.filter((c) => ks.includes(c.k)).map((c) => c.k);
let extras = norm(ls(LS_COLS, ['weight', 'sire', 'bms']));
let wired = false;

const $s = (sel) => document.querySelector(sel);

function renderAll() {
  draw(+($s('#share-scale').value || 2), races, extras);
  renderBlocks();
  const heads = races.reduce((n, r) => n + r.runners.length, 0);
  $s('#share-count').textContent = `${races.length} 场 · ${heads}頭`;
}

function renderBlocks() {
  $s('#share-blocks').innerHTML = races.map((r, i) =>
    `<div class="sb"><span class="sb-t">${esc(r.dateLabel)} ${esc(r.venue)} ${esc(r.raceNo)}R ${esc(r.raceName ?? '')}` +
    `<i>${r.runners.length}頭</i></span><span class="sb-b">` +
    `<button type="button" data-i="${i}" data-op="up" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>` +
    `<button type="button" data-i="${i}" data-op="down" title="下移" ${i === races.length - 1 ? 'disabled' : ''}>↓</button>` +
    `<button type="button" data-i="${i}" data-op="del" title="移除">✕</button></span></div>`
  ).join('') || '<div class="sb-empty">没有比赛：返回列表勾选，或手动添加</div>';
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
  renderColChips();
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
  scaleSel.onchange = () => { try { localStorage.setItem(LS_SCALE, scaleSel.value); } catch {} renderAll(); };
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
    if (new URLSearchParams(location.search).get('share') === 'open') { window.close(); return; }   // 新标签页：直接关掉
    document.body.classList.remove('share-open');
    $s('#share-view').hidden = true;
  };
  $s('#share-blocks').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const i = +b.dataset.i, op = b.dataset.op;
    if (op === 'del') races.splice(i, 1);
    if (op === 'up' && i > 0) [races[i - 1], races[i]] = [races[i], races[i - 1]];
    if (op === 'down' && i < races.length - 1) [races[i + 1], races[i]] = [races[i], races[i + 1]];
    renderAll();
  });
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
    renderAll();
  });
}

/* ================= 入口（app.js 调用） ================= */
export function show(picked) {
  races = structuredClone(picked ?? []);
  document.body.classList.add('share-open');
  $s('#share-view').hidden = false;
  if (!wired) wire();
  document.fonts.ready.then(renderAll).catch(renderAll);
}
