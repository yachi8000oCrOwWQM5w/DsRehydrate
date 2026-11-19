// CDK 生成器（不参与发布，只在本机跑）
//
// 用法：
//   node cdk-gen.mjs 20          # 生成 20 个
//   node cdk-gen.mjs 5 021      # 生成 5 个，编号从 021 开始
//
// 输出两部分：
//   1) 给人看的清单（客户编号 + CDK），你自己存着
//   2) 给程序用的哈希数组，粘进 mobile/gate.js 的 CODES
//
// 为什么只存哈希：码在代码里翻不到，只有哈希对得上才放行。

import crypto from "node:crypto";

// 去掉了容易认错的 I O 0 1
const AB = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function rand(n) {
  const buf = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += AB[buf[i] % AB.length];
  return s;
}

// 统一格式：RB-XXXX-XXXX，程序校验时会把连字符去掉再哈希
function makeCode() {
  return "RB-" + rand(4) + "-" + rand(4);
}

export function normalize(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashCode(code) {
  return crypto.createHash("sha256").update(normalize(code)).digest("hex");
}

const count = Number(process.argv[2] || 10);
const start = Number(process.argv[3] || 1);

const rows = [];
for (let i = 0; i < count; i++) {
  const code = makeCode();
  rows.push({ n: String(start + i).padStart(3, "0"), code, h: hashCode(code) });
}

console.log("\n=== 客户清单（只给你自己看，别发给别人）===");
for (const r of rows) console.log(`${r.n}\t${r.code}`);
console.log(`\n共 ${rows.length} 个\n`);

console.log("=== 粘进 mobile/gate.js 的 CODES ===");
console.log(rows.map((r) => `  { n: "${r.n}", h: "${r.h}" },`).join("\n"));
console.log("");
