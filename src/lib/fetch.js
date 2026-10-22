// JBIS 抓取（礼貌间隔、超时、重试）
export const UA =
  "Mozilla/5.0 (compatible; JBIS-Race-Calendar/1.0; personal research, polite crawl)";

// 带重试/超时的抓取；非 2xx 视为失败
export async function fetchHtml(url, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
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
export async function fetchHtmlSoft(url, { retries = 2, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      return text.length < 500 ? null : text;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}
