import fs from "node:fs";
import { openZip } from "./zip.js";
import { isSessionJson, parseSession } from "./parse.js";

const path = "D:/研究成果/QQ机器人研究：本地DS/deepseek_data-2026-11-17.zip";
const t0 = Date.now();
const buf = fs.readFileSync(path);
console.log("读文件:", (buf.length / 1024 / 1024).toFixed(0), "MB", ((Date.now()-t0)/1000).toFixed(1)+"s");

const blob = new Blob([buf]);
const t1 = Date.now();
const zip = await openZip(blob);
console.log("条目:", zip.entries.length, "| 开目录", ((Date.now()-t1)/1000).toFixed(2)+"s");

const jsons = zip.entries.filter((e) => isSessionJson(e.name) && !e.name.includes("_files/"));
console.log("会话 json:", jsons.length);

const t2 = Date.now();
const rows = [];
for (const e of jsons) {
  const bytes = await zip.read(e);
  const d = JSON.parse(new TextDecoder().decode(bytes));
  const c = parseSession(d);
  if (c) rows.push({ name: e.name, title: c.title, count: c.count, files: c.fileCount });
}
rows.sort((a, b) => b.count - a.count);
console.log("解析耗时", ((Date.now()-t2)/1000).toFixed(1)+"s | 有效会话", rows.length);
for (const r of rows.slice(0, 5)) console.log("  ", r.count, "条 /", r.files, "附件 /", r.title);

const top = rows[0];
const bytes = await zip.read(jsons.find((e) => e.name === top.name));
const c = parseSession(JSON.parse(new TextDecoder().decode(bytes)));
console.log("\n最大会话首条:");
console.log("  [" + c.messages[0].role + "]", c.messages[0].text.slice(0, 60).replace(/\n/g," "));
console.log("末条:");
console.log("  [" + c.messages[c.messages.length-1].role + "]", c.messages[c.messages.length-1].text.slice(0, 60).replace(/\n/g," "));
console.log("带思考:", c.messages.filter(m=>m.reasoning).length, "| 带附件:", c.messages.filter(m=>m.files.length).length);

const img = zip.entries.filter((e) => /_files\//.test(e.name))[0];
const t3 = Date.now();
const data = await zip.read(img);
console.log("\n抽一个附件:", img.name.split("/").pop().slice(0,40), "→", (data.length/1024).toFixed(0), "KB", ((Date.now()-t3)/1000).toFixed(2)+"s");
