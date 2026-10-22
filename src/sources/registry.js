// 比赛源注册表（docs/DESIGN.md §8）
//
// ## 适配器接口约定
// 每个源一个模块，export：
//   id            源标识（manifest 键前缀、derived.source、文件名前缀）
//   label         展示名
//   homeUrl       原站入口（对应本项目的 racecards 语义）
//   probe()       连通性自检（不落盘）
//   collect(opts) → [{ date, file, doc }]
//       date        落盘目录用的比赛日（场地当地标签）
//       file        data/races/{date}/ 下的文件名（须全局唯一，如 rp-302.json）
//       doc         canonical race.card/v2 —— 字段名以 JBIS 为主（runners[].horse/sire/dam/bms...），
//                   源特有字段收进 doc.<id> 命名空间；时区按 normalize.js 约定标注
//
// ## 现有源
//   racingpost  本目录 racingpost.js（抓取层 sportinglife.com，见其文件头说明）
//   jbis        src/collect-races.js（既有专用采集器，输出本就符合 canonical 字段；
//               待后续迁入 sources/jbis.js，接口不变）
export const SOURCES = {
  racingpost: async () => ({
    id: "racingpost",
    label: "Racing Post",
    homeUrl: "https://www.racingpost.com/racecards/",
    ...(await import("./racingpost.js")),
  }),
};

export async function getSource(id) {
  const load = SOURCES[id];
  if (!load) throw new Error(`未知比赛源: ${id}（可用: ${Object.keys(SOURCES).join(", ")}）`);
  return load();
}
