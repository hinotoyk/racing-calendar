// 出走行「字典包」编解码（单一出处：build 与前端共用本模块，杜绝两份实现漂移）
// 方法参照 yunji-web front/public/race-bundle.js：字段名表 + 字符串字典 + 行数组。
//   { v:1, k:[键名…], s:[字符串字段下标…], dict:[字符串字典…], rows:[[…]] }
//   - k = 字段名表（首见序，自描述）
//   - s = 字符串型字段下标：这些列的值存 dict 序号（整数），其余列原样（数值/布尔/数组）
//   - dict = 全局字符串字典（首见序 → 数据不变则字节不变，ETag 稳定）
//   - rows = 行数组（与源同构还原：字符串/数值/null/数组逐值相等）
// 输出确定性：行序由调用方定（build 侧显式排序），字典按首见序，无时间戳。
// 纯 JS、零依赖：Node（build/fixture）与浏览器（app.js 经 type=module import）共用。

function packRows(rows) {
  const keys = [];
  const kset = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!kset.has(k)) { kset.add(k); keys.push(k); }

  // 字符串型字段 = 全部非空值为 string 的列（混合类型列原样存，避免误编）
  const isStr = keys.map((k) =>
    rows.every((r) => { const v = r[k]; return v == null || typeof v === "string"; })
  );
  const s = keys.map((_, i) => i).filter((i) => isStr[i]);

  const dict = [];
  const dmap = new Map();
  const enc = (v) => {
    if (v == null) return null;
    const i = dmap.get(v);
    if (i !== undefined) return i;
    const ni = dict.length;
    dmap.set(v, ni);
    dict.push(v);
    return ni;
  };

  const out = rows.map((r) =>
    keys.map((k, i) => (isStr[i] ? enc(r[k] ?? null) : (r[k] ?? null)))
  );
  return { v: 1, k: keys, s, dict, rows: out };
}

function unpackRows(b) {
  const { k: keys, s, dict, rows } = b;
  const strSet = new Set(s);
  return rows.map((row) => {
    const o = {};
    keys.forEach((k, i) => {
      const v = row[i];
      if (v == null) return;               // 与源「无此键/显式 null」等价，省略
      o[k] = strSet.has(i) ? dict[v] : v;  // 字符串列 → 字典还原；其余原样
    });
    return o;
  });
}

// round-trip 断言：还原结果与源逐值相等（同构校验，漂移即 build 失败）
function assertRoundTrip(rows, bundle) {
  const back = unpackRows(bundle);
  const keys = bundle.k;
  const a = rows.map((r) => keys.map((k) => (r[k] == null ? null : r[k])));
  const eq = JSON.stringify(a) === JSON.stringify(back.map((r) => keys.map((k) => (r[k] == null ? null : r[k]))));
  if (!eq) throw new Error("bundle round-trip mismatch");
}

export { packRows, unpackRows, assertRoundTrip };
