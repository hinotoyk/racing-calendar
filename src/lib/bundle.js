// gzip 原子压缩（源文档落盘用）：data/races/{date}/{track}.json.gz
// 编解码本体在 rows-codec.mjs（build 与前端共用）
import fs from "node:fs";
import zlib from "node:zlib";

// 路径若已带 .gz 则不再追加（调用方两种风格都安全：传 base 或传 *.json.gz）
const writeGz = (file, str) =>
  fs.writeFileSync(
    file.endsWith(".gz") ? file : `${file}.gz`,
    zlib.gzipSync(Buffer.from(str, "utf8"), { level: 9 })
  );
const readGz = (file) => zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");

export { writeGz, readGz };
