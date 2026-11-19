// 比赛视频源检索（探索分支 feat/global-graded）
//
// 策略：YouTube 搜索页抓取（无 API key），解析 ytInitialData 取首个
// videoRenderer 作为「已解析」结果；失败时 UI 退化为搜索跳转链接
// （YouTube / X）。解析结果缓存 data/global-graded/video-cache.json。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchHtmlSoft, BROWSER_UA } from "../lib/fetch.js";

const CACHE_FILE = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
  "data/global-graded/video-cache.json",
);

let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch { cache = {}; }
  return cache;
}
function saveCache() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}

// 检索词：日本「天皇賞（秋） 2026 レース」，海外「Arc de Triomphe 2026 Group 1」
export function videoQuery(race) {
  const year = String(race.date ?? "").slice(0, 4);
  const parts = [race.name, year];
  if (race.region === "overseas") parts.push(race.grade);
  return parts.filter(Boolean).join(" ");
}

export function youtubeSearchUrl(q) {
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
}
export function xSearchUrl(q) {
  return "https://x.com/search?q=" + encodeURIComponent(q) + "&f=live";
}

// 解析 YouTube 搜索页 → 首个视频 { videoId, title, url } | null
export async function resolveYouTube(q, { timeoutMs = 20000 } = {}) {
  const url = youtubeSearchUrl(q);
  const html = await fetchHtmlSoft(url, {
    src: "youtube",
    retries: 1,
    timeoutMs,
    ua: BROWSER_UA,
    headers: { "Accept-Language": "ja,en;q=0.8" },
  });
  if (!html) return null;
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  // 深度优先找第一个 videoRenderer（含 videoId + title）
  let out = null;
  const walk = (node, depth) => {
    if (out || depth > 24 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    const vr = node.videoRenderer ?? node.compactVideoRenderer;
    if (vr?.videoId) {
      const runs = vr.title?.runs ?? [];
      out = {
        videoId: vr.videoId,
        title: runs.map((r) => r.text).join("") || vr.title?.simpleText || "",
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
      };
      return;
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(data, 0);
  return out;
}

// 带缓存入口：race 须有 id；force = 忽略缓存重查
export async function videoForRace(race, { force = false } = {}) {
  const c = loadCache();
  if (!force && c[race.id]) {
    const hit = c[race.id];
    if (hit && !hit.stale) return hit;
  }
  const q = videoQuery(race);
  let result = null;
  try { result = await resolveYouTube(q); } catch { result = null; }
  const entry = {
    query: q,
    resolved: !!result,
    ...(result ?? {}),
    at: new Date().toISOString(),
  };
  c[race.id] = entry;
  saveCache();
  return entry;
}
