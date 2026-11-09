// 异常着顺的单一口径（数据层存单字，展示层显示中文全称）。
// 日本源来自 netkeiba 着顺栏；欧美源由 Sporting Life 的 ride_status /
// casualty.reason / ride_description 推定。新增 code 时必须同步：
//   - result-completeness.js（白名单由本模块生成，自动同步）
//   - build.js::normLastRank / collect-recent-pop.js::normRank（JBIS「前走着顺」正则）
//   - site/style.css::fin-ab-*（配色，缺省走中性徽标）
export const ABNORMAL_FINISH = {
  中: {
    label: "中止", cls: "ab-stop",
    desc: "競走中止（骑师拉停 / Pulled Up），未跑完全程",
  },
  失: {
    label: "失格", cls: "ab-dq",
    desc: "失格 / 被取消资格（Disqualified），成绩无效",
  },
  落: {
    label: "落马", cls: "ab-fall",
    desc: "落马或骑师落马（Fell / Unseated Rider / Brought Down / Slipped Up）",
  },
  除: {
    label: "除外", cls: "ab-out",
    desc: "除外，未出赛（Non Runner）",
  },
  取: {
    label: "取消", cls: "ab-out",
    desc: "取消出走（Withdrawn）",
  },
  止: {
    label: "拒跳", cls: "ab-stop",
    desc: "拒跳 / 跑出赛道（Refused / Ran Out）",
  },
  未: {
    label: "未完赛", cls: "ab-unknown",
    desc: "未获得名次且源站未公布原因；法国快步赛常见（多为失格），但不作推断",
  },
};

export const ABNORMAL_CODES = Object.keys(ABNORMAL_FINISH);
export const ABNORMAL_FINISH_RE = new RegExp(`^[${ABNORMAL_CODES.join("")}]$`);
export const abnormalMeta = (f) => (typeof f === "string" ? ABNORMAL_FINISH[f] ?? null : null);
