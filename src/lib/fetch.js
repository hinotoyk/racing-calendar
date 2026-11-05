// JBIS / netkeiba / 彩衣图 抓取（礼貌间隔、超时、重试、JSONL 请求日志）
import { logRequest } from "./reqlog.js";

export const UA =
  "Mozilla/5.0 (compatible; JBIS-Race-Calendar/1.0; personal research, polite crawl)";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// 统一出站入口：测量耗时/字节数并写 JSONL 日志（src 标识来源，便于按源统计）
async function rawFetch(src, url, init) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const buf = Buffer.from(await res.arrayBuffer());
    logRequest({ src, url, status: res.status, ok: res.ok, ms: Date.now() - t0, bytes: buf.length });
    return { res, buf };
  } catch (e) {
    logRequest({ src, url, status: 0, ok: false, ms: Date.now() - t0, err: e.message });
    throw e;
  }
}

// 带重试/超时的抓取；非 2xx 视为失败
export async function fetchHtml(url, { retries = 3, timeoutMs = 30000, src = "jbis" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { res, buf } = await rawFetch(src, url, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = buf.toString("utf8");
      if (text.length < 500) throw new Error("short response (" + text.length + ")");
      return text;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 指数退避
    }
  }
  throw lastErr;
}

// 允许 404：出馬表在开赛前 1-2 日才生成，未公开时返回 404 / 空页
export async function fetchHtmlSoft(url, { retries = 2, timeoutMs = 30000, src = "jbis", ua = UA, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { res, buf } = await rawFetch(src, url, {
        headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml", ...headers },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 404) return null;
      if (!res.ok) {
        const e = new Error("HTTP " + res.status);
        e.status = res.status; // 调用方据此区分 403（限流，可重试）与 404（终态）
        throw e;
      }
      const text = buf.toString("utf8");
      return text.length < 500 ? null : text;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (e.status === 403) break; // 限流/封禁：重试无意义，交调用方退避
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// netkeiba 抓取：db.* 为 EUC-JP（按 charset 解码），nar.* 为 UTF-8；
// UA 需浏览器形态（bot UA 会拿不到正文）。失败抛错由调用方兜底。
export async function fetchNkHtml(url, { retries = 2, timeoutMs = 30000, src = "netkeiba" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { res, buf } = await rawFetch(src, url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("HTTP " + res.status);
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      // nar.*（出馬表）为 UTF-8、db.*（马页/马主页）为 EUC-JP：先信 Content-Type，再按域名兜底
      const isEuc = ct.includes("euc-jp") || (!ct.includes("utf-8") && /\/\/db\.netkeiba\.com/.test(url));
      let text;
      try {
        text = new TextDecoder(isEuc ? "euc-jp" : "utf-8").decode(buf);
      } catch {
        text = new TextDecoder().decode(buf); // ICU 缺失时退默认解码
      }
      return text.length < 500 ? null : text;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (e.status === 403) break; // 限流/封禁：重试无意义，交调用方退避
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// 二进制抓取（彩衣图等静态资源）；404 → null，其余非 2xx 抛错
export async function fetchBuffer(url, { retries = 2, timeoutMs = 30000, src = "image", accept = "image/*,*/*;q=0.8", ua = BROWSER_UA } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { res, buf } = await rawFetch(src, url, {
        headers: { "User-Agent": ua, Accept: accept },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (buf.length < 100) throw new Error("short response (" + buf.length + ")");
      return { buf, contentType: res.headers.get("content-type") ?? "" };
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (e.status === 403) break; // 限流/封禁：重试无意义，交调用方退避
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export { BROWSER_UA };
