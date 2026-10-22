// 共享 HTTP 抓取（各源适配器复用）：超时 / UA / __NEXT_DATA__ 提取
import https from "node:https";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function get(url, { headers = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout: " + url)));
    req.on("error", reject);
  });
}

// Next.js 页面内嵌数据（Sporting Life 等）
export function nextData(html) {
  const m = html?.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}
