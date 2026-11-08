// 运行配置
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 本地预览的端口 / 服务根 / 绑址单源 = 项目根 serve.config.json（docs/DESIGN.md §9/§10）。
// 四兄弟站约定：yunji-web 9090 / kzn-web 9091 / jbis-sire-rank-history 9092 / 本站 9093。
// ⚠ 9093 被宿主站硬编码引用（yunji-web `front/pages/entries.html` 的 RC_LOCAL），改端口必须同步改宿主。
export const SERVE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../serve.config.json", import.meta.url)), "utf8"),
);
export const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url)); // 仓库根（serve.config.json 所在）

export const SITE = {
  port: SERVE.port, // 本地预览端口（单源 = serve.config.json；旧注释「勿改 9091」已随四站分号作废）
  days: 3, // 默认采集「今天起 N 天」（含今天）
  delayMs: 1200, // 礼貌抓取间隔
};
