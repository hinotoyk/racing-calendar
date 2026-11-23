/* ============================================================
 * yj-version.js —— 部署版本指纹探测 + 自动失效刷新（2026-11-23 定稿）
 * ------------------------------------------------------------
 * 解决「线上更新后，老访客浏览器还拿旧数据」：数据缓存（yj-cache 12h SWR，
 * 304 会续期）+ HTTP/CF 缓存叠加下，一次头像更新 19 分钟后才可见。
 * 机制（四兄弟站通用，yunji/kzn 走 Vite 注入，jbis/rc 手工引 script）：
 *   ① 构建期生成 <站点根>/version.json = { v: <git 短 SHA>, ts }——任何更新
 *     （编辑台提交 / CI 每日更新）都走 push main → 部署，v 必变；无人工维护点。
 *   ② 本模块在 页面加载 / 切回标签页 / 每 5 分钟 探测一次：no-store +
 *     ?t=时间戳（约 60 字节；?t 变化保证绕过 CF 边缘缓存与浏览器 HTTP 缓存）。
 *   ③ v 变化 → YJ.cache.bust()（有 yj-cache 的站：清 Cache API 桶 + 失效戳，
 *     之后 15min 内数据回源一律 no-store）→ location.reload()。
 *     sessionStorage 路 D / 内存层旧数据随失效戳一并作废。
 *   ④ 防循环：先把新 v 写回 localStorage 再 reload——第二次加载比对相等即静默。
 *     首次探测（本地无记录）也 bust + 刷一次（无法区分新访客与旧缓存访客，保守清；
 *     新访客空操作；localStorage 写回验证失败则不刷，防隐私模式无限循环）。
 *   ⑤ 护栏：编辑页（edit*.html，可能挂着未保存草稿）不自动刷新，改弹顶部
 *     提示条由访客手动确认；iframe 内各页自行探测并刷新自身（跨站 embed
 *     如 racing-calendar ?embed=1 借此获得同样的更新感知）。
 * 依赖：无（可选协作 YJ.cache.bust / YJ.util.storeKey，缺席自动降级为裸键）。
 * ============================================================ */
(function () {
  "use strict";

  var SITE = (window.YJ_VERSION_SITE || "yj");     /* 各站独立键前缀（无 storeKey 的站用） */
  var INTERVAL = 5 * 60 * 1000;                    /* 常规轮询间隔；切回标签页另触发即时探测 */

  /* 版本记录键：运行期求值（§105 同款约束——加载期求值会拿不到站点前缀） */
  function lsKey() {
    try {
      if (window.YJ && YJ.util && YJ.util.storeKey) return YJ.util.storeKey("deploy-version");
    } catch (e) {}
    return SITE + "-deploy-version";
  }
  function lastSeen() { try { return localStorage.getItem(lsKey()) || ""; } catch (e) { return ""; } }
  function saveSeen(v) { try { localStorage.setItem(lsKey(), String(v)); } catch (e) {} }

  /* version.json 恒在站点根：yunji/kzn 的子页在 /pages/ 下，需回上一级 */
  function verUrl() {
    return (/\/pages\//.test(location.pathname) ? "../" : "") + "version.json?t=" + Date.now();
  }

  /* 编辑页护栏：edit / edit-table / edit-drafts / edit-timeline 都命中 */
  function isEditPage() { return /(^|\/)edit[^/]*\.html$/i.test(location.pathname); }

  var checking = false;
  function check() {
    if (checking) return;
    checking = true;
    fetch(verUrl(), { cache: "no-store", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })   /* 404 = 部署窗口 → 下轮再试 */
      .then(function (j) {
        checking = false;
        var v = j && (j.v || j.commit);
        if (!v) return;
        var prev = lastSeen();
        if (prev && prev !== String(v)) onChange(String(v));
        else if (!prev) onFirst(String(v));
        else saveSeen(v);
      })
      .catch(function () { checking = false; });               /* 断网等 → 静默，保持现状 */
  }

  function onChange(v) {
    saveSeen(v);                                               /* 先记后刷：防 reload 循环 */
    try { if (window.YJ && YJ.cache && YJ.cache.bust) YJ.cache.bust(); } catch (e) {}
    if (isEditPage()) bar(v);
    else location.reload();
  }

  /* 首次探测（本地无版本记录）也清缓存 + 刷一次：无法区分「全新访客（无缓存，
   * bust 是无害空操作）」和「带着旧 SWR 缓存的老访客（12h 304 续期内 0 请求，
   * 恰好赶上本次部署前的旧数据）」——保守清掉才不漏后者（2026-11-23 ウィズクィーン
   * 图片事故：探测已上线但首次只记录不清缓存，老缓存访客刷新后依旧看不到新图）。
   * 隐私模式护栏：写回验证失败（localStorage 不可用/易失）→ 不 bust 不 reload，
   * 否则每次加载都是「首次」会无限刷新。 */
  function onFirst(v) {
    saveSeen(v);
    if (lastSeen() !== v) return;
    try { if (window.YJ && YJ.cache && YJ.cache.bust) YJ.cache.bust(); } catch (e) {}
    if (isEditPage()) return;                                  /* 编辑页护栏同 onChange */
    location.reload();
  }

  /* 编辑页顶部提示条（不自动刷新，草稿不丢） */
  function bar(v) {
    if (document.getElementById("yj-ver-bar")) return;
    var d = document.createElement("div");
    d.id = "yj-ver-bar";
    d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483000;" +
      "background:#1f2937;color:#fff;font:13px/1.8 system-ui,-apple-system,'Noto Sans SC',sans-serif;" +
      "text-align:center;padding:6px 12px;box-sizing:border-box;";
    var t = document.createElement("span");
    t.textContent = "站点数据已更新（" + v + "），";
    var a = document.createElement("a");
    a.href = "javascript:void(0)";
    a.style.cssText = "color:#7dd3fc;text-decoration:underline;cursor:pointer;";
    a.textContent = "点击刷新";
    a.onclick = function () { location.reload(); };
    var x = document.createElement("span");
    x.textContent = " 查看最新内容";
    d.appendChild(t); d.appendChild(a); d.appendChild(x);
    (document.body || document.documentElement).appendChild(d);
  }

  function boot() {
    check();
    setInterval(check, INTERVAL);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) check();                           /* 切回标签页立即感知 */
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
