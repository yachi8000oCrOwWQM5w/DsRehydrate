import { openZip } from "./zip.js";
import { isSessionJson, parseSession, buildSystem, pickHistory, packAll, unpack, parseText } from "./parse.js";
import { gatePassed, tryUrlCode, renderGate } from "./gate.js";
import { makeZip } from "./zipwrite.js";

/* ---------------------------------------------------------------- 存储 */

let _db = null;
let MEM = null; // IndexedDB 不可用时的内存降级（隐私模式等）

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("storage timeout")), ms))]);
}
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open("rehydrate", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "id" });
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) {
  if (MEM) return MEM.get(k);
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("kv", "readonly").objectStore("kv").get(k);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function kvSet(k, v) {
  if (MEM) { MEM.set(k, v); return; }
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function kvDel(k) {
  if (MEM) { MEM.delete(k); return; }
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").delete(k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function filePut(rec) {
  if (MEM) { MEM.set("file:" + rec.id, rec); return; }
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("files", "readwrite");
    t.objectStore("files").put(rec);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function fileGet(id) {
  if (MEM) return MEM.get("file:" + id);
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("files", "readonly").objectStore("files").get(id);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function fileDel(id) {
  if (MEM) { MEM.delete("file:" + id); return; }
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("files", "readwrite");
    t.objectStore("files").delete(id);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function wipe() {
  if (MEM) { MEM.clear(); return; }
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(["kv", "files"], "readwrite");
    t.objectStore("kv").clear();
    t.objectStore("files").clear();
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}


/* ---------------------------------------------------------------- 多对话 */

const CHATS_KEY = "chats";
const ACTIVE_KEY = "active";
const msgsKey = (id) => "msgs:" + id;
const branchesKey = (id) => "branches:" + id;
const branchKey = (id) => "branch:" + id;
const branchCleanKey = (id) => "branchClean:" + id;

function ensureBranches() {
  if (!Array.isArray(S.branches) || !S.branches.length) S.branches = [S.msgs];
  if (!S.branches[S.branchIdx]) S.branches[S.branchIdx] = S.msgs;
}

async function cleanBranches(id, branches, branchIdx) {
  if (!Array.isArray(branches) || !branches.length) return { branches: [[]], idx: 0 };
  if (await kvGet(branchCleanKey(id)).catch(() => null)) return { branches, idx: branchIdx };

  const sig = (arr) => JSON.stringify((arr || []).map((m) => [
    m.role, String(m.text || ""), (m.images || []).length,
  ]));
  const seen = new Set();
  const cleaned = branches.filter((b) => {
    if (!Array.isArray(b) || b.length < 2) return false;
    const key = sig(b);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!cleaned.length) {
    const fallback = branches.find((b) => Array.isArray(b) && b.length) || [];
    cleaned.push(fallback);
  }

  let idx = Math.max(0, Math.min(Number(branchIdx) || 0, cleaned.length - 1));
  const active = branches[branchIdx];
  if (active && !cleaned.includes(active)) {
    idx = cleaned.reduce((best, b, i) => (b.length > cleaned[best].length ? i : best), 0);
  }

  await kvSet(branchesKey(id), cleaned);
  await kvSet(branchKey(id), idx);
  await kvSet(branchCleanKey(id), 1);
  return { branches: cleaned, idx };
}

async function persistChats() {
  await kvSet(CHATS_KEY, S.chats.map((c) => ({
    id: c.id, name: c.name, persona: c.persona, anchors: c.anchors,
    ts: c.ts || 0, count: c.count || 0, last: c.last || "",
  })));
}

async function saveActiveMsgs() {
  if (!S.activeId) return;
  ensureBranches();
  await kvSet(msgsKey(S.activeId), S.msgs);
  await kvSet(branchesKey(S.activeId), S.branches);
  await kvSet(branchKey(S.activeId), S.branchIdx);
  const c = S.chats.find((x) => x.id === S.activeId);
  if (c) {
    c.count = S.msgs.length;
    c.last = (S.msgs[S.msgs.length - 1] || {}).text || "";
    c.ts = Date.now();
    if (S.char) {
      c.name = S.char.name || c.name;
      c.persona = S.char.persona || "";
      c.anchors = S.char.anchors || "";
    }
    await persistChats();
  }
}

async function switchChat(id) {
  const c = S.chats.find((x) => x.id === id);
  if (!c) return;
  saveCurrentDraft();
  S.activeId = id;
  S.editIdx = null;
  S.char = { id: c.id, name: c.name, persona: c.persona, anchors: c.anchors };
  S.msgs = (await kvGet(msgsKey(id))) || [];
  const stored = await kvGet(branchesKey(id));
  S.branches = Array.isArray(stored) && stored.length ? stored : [S.msgs];
  S.branchIdx = Math.max(0, Math.min(Number(await kvGet(branchKey(id))) || 0, S.branches.length - 1));
  const cleaned = await cleanBranches(id, S.branches, S.branchIdx);
  S.branches = cleaned.branches;
  S.branchIdx = cleaned.idx;
  S.msgs = S.branches[S.branchIdx] || [];
  S.showFrom = null;
  S.urls.clear();
  await kvSet(ACTIVE_KEY, id);
  renderChat();
}

async function branchChat(idx) {
  if (S.busy) return;
  const m = S.msgs[idx];
  if (!m || m.role === "user") return;

  const base = S.char?.name || "新对话";
  const same = S.chats.filter((c) => c.name.startsWith(base + " · 分支")).length;
  const name = `${base} · 分支 ${same + 1}`;
  const id = uid();
  const copied = [];
  const fileMap = new Map();

  for (const src of S.msgs.slice(0, idx + 1)) {
    const images = [];
    for (const fid of src.images || []) {
      let newId = fileMap.get(fid);
      if (!newId) {
        const rec = await fileGet(fid).catch(() => null);
        if (!rec) continue;
        newId = uid();
        await filePut({ id: newId, name: rec.name || fid, blob: rec.blob });
        fileMap.set(fid, newId);
      }
      images.push(newId);
    }
    copied.push({ ...src, images });
  }

  const chat = {
    id, name,
    persona: S.char?.persona || "",
    anchors: S.char?.anchors || "",
    ts: Date.now(), count: copied.length,
    last: (copied[copied.length - 1] || {}).text || "",
  };
  S.chats.unshift(chat);
  await persistChats();
  await kvSet(msgsKey(id), copied);
  await kvSet(branchesKey(id), [copied]);
  await kvSet(branchKey(id), 0);
  await kvSet(branchCleanKey(id), 1);
  await switchChat(id);

  const meta = $("#cmeta");
  if (meta) {
    meta.textContent = `已新建分支对话：${name}`;
    setTimeout(() => { if (meta.textContent.includes("已新建分支对话")) meta.textContent = ""; }, 6000);
  }
}

async function createChat(name) {
  const id = uid();
  const c = { id, name: name || "新对话", persona: "", anchors: "", ts: Date.now(), count: 0, last: "" };
  S.chats.unshift(c);
  await persistChats();
  await kvSet(msgsKey(id), []);
  await kvSet(branchesKey(id), [[]]);
  await kvSet(branchKey(id), 0);
  await switchChat(id);
  return c;
}

async function deleteChat(id) {
  S.drafts.delete(id);
  // 顺带清掉这段对话引用的图片，不然库会越用越大
  await kvDel(branchesKey(id)).catch(() => {});
  await kvDel(branchKey(id)).catch(() => {});
  const msgs = (await kvGet(msgsKey(id)).catch(() => null)) || [];
  for (const m of msgs) {
    for (const fid of m.images || []) await fileDel(fid).catch(() => {});
  }
  S.chats = S.chats.filter((c) => c.id !== id);
  await persistChats();
  await kvSet(msgsKey(id), []);
  if (S.activeId === id) {
    if (S.chats[0]) await switchChat(S.chats[0].id);
    else {
      S.activeId = null; S.char = null; S.msgs = []; S.chats = [];
      await kvSet(ACTIVE_KEY, "");
      renderImport();
    }
  }
}

/* ---------------------------------------------------------------- 基础 */

const DEFAULT_CFG = {
  apiKey: "", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
  thinking: "off", budget: 128000, maxTokens: 8192, temperature: 1.1, search: false, font: 17,
  enterSend: true,
};
const S = {
  char: null, msgs: [], cfg: { ...DEFAULT_CFG },
  zip: null, rows: [], busy: false, ctrl: null,
  urls: new Map(), showFrom: null, pending: [],
  chats: [], activeId: null,
  drafts: new Map(), branches: [], branchIdx: 0, editIdx: null, editDraft: "", editPendingStart: null,
};
const $ = (s) => document.querySelector(s);
function applyFont() {
  document.documentElement.style.setProperty("--chat-font", (S.cfg.font || 15) + "px");
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const draftKey = () => S.activeId || "new";

function saveCurrentDraft() {
  const ta = $("#input");
  if (!ta) return;
  const key = draftKey();
  if (ta.value) S.drafts.set(key, ta.value);
  else S.drafts.delete(key);
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function imagesFromIds(ids) {
  const out = [];
  for (const id of ids || []) {
    const rec = await fileGet(id).catch(() => null);
    if (!rec) continue;
    out.push({ dl: await blobToDataUrl(rec.blob), blob: rec.blob });
  }
  return out;
}

function canContinueMsg(m) {
  if (!m || m.role !== "assistant" || m.error) return false;
  if (m.status === "stopped") return true;
  return /max_tokens|length/i.test(String(m.finishReason || ""));
}

function thinkingSummary(m) {
  const n = (m.reasoning || "").length;
  if (!n) return "思考过程";
  if (m.thinkStart && m.thinkEnd) {
    const sec = Math.max(1, Math.round((m.thinkEnd - m.thinkStart) / 1000));
    return `已思考 ${sec} 秒（${n} 字）`;
  }
  return `思考过程（${n} 字）`;
}

function apiError(status, raw) {
  const message = String(raw || "").slice(0, 200);
  if (status === 401 || status === 403 || /invalid api key|unauthorized|authentication/i.test(message)) {
    return { status, message: "API Key 无效或没有权限", action: "apiKey" };
  }
  if (status === 402 || /insufficient|balance|余额|充值/i.test(message)) {
    return { status, message: "账户余额不足", action: "topUp" };
  }
  if (status === 429) {
    return { status, message: "请求太频繁，稍后再试", action: "" };
  }
  if (status >= 500) {
    return { status, message: "服务暂时不可用，稍后再试", action: "" };
  }
  return { status, message: message || "请求失败", action: "" };
}

function dataResult(text, kind = "") {
  const el = $("#dataStatus");
  if (el) {
    el.textContent = text;
    el.className = "hint " + kind;
  } else {
    alertBox(text);
  }
}

function errorNoticeHTML(err) {
  if (!err) return "";
  const action = err.action === "apiKey"
    ? ' <button type="button" class="notice-act" data-act="fixKey">去设置</button>'
    : err.action === "topUp"
      ? ' <a class="notice-act" href="https://platform.deepseek.com/top_up" target="_blank" rel="noopener noreferrer">去充值</a>'
      : "";
  return `<div class="notice bad" style="margin-top:8px">${esc(err.message || "出错了")}${action}</div>`;
}
const app = document.getElementById("app");
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

/* 极简 markdown：先转义再套结构 */
const MD = (window.markdownit || (() => null))({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

if (MD) {
  const baseLinkOpen = MD.renderer.rules.link_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  MD.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
    return baseLinkOpen(tokens, idx, options, env, self);
  };
}

function md(src) {
  if (!src) return "";
  let t = String(src).replace(/\r\n/g, "\n");

  // 有些导出会把反斜杠二次转义；这里只在数学定界符上归一
  t = t.replace(/\\\\\(/g, "\\(")
       .replace(/\\\\\)/g, "\\)")
       .replace(/\\\\\[/g, "\\[")
       .replace(/\\\\\]/g, "\\]");

  // 数学先占位，避免 markdown-it 把 \ 当成转义符吃掉
  const mathBlocks = [], mathInlines = [];
  const bt = (expr) => {
    const tag = `MATHTB${mathBlocks.length}END`;
    mathBlocks.push({ tag, html: `\\[${expr}\\]` });
    return "\n\n" + tag + "\n\n";
  };
  const it = (expr, raw) => {
    const tag = `MATHIN${mathInlines.length}END`;
    mathInlines.push({ tag, html: raw === "dollar" ? `$$${expr}$$` : `\\(${expr}\\)` });
    return tag;
  };

  t = t.replace(/\\\[([\s\S]*?)\\\]/g, (m, expr) => bt(expr));
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, (m, expr) => bt(expr));
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, (m, expr) => it(expr, "paren"));
  t = t.replace(/\$([^\n$]+)\$/g, (m, expr) => it(expr, "dollar"));

  let html;
  if (MD) {
    html = MD.render(t);
    for (const b of mathBlocks) {
      const re = new RegExp(`<p>\\s*${b.tag}\\s*</p>`, "g");
      html = html.replace(re, `<div class="math-block">${b.html}</div>`);
      html = html.split(b.tag).join(b.html);
    }
    for (const i of mathInlines) html = html.split(i.tag).join(i.html);
    return html;
  }

  // 兜底：解析器没加载时至少不漏内容
  return `<p>${esc(t)}</p>`;
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const n = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function alertBox(msg) {
  const m = document.createElement("div");
  m.className = "mask";
  m.innerHTML = `<div class="alert"><div>${esc(msg)}</div><div class="a"><button>知道了</button></div></div>`;
  m.querySelector("button").onclick = () => m.remove();
  document.body.appendChild(m);
}

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  // 口令门：过了才进 App；?k=口令 可直接放行
  if (!gatePassed()) {
    if (!(await tryUrlCode())) {
      renderGate(app, () => boot());
      return;
    }
  }

  try {
    S.cfg = { ...DEFAULT_CFG, ...(await withTimeout(kvGet("cfg"), 2500)) };
    if (S.cfg.font < 17) {
      S.cfg.font = 17;
      await kvSet("cfg", S.cfg).catch(() => {});
    }

    let chats = await withTimeout(kvGet(CHATS_KEY), 2500);
    if (!Array.isArray(chats)) {
      // 老版本只有单个角色，迁过来
      const oldChar = await kvGet("char");
      const oldMsgs = (await kvGet("msgs")) || [];
      if (oldChar) {
        const id = uid();
        chats = [{
          id, name: oldChar.name || "未命名",
          persona: oldChar.persona || "", anchors: oldChar.anchors || "",
          ts: Date.now(), count: oldMsgs.length,
          last: (oldMsgs[oldMsgs.length - 1] || {}).text || "",
        }];
        await kvSet(msgsKey(id), oldMsgs);
        await kvSet(CHATS_KEY, chats);
        await kvSet(ACTIVE_KEY, id);
      } else {
        chats = [];
      }
    }
    S.chats = chats;

    const activeId = (await kvGet(ACTIVE_KEY)) || (chats[0] && chats[0].id);
    const cur = chats.find((c) => c.id === activeId) || chats[0];
    if (cur) {
      S.activeId = cur.id;
      S.char = { id: cur.id, name: cur.name, persona: cur.persona, anchors: cur.anchors };
      S.msgs = (await kvGet(msgsKey(cur.id))) || [];
      const storedBranches = await kvGet(branchesKey(cur.id));
      S.branches = Array.isArray(storedBranches) && storedBranches.length ? storedBranches : [S.msgs];
      S.branchIdx = Math.max(0, Math.min(Number(await kvGet(branchKey(cur.id))) || 0, S.branches.length - 1));
      const cleaned = await cleanBranches(cur.id, S.branches, S.branchIdx);
      S.branches = cleaned.branches;
      S.branchIdx = cleaned.idx;
      S.msgs = S.branches[S.branchIdx] || [];
    }
  } catch {
    MEM = new Map();
    S.chats = []; S.activeId = null;
    S.char = null; S.msgs = []; S.cfg = { ...DEFAULT_CFG };
  }

  const demoParam = new URLSearchParams(location.search).get("demo");
  if (demoParam === "search") {
    const now = Math.floor(Date.now() / 1000);
    const a = [
      { role: "user", text: "帮我讲讲麦克劳林公式", ts: now - 7200, reasoning: "", images: [] },
      { role: "assistant", text: "麦克劳林公式是在 x=0 处的泰勒展开。常用形式有 e^x = 1 + x + x^2/2! + …", ts: now - 7180, reasoning: "", images: [] },
      { role: "user", text: "再给我一个极限题的例子", ts: now - 7100, reasoning: "", images: [] },
      { role: "assistant", text: "例如用麦克劳林公式求 lim(x→0) (sin x - x)/x^3，答案是 -1/6。", ts: now - 7080, reasoning: "", images: [] },
    ];
    const b = [
      { role: "user", text: "Python 脚本里怎么算泰勒展开", ts: now - 86000, reasoning: "", images: [] },
      { role: "assistant", text: "可以用 sympy.series，也可以自己套麦克劳林公式。", ts: now - 85980, reasoning: "", images: [] },
      { role: "user", text: "那灯塔的故事呢", ts: now - 85000, reasoning: "", images: [] },
      { role: "assistant", text: "灯塔每隔十二秒扫过一次海面，和麦克劳林没有关系，但先记住这个细节。", ts: now - 84980, reasoning: "", images: [] },
    ];
    S.chats = [
      { id: "search-a", name: "高等数学", persona: "", anchors: "", ts: now - 7000, count: a.length, last: a[a.length - 1].text },
      { id: "search-b", name: "Python脚本未运行", persona: "", anchors: "", ts: now - 84000, count: b.length, last: b[b.length - 1].text },
    ];
    S.activeId = "search-a";
    S.char = { id: "search-a", name: "高等数学", persona: "", anchors: "" };
    S.msgs = a;
    // 演示数据只放内存，不写 IndexedDB，避免覆盖真实聊天列表
    MEM = new Map([
      [msgsKey("search-a"), a],
      [msgsKey("search-b"), b],
    ]);
  } else if (demoParam === "ticks") {
    S.chats = [{ id: "ticks", name: "刻度测试", persona: "", anchors: "", ts: Date.now(), count: 64, last: "多轮对话" }];
    S.activeId = "ticks";
    S.char = { id: "ticks", name: "刻度测试", persona: "", anchors: "" };
    S.msgs = [
      { role: "user", text: "第 1 个问题：这一段用户说了什么？" , ts: 1763600060, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 1 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600090, reasoning: "", images: [] },
      { role: "user", text: "第 2 个问题：这一段用户说了什么？" , ts: 1763600120, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 2 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600150, reasoning: "", images: [] },
      { role: "user", text: "第 3 个问题：这一段用户说了什么？" , ts: 1763600180, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 3 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600210, reasoning: "", images: [] },
      { role: "user", text: "第 4 个问题：这一段用户说了什么？" , ts: 1763600240, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 4 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600270, reasoning: "", images: [] },
      { role: "user", text: "第 5 个问题：这一段用户说了什么？" , ts: 1763600300, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 5 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600330, reasoning: "", images: [] },
      { role: "user", text: "第 6 个问题：这一段用户说了什么？" , ts: 1763600360, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 6 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600390, reasoning: "", images: [] },
      { role: "user", text: "第 7 个问题：这一段用户说了什么？" , ts: 1763600420, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 7 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600450, reasoning: "", images: [] },
      { role: "user", text: "第 8 个问题：这一段用户说了什么？" , ts: 1763600480, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 8 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600510, reasoning: "", images: [] },
      { role: "user", text: "第 9 个问题：这一段用户说了什么？" , ts: 1763600540, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 9 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600570, reasoning: "", images: [] },
      { role: "user", text: "第 10 个问题：这一段用户说了什么？" , ts: 1763600600, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 10 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600630, reasoning: "", images: [] },
      { role: "user", text: "第 11 个问题：这一段用户说了什么？" , ts: 1763600660, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 11 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600690, reasoning: "", images: [] },
      { role: "user", text: "第 12 个问题：这一段用户说了什么？" , ts: 1763600720, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 12 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600750, reasoning: "", images: [] },
      { role: "user", text: "第 13 个问题：这一段用户说了什么？" , ts: 1763600780, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 13 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600810, reasoning: "", images: [] },
      { role: "user", text: "第 14 个问题：这一段用户说了什么？" , ts: 1763600840, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 14 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600870, reasoning: "", images: [] },
      { role: "user", text: "第 15 个问题：这一段用户说了什么？" , ts: 1763600900, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 15 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600930, reasoning: "", images: [] },
      { role: "user", text: "第 16 个问题：这一段用户说了什么？" , ts: 1763600960, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 16 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763600990, reasoning: "", images: [] },
      { role: "user", text: "第 17 个问题：这一段用户说了什么？" , ts: 1763601020, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 17 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601050, reasoning: "", images: [] },
      { role: "user", text: "第 18 个问题：这一段用户说了什么？" , ts: 1763601080, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 18 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601110, reasoning: "", images: [] },
      { role: "user", text: "第 19 个问题：这一段用户说了什么？" , ts: 1763601140, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 19 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601170, reasoning: "", images: [] },
      { role: "user", text: "第 20 个问题：这一段用户说了什么？" , ts: 1763601200, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 20 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601230, reasoning: "", images: [] },
      { role: "user", text: "第 21 个问题：这一段用户说了什么？" , ts: 1763601260, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 21 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601290, reasoning: "", images: [] },
      { role: "user", text: "第 22 个问题：这一段用户说了什么？" , ts: 1763601320, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 22 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601350, reasoning: "", images: [] },
      { role: "user", text: "第 23 个问题：这一段用户说了什么？" , ts: 1763601380, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 23 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601410, reasoning: "", images: [] },
      { role: "user", text: "第 24 个问题：这一段用户说了什么？" , ts: 1763601440, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 24 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601470, reasoning: "", images: [] },
      { role: "user", text: "第 25 个问题：这一段用户说了什么？" , ts: 1763601500, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 25 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601530, reasoning: "", images: [] },
      { role: "user", text: "第 26 个问题：这一段用户说了什么？" , ts: 1763601560, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 26 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601590, reasoning: "", images: [] },
      { role: "user", text: "第 27 个问题：这一段用户说了什么？" , ts: 1763601620, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 27 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601650, reasoning: "", images: [] },
      { role: "user", text: "第 28 个问题：这一段用户说了什么？" , ts: 1763601680, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 28 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601710, reasoning: "", images: [] },
      { role: "user", text: "第 29 个问题：这一段用户说了什么？" , ts: 1763601740, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 29 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601770, reasoning: "", images: [] },
      { role: "user", text: "第 30 个问题：这一段用户说了什么？" , ts: 1763601800, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 30 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601830, reasoning: "", images: [] },
      { role: "user", text: "第 31 个问题：这一段用户说了什么？" , ts: 1763601860, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 31 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601890, reasoning: "", images: [] },
      { role: "user", text: "第 32 个问题：这一段用户说了什么？" , ts: 1763601920, reasoning: "", images: [] },
      { role: "assistant", text: "这是第 32 段回答，内容比较长，用来把正文撑高，方便观察滚动条刻度是否跟随当前阅读位置变化。\n\n- 第一点\n- 第二点" , ts: 1763601950, reasoning: "", images: [] }
    ];
  } else if (demoParam === "ds") {
    S.chats = [{ id: "ds", name: "高等数学", persona: "", anchors: "", ts: Date.now(), count: 2, last: "Markdown 排版测试" }];
    S.activeId = "ds";
    S.char = { id: "ds", name: "高等数学", persona: "", anchors: "" };
    S.msgs = [
      { role: "user", text: "继续讲泰勒公式的余项", ts: 1763600000, reasoning: "", images: [] },
      { role: "assistant", text: "### 四、灵魂拷问：后面那个 θ 和 \(o(x^n)\) 到底选哪个？\n\n你看第10-14页，公式末尾跟了一长串带 **θ** 的东西；而第15页的红星总结，末尾写的是 \\(o(x^n)\\)。这两个是同一个公式的两种“马甲”，**对应不同的考试题型**：\n\n1. 带 **θ** 的叫“拉格朗日余项”：\n\n   - 长相：例如 \\(e^x\\) 最后那一项是 \\(\\frac{e^{\\theta x}}{(n+1)!}x^{n+1}\\)。\n\n   - 用途：用来证明不等式或者估算误差。因为你可以用 \\(e^{\\theta x}\\) 的范围（比如 \\(0<\\theta<1\\)）去夹逼出最终的结果。\n\n2. 带 \\(o(x^n)\\) 的叫“皮亚诺余项”：\n\n   - 长相：例如 \\(e^x = 1 + x + \\frac{x^2}{2!} + \\cdots + \\frac{x^n}{n!} + o(x^n)\\)。\n\n   - 用途：纯粹用来求极限。它告诉你，后面的误差比 \\(x^n\\) 还小。\n\n---\n\n🔥 **考场上怎么用（第15页总结）**：\n\n- 当你求极限 \\(\\lim_{x\\to0}\\) 时，直接用第15页的那些带 \\(o(x^n)\\) 的公式。\n\n- 用到第几阶？原则是：展开到分母的阶数一致，或者加减法抵消后不为 0 的那一阶。", ts: 1763600060, reasoning: "", images: [] },
    ];
  } else if (demoParam === "math") {
    S.chats = [{ id: "math", name: "高等数学", persona: "", anchors: "", ts: Date.now(), count: 4, last: "公式渲染测试" }];
    S.activeId = "math";
    S.char = { id: "math", name: "高等数学", persona: "", anchors: "" };
    S.msgs = [
      { role: "user", text: "当 x_0=0 时，写出 f 的泰勒公式", ts: 1763500000, reasoning: "", images: [] },
      { role: "assistant", text: "当 \\(x_0=0\\) 时，泰勒公式变成：\n\n\\[\nf(x)=f(0)+f'(0)x+\\frac{f''(0)}{2!}x^2+\\frac{f'''(0)}{3!}x^3+\\cdots\n\\]\n\n其中 \\(\\frac{f^{(4)}(0)}{4!}x^4\\) 是四阶项。", ts: 1763500060, reasoning: "", images: [] },
      { role: "user", text: "再给一个德摩根律", ts: 1763500120, reasoning: "", images: [] },
      { role: "assistant", text: "设全集为 \\(U\\)，补集 \\(A^c=U\\setminus A=\\{x\\in U:x\\notin A\\}\\)。\n\n\\[\n(A\\cup B)^c=A^c\\cap B^c\n\\]\n\n任取 \\(x\\in U\\)，则 \\(x\\in(A\\cup B)^c\\iff x\\notin A\\cup B\\)。", ts: 1763500180, reasoning: "", images: [] },
    ];
  } else if (demoParam === "1") {
    S.chats = [{ id: "demo", name: "绀野灯", persona: "", anchors: "", ts: Date.now(), count: 2,
      last: "**她顿了一下**，手指停在玻璃罐的盖子上。" }];
    S.activeId = "demo";
    S.char = {
      name: "绀野灯",
      persona: "你是绀野灯，长野市的高三学生。说话短，习惯先观察再开口。",
      anchors: "一、三月在图书馆认识\n二、她讨厌被问「你是 AI 吗」\n三、上次约好讲完灯塔的故事",
    };
    S.msgs = [
      { role: "user", text: "你还记得那个灯塔吗", ts: 1763300000, reasoning: "", images: [] },
      { role: "assistant", text: "**她顿了一下**，手指停在玻璃罐的盖子上。\n\n> 海风那天很大，灯塔的光每隔十二秒扫过来一次。\n\n- 第一次扫光，你睡着了\n- 第二次扫光，我数到七\n\n`12s` 这个数字我一直记着。", ts: 1763300060, reasoning: "她在问上次的伏笔，先确认她记得，再往下讲。", images: [] },
    ];
  }

  applyFont();
  if (!S.char) renderImport();
  else renderChat();

  const sheetParam = new URLSearchParams(location.search).get("sheet");
  if (sheetParam === "1") openSettings();
  else if (sheetParam === "chats") openChatList();
  else if (sheetParam === "timeline") openTimeline();

  if (new URLSearchParams(location.search).get("mini") === "open") {
    setTimeout(() => $("#mini")?.classList.add("expanded"), 300);
  }
}

/* ---------------------------------------------------------------- 导入 */


function linkName(res, url) {
  const cd = res.headers.get("content-disposition") || "";
  let name = "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (star) name = decodeURIComponent(star[1].trim());
  else if (plain) name = plain[1].trim();
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    } catch {}
  }
  if (!name) name = "deepseek-export.zip";
  if (!/\.zip$/i.test(name)) name += ".zip";
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

async function handleLinkDownload(url, status, bar) {
  let u;
  try { u = new URL(url); } catch { throw new Error("链接格式不对，要以 https:// 开头"); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("只支持 http/https 链接");

  status.textContent = "正在连接下载地址…";
  const res = await fetch(u.href, {
    mode: "cors",
    credentials: "omit",
    redirect: "follow",
    referrerPolicy: "no-referrer",
  });

  if (!res.ok) throw new Error(`下载地址返回 ${res.status}`);

  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type.includes("text/html")) throw new Error("链接返回的是网页，不是 ZIP（可能需要登录或已经过期）");

  const len = Number(res.headers.get("content-length") || 0);
  status.textContent = len
    ? `正在下载 ${(len / 1048576).toFixed(1)} MB…`
    : "正在下载 ZIP，文件较大时可能要几十秒…";

  const blob = await res.blob();
  if (!blob.size) throw new Error("下载到的文件是空的");

  const name = linkName(res, u.href);
  status.textContent = `下载完成：${(blob.size / 1048576).toFixed(1)} MB，正在解析…`;
  bar.classList.add("on");
  bar.firstElementChild.style.width = "100%";

  return new File([blob], name, { type: "application/zip" });
}

function openLinkImport() {
  const sheet = document.createElement("div");
  sheet.className = "sheet on";
  sheet.innerHTML = `
    <div class="shead"><span>粘贴下载链接导入</span><button class="icon" id="lx">✕</button></div>
    <div class="sbody">
      <div class="field">
        <label>ZIP 下载链接</label>
        <input id="lUrl" type="url" inputmode="url" placeholder="https://…" autocomplete="off">
        <div class="hint">复制直接下载 ZIP 的链接。若提示跨域失败，先打开链接下载，再点「选择 ZIP」。</div>
      </div>
      <div class="dl-status" id="lStatus">支持 http/https；下载和解析都在本机完成。</div>
      <div class="dl-bar" id="lBar"><i></i></div>
      <button class="btn" id="lOk" style="margin-top:14px">下载并解析</button>
      <div class="dl-help" id="lHelp"></div>
    </div>`;
  document.body.appendChild(sheet);
  $("#lx").onclick = () => sheet.remove();

  $("#lOk").onclick = async () => {
    const url = $("#lUrl").value.trim();
    const status = $("#lStatus"), bar = $("#lBar"), btn = $("#lOk");
    const help = $("#lHelp");
    help.textContent = "";
    if (!url) return (status.textContent = "先把链接粘进来");

    btn.disabled = true;
    btn.textContent = "下载中…";
    status.classList.remove("err");
    try {
      const file = await handleLinkDownload(url, status, bar);
      sheet.remove();
      await handleZip(file);
    } catch (e) {
      status.textContent = "下载失败：" + (e.message || e);
      status.classList.add("err");
      const msg = String(e.message || e);
      const cors = /Failed to fetch|NetworkError|Load failed|cross-origin|CORS/i.test(msg);
      help.innerHTML = (cors
        ? "这个下载域名不允许浏览器跨域读取。<br>先打开链接下载 ZIP，再回来选文件即可。"
        : "下载没有成功。<br>可以打开链接手动下载，再回来选择 ZIP。");

      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "打开下载链接";
      a.className = "btn ghost";
      a.style.marginTop = "9px";
      help.appendChild(a);

      const pick = document.createElement("button");
      pick.className = "btn ghost";
      pick.textContent = "下载好了，选择 ZIP";
      pick.style.marginTop = "9px";
      const fi = document.createElement("input");
      fi.type = "file";
      fi.accept = ".zip,application/zip,application/x-zip-compressed";
      fi.style.display = "none";
      fi.onchange = async () => {
        if (!fi.files[0]) return;
        sheet.remove();
        await handleZip(fi.files[0]);
      };
      pick.onclick = () => fi.click();
      help.appendChild(pick);
      help.appendChild(fi);
    } finally {
      btn.disabled = false;
      btn.textContent = "下载并解析";
      bar.classList.remove("on");
      bar.firstElementChild.style.width = "0";
    }
  };
}

function openPasteImport() {
  const sheet = document.createElement("div");
  sheet.className = "sheet on";
  sheet.innerHTML = `
    <div class="shead"><span>粘贴文本导入</span><button class="icon" id="px">✕</button></div>
    <div class="sbody">
      <div class="field"><label>角色名</label><input id="pName" placeholder="留空用默认"></div>
      <div class="field">
        <label>内容</label>
        <textarea id="pText" style="min-height:240px" placeholder="## User&#10;……&#10;&#10;## Assistant&#10;……"></textarea>
        <div class="hint">支持 <code>## User</code> / <code>## Assistant</code> 分节，也支持每行开头的「用户:」「助手:」。</div>
      </div>
      <button class="btn" id="pOk">导入</button>
    </div>`;
  document.body.appendChild(sheet);
  $("#px").onclick = () => sheet.remove();

  $("#pOk").onclick = async () => {
    const msgs = parseText($("#pText").value);
    if (!msgs.length) return alertBox("没解析出消息，检查一下分节格式");
    const name = $("#pName").value.trim() || "从文本导入";
    const base = Math.floor(Date.now() / 1000);
    const list = msgs.map((m, i) => ({
      role: m.role, text: m.text, ts: base + i, reasoning: "", images: [],
    }));
    const cid = uid();
    S.chats.unshift({
      id: cid, name,
      persona: msgs[0].role === "user" ? msgs[0].text : "", anchors: "",
      ts: Date.now(), count: list.length, last: (list[list.length - 1] || {}).text || "",
    });
    await persistChats();
    await kvSet(msgsKey(cid), list);
    sheet.remove();
    await switchChat(cid);
  };
}

function renderImport(back) {
  app.innerHTML = `<div class="screen"><div class="intro">
    <div class="brand"><div class="mark"></div><div><h1>续语</h1><p>本地对话续写 · 不上传</p></div></div>
    ${back ? '<div class="backline" id="impBack">← 返回对话</div>' : ""}
    <div class="lede">把导出的 ZIP 交给她，<br>在手机上接着聊</div>
    <p class="desc">在 DeepSeek 的手机 App / 客户端里也能导出：<b>生成下载链接 → 复制到浏览器地址栏打开</b>，就能拿到 ZIP。把 ZIP 交给我，后面全在本地完成。</p>
    <div class="howto-row">
      <a class="howto" href="https://www.bilibili.com/video/BV1izsh65ET4/" target="_blank" rel="noopener noreferrer">▶ 第一次用？看教学视频</a>
      <a class="howto" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">去开放平台创建 API Key</a>
      <a class="howto repo" href="https://github.com/yachi8000oCrOwWQM5w/DsRehydrate" target="_blank" rel="noopener noreferrer">GitHub 仓库（欢迎来点 star）↗</a>
    </div>
    <div class="pick" id="pick">
      <div class="big">选择 ZIP 文件</div>
      <div class="small">300MB 的包首次解析约 10–20 秒<br>解析期间别切走页面</div>
    </div>
    <div class="paste" id="pickLink">有下载链接？粘贴链接导入</div>
    <div class="paste" id="pickPaste">不想传大包？粘贴文本导入</div>
    <div class="prog" id="prog"></div>
    <div class="bar" id="bar"><i></i></div>
    <div class="tips">
      <b>手机上怎么导</b><br>App / 客户端里找到「导出所有历史对话」，生成链接后复制到浏览器地址栏打开下载；电脑网页版也可以。<br><br>
      <b>数据去哪了</b><br>只存在这台手机的浏览器里。关掉网页还在，卸载浏览器才会没。
    </div>
  </div></div>`;

  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".zip,application/zip,application/x-zip-compressed";
  inp.style.display = "none";
  document.body.appendChild(inp);
  $("#pick").onclick = () => inp.click();
  $("#pickLink").onclick = openLinkImport;
  $("#pickPaste").onclick = openPasteImport;
  if (back) $("#impBack").onclick = back;
  inp.onchange = () => { if (inp.files[0]) handleZip(inp.files[0]); };
}

function setProg(text, pct) {
  const p = $("#prog"), b = $("#bar");
  if (p) p.textContent = text || "";
  if (b) {
    b.classList.toggle("on", typeof pct === "number");
    if (typeof pct === "number") b.firstElementChild.style.width = pct + "%";
  }
}

async function handleZip(file) {
  try {
    setProg("正在读取目录…", 2);
    const zip = await openZip(file);
    S.zip = zip;

    const own = zip.entries.find((e) => /(^|\/)rehydrate-manifest\.json$/i.test(e.name));
    if (own) {
      setProg("", null);
      await importOwnZip(zip, own);
      return;
    }

    const sig = "idx:" + file.name + ":" + file.size;
    let rows = await kvGet(sig).catch(() => null);

    if (Array.isArray(rows) && rows.length) {
      rows = rows
        .map((r) => ({ ...r, entry: zip.entries.find((e) => e.name === r.name) }))
        .filter((r) => r.entry);
      setProg("", null);
      if (rows.length) {
        S.rows = rows;
        renderPicker(rows, S.chats.length ? () => renderChat() : null);
        return;
      }
    }

    const jsons = zip.entries.filter((e) => isSessionJson(e.name));
    const list = [];
    for (let i = 0; i < jsons.length; i++) {
      const e = jsons[i];
      if (i % 8 === 0) setProg(`解析对话 ${i + 1} / ${jsons.length}`, 5 + (i / jsons.length) * 85);
      let d;
      try {
        d = JSON.parse(new TextDecoder().decode(await zip.read(e)));
      } catch { continue; }
      const c = parseSession(d);
      if (c) list.push({ entry: e, title: c.title, count: c.count, files: c.fileCount, preview: c.preview });
    }
    list.sort((a, b) => b.count - a.count);
    setProg("", null);
    if (!list.length) return alertBox("这个包里没找到能识别的对话。确认是「导出所有历史对话」下回来的 ZIP。");

    // 记住目录，下次选同一个包不用再解一遍
    await kvSet(sig, list.map((r) => ({
      name: r.entry.name, title: r.title, count: r.count, files: r.files, preview: r.preview,
    }))).catch(() => {});

    S.rows = list;
    renderPicker(list, S.chats.length ? () => renderChat() : null);
  } catch (e) {
    setProg("", null);
    alertBox("解析失败：" + (e.message || e));
  }
}

function renderPicker(rows, back) {
  app.innerHTML = `<div class="screen"><div class="picker">
    <div class="phead">
      <div class="t">选一段要接续的对话</div>
      <div class="s">按条数排序，共 ${rows.length} 段${back ? ' · <span id="pBack">返回对话</span>' : ""}</div>
    </div>
    <div class="plist" id="plist"></div>
  </div></div>`;
  if (back) $("#pBack").onclick = back;
  const list = $("#plist");
  rows.forEach((r, i) => {
    const b = document.createElement("button");
    b.className = "item";
    b.innerHTML = `<div class="r1"><b></b><span></span></div><div class="r2"></div>`;
    b.querySelector("b").textContent = r.title;
    b.querySelector("span").textContent = r.count + " 条";
    b.querySelector(".r2").textContent = (r.files ? r.files + " 个附件 · " : "") + (r.preview || "").slice(0, 42);
    b.onclick = () => importSession(i, b);
    list.appendChild(b);
  });
}

const normPath = (n) => {
  const i = n.indexOf("chat_sessions/");
  return i >= 0 ? n.slice(i) : n;
};

async function importSession(idx, btn) {
  const row = S.rows[idx];
  if (!row) return;
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = `<div class="r1"><b>正在导入…</b></div>`;
  try {
    const raw = await S.zip.read(row.entry);
    const conv = parseSession(JSON.parse(new TextDecoder().decode(raw)));
    if (!conv) throw new Error("这段对话解析失败");

    const wanted = new Set();
    for (const m of conv.messages) for (const f of m.files || []) wanted.add(normPath(f.path));

    const fileMap = new Map();
    for (const e of S.zip.entries) {
      const n = normPath(e.name);
      if (n.includes("_files/")) fileMap.set(n, e);
    }

    let bytes = 0, copied = 0, skipped = 0;
    const CAP = 80 * 1024 * 1024;
    for (const m of conv.messages) {
      const imgs = [];
      for (const f of m.files || []) {
        if (!f.image) { skipped++; continue; }
        const e = fileMap.get(normPath(f.path));
        if (!e) { skipped++; continue; }
        if (bytes > CAP) { skipped++; continue; }
        try {
          const data = await S.zip.read(e);
          const id = uid();
          await filePut({ id, name: f.name, blob: new Blob([data]) });
          imgs.push(id);
          bytes += data.length;
          copied++;
        } catch { skipped++; }
      }
      m.images = imgs;
      delete m.files;
    }

    const msgs = conv.messages.map((m) => ({
      role: m.role, text: m.text, ts: m.ts,
      reasoning: m.reasoning || "", images: m.images || [],
    }));

    const cid = uid();
    S.chats.unshift({
      id: cid, name: conv.title,
      persona: conv.firstUser || "", anchors: "",
      ts: Date.now(), count: msgs.length, last: (msgs[msgs.length - 1] || {}).text || "",
    });
    await persistChats();
    await kvSet(msgsKey(cid), msgs);
    await switchChat(cid);
    if (copied || skipped) {
      setTimeout(() => alertBox(`导入完成：${msgs.length} 条消息，${copied} 张图片${skipped ? `，${skipped} 个附件因体积或类型跳过` : ""}。人设暂用第一句预填，记得去设置里改。`), 300);
    }
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = old;
    alertBox("导入失败：" + (e.message || e));
  }
}

/* ---------------------------------------------------------------- 聊天 */


function searchDay(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (day === midnight) return "今天";
  if (day === midnight - 86400000) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function appendHighlighted(node, text, query) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let from = 0, at;
  while ((at = lower.indexOf(q, from)) !== -1) {
    if (at > from) node.appendChild(document.createTextNode(text.slice(from, at)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(at, at + q.length);
    node.appendChild(mark);
    from = at + q.length;
  }
  if (from < text.length) node.appendChild(document.createTextNode(text.slice(from)));
}

async function openMessageSearch() {
  const existing = document.querySelector(".search-mask");
  if (existing) {
    existing.querySelector("input")?.focus();
    return;
  }

  const mask = document.createElement("div");
  mask.className = "search-mask";
  mask.innerHTML = `
    <div class="search-dialog" role="dialog" aria-modal="true" aria-label="搜索聊天内容">
      <div class="search-head">
        <svg class="search-ic-lg" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
        <input id="msgSearchInput" type="search" placeholder="搜索聊天内容" autocomplete="off" spellcheck="false">
        <button class="icon" id="msgSearchClose" aria-label="关闭">✕</button>
      </div>
      <div class="search-status" id="msgSearchStatus">正在整理聊天记录…</div>
      <div class="search-list" id="msgSearchList"></div>
    </div>`;
  document.body.appendChild(mask);

  const input = $("#msgSearchInput");
  const status = $("#msgSearchStatus");
  const list = $("#msgSearchList");
  let corpus = null;
  let current = [];
  let timer = 0;

  const close = () => {
    clearTimeout(timer);
    document.removeEventListener("keydown", onKey);
    mask.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && current.length) jump(current[0]);
  };
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  $("#msgSearchClose").onclick = close;
  requestAnimationFrame(() => input.focus());

  const jump = async (r) => {
    close();
    if (r.cid !== S.activeId) await switchChat(r.cid);
    scrollToMsg(r.idx);
  };

  const buildCorpus = async () => {
    const out = [];
    for (const c of S.chats) {
      const msgs = c.id === S.activeId ? S.msgs : ((await kvGet(msgsKey(c.id)).catch(() => null)) || []);
      msgs.forEach((m, idx) => {
        const raw = String(m.text || "").replace(/\s+/g, " ").trim();
        if (!raw) return;
        out.push({
          cid: c.id,
          name: c.name || "未命名对话",
          idx,
          ts: m.ts || c.ts || 0,
          text: raw,
          lower: raw.toLowerCase(),
        });
      });
    }
    return out;
  };

  const run = () => {
    if (!mask.isConnected || !corpus) return;
    const q = input.value.trim();
    list.innerHTML = "";
    current = [];
    if (!q) {
      status.textContent = corpus.length ? "输入关键词，搜索所有对话里的聊天内容" : "还没有可搜索的对话";
      return;
    }

    const lq = q.toLowerCase();
    const hits = [];
    for (const row of corpus) {
      const at = row.lower.indexOf(lq);
      if (at < 0) continue;
      const from = Math.max(0, at - 34);
      const to = Math.min(row.text.length, at + q.length + 58);
      const before = from > 0 ? "…" : "";
      const after = to < row.text.length ? "…" : "";
      hits.push({ ...row, snippet: before + row.text.slice(from, to) + after });
    }
    hits.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    current = hits;
    status.textContent = hits.length ? `找到 ${hits.length} 条结果` : "没有找到相关内容";

    for (const r of hits.slice(0, 100)) {
      const item = document.createElement("button");
      item.className = "search-item";
      item.innerHTML = `
        <span class="search-bubble"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 12a8 8 0 0 1-8 8H8l-4 2 1.1-3.4A8 8 0 1 1 20 12Z"/><path d="M8 11h8M8 14h5"/></svg></span>
        <span class="search-main">
          <span class="search-row"><b>${esc(r.name)}</b><i>${esc(searchDay(r.ts))}</i></span>
          <span class="search-snippet"></span>
        </span>`;
      appendHighlighted(item.querySelector(".search-snippet"), r.snippet, q);
      item.onclick = () => jump(r);
      list.appendChild(item);
    }
    if (hits.length > 100) {
      const more = document.createElement("div");
      more.className = "search-more";
      more.textContent = `只显示前 100 条，共 ${hits.length} 条`;
      list.appendChild(more);
    }
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 140);
  });

  corpus = await buildCorpus();
  if (!mask.isConnected) return;
  status.textContent = corpus.length ? "输入关键词，搜索所有对话里的聊天内容" : "还没有可搜索的对话";
  run();
}

function openChatList(focusSearch = false) {
  const existing = document.querySelector(".chat-drawer");
  if (existing) {
    existing.querySelector("#cx")?.click();
    return;
  }
  const sheet = document.createElement("div");
  sheet.className = "sheet chat-drawer";

  const scrim = document.createElement("div");
  scrim.className = "drawer-scrim";
  document.body.appendChild(scrim);
  document.body.classList.add("drawer-open");

  sheet.innerHTML = `
    <div class="drawer-brand">
      <div class="logo"></div>
      <span>续语</span>
    </div>
    <div class="shead">
      <span>对话</span>
      <span class="sact">
        <button class="mini" id="newChat">＋ 新建</button>
        <button class="icon" id="cx" aria-label="关闭">✕</button>
      </span>
    </div>
    <div class="drawer-search">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
      <input id="chatSearch" placeholder="搜索对话" autocomplete="off">
    </div>
    <div class="sbody" id="chatBody">
      <button class="btn ghost" id="moreImport" style="margin-bottom:10px">＋ 从压缩包再选一段</button>
      <div id="clist"></div>
    </div>`;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    sheet.classList.add("on");
    scrim.classList.add("on");
    if (focusSearch) $("#chatSearch")?.focus();
  });

  const close = () => {
    sheet.classList.remove("on");
    scrim.classList.remove("on");
    document.body.classList.remove("drawer-open");
    setTimeout(() => { sheet.remove(); scrim.remove(); }, 240);
  };
  $("#cx").onclick = close;

  $("#moreImport").onclick = () => {
    close();
    if (S.zip && S.rows.length) renderPicker(S.rows, () => renderChat());
    else renderImport(() => renderChat());
  };

  $("#newChat").onclick = async () => {
    const name = prompt("新对话的名字", "新对话");
    if (name === null) return;
    await createChat(name.trim() || "新对话");
    renderRows($("#chatSearch")?.value || "");
  };

  const groupsOf = (ts) => {
    const d = new Date(ts || Date.now());
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const diff = start - new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (diff === 0) return "今天";
    if (diff === 86400000) return "昨天";
    if (diff <= 7 * 86400000) return "7 天内";
    if (diff <= 30 * 86400000) return "30 天内";
    return "更早";
  };

  const renderRows = (query = "") => {
    const box = $("#clist");
    if (!box) return;
    const q = query.trim().toLowerCase();
    const sorted = [...S.chats]
      .filter((c) => !q || (c.name || "").toLowerCase().includes(q) || (c.last || "").toLowerCase().includes(q))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));

    if (!sorted.length) {
      box.innerHTML = `<div class="hint">${q ? "没找到匹配的对话" : "还没有对话，点右上角新建"}</div>`;
      return;
    }

    box.innerHTML = "";
    let lastGroup = "";
    sorted.forEach((c) => {
      const g = groupsOf(c.ts);
      if (g !== lastGroup) {
        const h = document.createElement("div");
        h.className = "drawer-group";
        h.textContent = g;
        box.appendChild(h);
        lastGroup = g;
      }
      const row = document.createElement("div");
      row.className = "crow" + (c.id === S.activeId ? " on" : "");
      row.innerHTML = `<div class="cr1"><b></b><span></span></div><div class="cr2"></div>
        <button class="cedit" aria-label="更多">⋯</button>`;
      row.querySelector("b").textContent = c.name || "未命名";
      row.querySelector("span").textContent = (c.count || 0) + " 条";
      row.querySelector(".cr2").textContent =
        (c.last || "还没有消息").replace(/\\|\*\*|`|\*/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
      row.onclick = async () => {
        await switchChat(c.id);
        renderRows($("#chatSearch")?.value || "");
      };
      row.querySelector(".cedit").onclick = (e) => {
        e.stopPropagation();
        chatMenu(c, close, renderRows);
      };
      box.appendChild(row);
    });
  };

  $("#chatSearch").oninput = (e) => renderRows(e.target.value);
  renderRows();
}

function chatMenu(c, closeList, refreshRows) {
  const m = document.createElement("div");
  m.className = "mask";
  m.innerHTML = `<div class="alert">
    <div style="font-weight:500;margin-bottom:4px">${esc(c.name || "未命名")}</div>
    <div style="color:var(--muted);font-size:13px">${c.count || 0} 条对话</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">
      <button class="btn ghost" id="mRename">重命名</button>
      <button class="btn danger" id="mDelete">删除这段对话</button>
      <button class="btn ghost" id="mCancel">取消</button>
    </div></div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector("#mCancel").onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };

  m.querySelector("#mRename").onclick = async () => {
    const name = prompt("新名字", c.name || "");
    if (name === null) return;
    const nn = name.trim();
    if (!nn) return;
    const rec = S.chats.find((x) => x.id === c.id);
    if (!rec) return;
    rec.name = nn;
    if (S.activeId === c.id) {
      S.char.name = nn;
      $("#cname").textContent = nn;
    }
    await persistChats();
    close();
    refreshRows?.($("#chatSearch")?.value || "");
  };

  m.querySelector("#mDelete").onclick = async () => {
    if (!confirm(`删掉「${c.name || "未命名"}」？这段对话就没了，不能恢复。`)) return;
    close();
    await deleteChat(c.id);
    if (!S.chats.length) closeList();
    else refreshRows?.($("#chatSearch")?.value || "");
  };
}


async function saveCfg() { await kvSet("cfg", S.cfg); }

function syncPills() {
  const t = $("#pillThink"), s = $("#pillSearch"), e = $("#pillEnter");
  if (t) t.classList.toggle("on", S.cfg.thinking === "on");
  if (s) s.classList.toggle("on", !!S.cfg.search);
  if (e) {
    const enterSend = S.cfg.enterSend !== false;
    e.classList.toggle("on", enterSend);
    e.setAttribute("aria-pressed", String(enterSend));
    e.title = enterSend
      ? "当前：Enter 发送，Shift+Enter 换行。点击切换"
      : "当前：Enter 换行，Shift+Enter 发送。点击切换";
    const label = $("#pillEnterLabel");
    if (label) label.textContent = enterSend ? "Enter 发送" : "Enter 换行";
    const pic = e.querySelector(".pic");
    if (pic) pic.textContent = enterSend ? "↵" : "⇧↵";
  }
}

async function togglePill(which) {
  if (which === "thinking") {
    S.cfg.thinking = S.cfg.thinking === "on" ? "off" : "on";
  } else if (which === "search") {
    S.cfg.search = !S.cfg.search;
  } else if (which === "enter") {
    S.cfg.enterSend = S.cfg.enterSend === false;
  }
  syncPills();
  await saveCfg();
}


async function onMsgAction(e) {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const idx = Number(b.dataset.idx);
  const m = S.msgs[idx];
  if (!m) return;
  const act = b.dataset.act;

  if (act === "copy") {
    try {
      await navigator.clipboard.writeText(m.text || "");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = m.text || "";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (b.classList.contains("iact")) {
      b.classList.add("done");
      b.title = "已复制";
      setTimeout(() => { if (b.isConnected) { b.classList.remove("done"); b.title = "复制"; } }, 1500);
    } else {
      b.textContent = "已复制";
      setTimeout(() => { if (b.isConnected) b.textContent = "复制"; }, 1500);
    }
    return;
  }

  if (act === "speak") {
    if (!("speechSynthesis" in window)) return alertBox("这个浏览器不支持朗读");
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    const u = new SpeechSynthesisUtterance(m.text || "");
    u.lang = "zh-CN";
    u.rate = 0.95;
    speechSynthesis.speak(u);
    b.classList.add("done");
    b.title = "停止朗读";
    u.onend = () => { if (b.isConnected) { b.classList.remove("done"); b.title = "朗读"; } };
    return;
  }

  if (act === "del") {
    if (!confirm("删掉这条消息？")) return;
    S.msgs.splice(idx, 1);
    await saveActiveMsgs();
    renderStream();
    return;
  }

  if (act === "fixKey") {
    openSettings();
    return;
  }

  if (act === "regen") {
    await regenerate(idx);
    return;
  }

  if (act === "continue") {
    await continueGeneration(idx);
    return;
  }

  if (act === "fork") {
    if (S.busy || m.role !== "user") return;
    S.editIdx = idx;
    S.editDraft = m.text || "";
    S.editPendingStart = S.pending.length;
    renderStream({ keepScroll: true });
    requestAnimationFrame(() => {
      const ta = $("#stream [data-role=editText]");
      if (ta) { ta.focus(); ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 202) + "px"; }
    });
    return;
  }

  if (act === "cancelEdit") {
    S.editIdx = null;
    S.editDraft = "";
    if (typeof S.editPendingStart === "number") S.pending.splice(S.editPendingStart);
    S.editPendingStart = null;
    renderPending();
    renderStream({ keepScroll: true });
    return;
  }

  if (act === "sendEdit") {
    await sendEdit(idx);
    return;
  }

  if (act === "editAttach") {
    pickImage();
    return;
  }

  if (act === "prevBranch") {
    await switchBranch(-1);
    return;
  }

  if (act === "nextBranch") {
    await switchBranch(1);
    return;
  }

  if (act === "branchChat") {
    await branchChat(idx);
  }
}

async function continueGeneration(idx) {
  if (S.busy) return;
  const m = S.msgs[idx];
  if (!canContinueMsg(m)) return;
  let userIdx = idx - 1;
  while (userIdx >= 0 && S.msgs[userIdx].role !== "user") userIdx--;
  if (userIdx < 0) return;
  const imgs = await imagesFromIds(S.msgs[userIdx].images);
  await runStream(S.msgs[userIdx].text || "", imgs, { prefixIdx: idx });
}

async function forkFrom(idx, editedText = null, extraImages = [], flags = null) {
  if (S.busy) return;
  const m = S.msgs[idx];
  if (!m || m.role !== "user") return;
  ensureBranches();
  S.branches[S.branchIdx] = S.msgs;
  S.branches[S.branchIdx][idx].branchAnchor = true;
  const prefix = S.msgs.slice(0, idx + 1).map((x) => ({ ...x }));
  prefix.forEach((x, j) => { if (j !== idx) x.branchAnchor = false; });
  prefix[idx].text = editedText == null ? (m.text || "") : editedText;
  if (editedText != null) prefix[idx].ts = Math.floor(Date.now() / 1000);
  prefix[idx].branchAnchor = true;
  for (const it of extraImages || []) {
    const id = uid();
    await filePut({ id, name: "image", blob: it.blob });
    prefix[idx].images = [...(prefix[idx].images || []), id];
  }
  S.branches.push(prefix);
  S.branchIdx = S.branches.length - 1;
  S.editIdx = null;
  S.editDraft = "";
  S.msgs = S.branches[S.branchIdx];
  await saveActiveMsgs();
  S.showFrom = null;
  renderStream({ keepScroll: true });
  const imgs = await imagesFromIds(prefix[idx].images);
  await runStream(prefix[idx].text, imgs, flags || {});
}

async function sendEdit(idx) {
  if (S.busy) return;
  const m = S.msgs[idx];
  if (!m || m.role !== "user") return;
  const text = String(S.editDraft || "").trim();
  if (!text) return;
  const from = typeof S.editPendingStart === "number" ? S.editPendingStart : S.pending.length;
  const extraImages = S.pending.slice(from);
  S.pending.splice(from);
  S.editIdx = null;
  S.editDraft = "";
  S.editPendingStart = null;
  renderPending();
  await forkFrom(idx, text, extraImages);
}

function onMsgInput(e) {
  const ta = e.target.closest('[data-role="editText"]');
  if (!ta) return;
  S.editDraft = ta.value;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 202) + "px";
}

function onMsgKeydown(e) {
  const ta = e.target.closest('[data-role="editText"]');
  if (!ta) return;
  if (e.key === "Escape") {
    e.preventDefault();
    S.editIdx = null;
    S.editDraft = "";
    if (typeof S.editPendingStart === "number") S.pending.splice(S.editPendingStart);
    S.editPendingStart = null;
    renderPending();
    renderStream({ keepScroll: true });
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    void sendEdit(Number(ta.closest(".msg")?.dataset.idx));
  }
}

async function switchBranch(delta) {
  if (S.busy) return;
  ensureBranches();
  if (S.branches.length < 2) return;
  S.branches[S.branchIdx] = S.msgs;
  S.branchIdx = (S.branchIdx + delta + S.branches.length) % S.branches.length;
  S.editIdx = null;
  S.editDraft = "";
  S.msgs = S.branches[S.branchIdx];
  S.showFrom = null;
  await saveActiveMsgs();
  renderStream();
}


function userMsgIndexes() {
  const idxs = [];
  S.msgs.forEach((m, i) => { if (m.role === "user") idxs.push(i); });
  return idxs;
}

function buildMiniTicks() {
  const box = $("#miniItems");
  if (!box) return;
  if (!window.matchMedia("(min-width:900px)").matches) {
    box.innerHTML = "";
    box.dataset.count = "";
    return;
  }
  const idxs = userMsgIndexes();
  if (!idxs.length) {
    box.innerHTML = "";
    box.dataset.count = "";
    return;
  }
  if (box.dataset.count === String(idxs.length)) { updateMiniActive(); return; }
  box.dataset.count = String(idxs.length);
  box.innerHTML = idxs.map((idx) => {
    const m = S.msgs[idx];
    const text = (m.text || "").replace(/\\|\*\*|`|\*/g, "").replace(/\s+/g, " ").trim();
    return `<button type="button" class="timeline-row" data-idx="${idx}">
      <time>${esc(searchDay(m.ts) || fmtTime(m.ts))}</time>
      <span class="tl-txt">${esc(text.slice(0, 40) || "（用户消息）")}</span>
    </button>`;
  }).join("");
  const head = $("#miniPanel .timeline-head");
  if (head) head.textContent = `聊天时间线 · ${idxs.length} 段提问`;
  box.querySelectorAll(".timeline-row").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); scrollToMsg(Number(b.dataset.idx)); };
  });
  updateMiniActive();
}

function updateMiniActive() {
  if (!window.matchMedia("(min-width:900px)").matches) return;
  const el = $("#stream"), box = $("#miniItems");
  if (!el || !box) return;
  const rows = [...box.querySelectorAll(".timeline-row")];
  if (!rows.length) return;

  const nodes = [...el.querySelectorAll(".msg[data-idx]")];
  const anchor = el.getBoundingClientRect().top + el.clientHeight * 0.35;
  let viewing = Number(rows[rows.length - 1].dataset.idx);
  for (const node of nodes) {
    const r = node.getBoundingClientRect();
    if (r.bottom >= anchor) {
      viewing = Number(node.dataset.idx);
      break;
    }
  }

  let best = rows[0];
  let bestD = Infinity;
  rows.forEach((row) => {
    const idx = Number(row.dataset.idx);
    const d = idx <= viewing ? viewing - idx : idx - viewing + 1e6;
    if (d < bestD) { bestD = d; best = row; }
  });
  rows.forEach((row) => row.classList.toggle("active", row === best));
}

function bindMinimap() {
  const mini = $("#mini");
  if (!mini) return;
  mini.addEventListener("mouseenter", () => mini.classList.add("expanded"));
  mini.addEventListener("mouseleave", () => mini.classList.remove("expanded"));

  $("#stream").addEventListener("scroll", () => {
    if (!window.matchMedia("(min-width:900px)").matches) return;
    if (S.miniRaf) return;
    S.miniRaf = requestAnimationFrame(() => { S.miniRaf = 0; updateMiniActive(); });
  }, { passive: true });

  if (!S.miniResizeBound) {
    window.addEventListener("resize", buildMiniTicks);
    S.miniResizeBound = true;
  }
}

function renderChat() {
  app.innerHTML = `<div class="screen">
    <div class="top">
      <div class="toolset">
        <div class="brandmini" aria-hidden="true"><div class="mark"></div></div>
        <button class="icon" id="btnMenu" aria-label="对话列表"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h11"/></svg></button>
        <button class="icon" id="btnSearch" aria-label="搜索聊天内容"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg></button>
        <button class="icon wide-only" id="btnNewTop" aria-label="新建对话"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
      <button class="n" id="btnChats"><b id="cname"></b><span id="csub"></span></button>
      <button class="icon narrow-only" id="btnTimeline" aria-label="时间线"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3.1 2"/></svg></button>
      <button class="icon" id="btnSet" aria-label="设置"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg></button>
    </div>
    <div class="stream" id="stream"></div>
    <div class="composer">
      <div class="pending" id="pending"></div>
      <div class="cinner">
        <div class="pills">
          <button class="pill" id="pillThink" type="button"><span class="pic">◐</span>深度思考</button>
          <button class="pill" id="pillSearch" type="button"><span class="pic">◎</span>智能搜索</button>
          <button class="pill" id="pillEnter" type="button" aria-pressed="true"><span class="pic">↵</span><span id="pillEnterLabel">Enter 发送</span></button>
        </div>
        <div class="irow">
          <button class="imgbtn" id="btnImg" type="button" aria-label="发图片">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <textarea id="input" rows="1" placeholder="发消息…"></textarea>
          <button class="send" id="btnSend" aria-label="发送">
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 6l6 6-6 6"/></svg>
          </button>
          <button class="send stop" id="btnStop" hidden aria-label="停止">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>
          </button>
        </div>
      </div>
      <div class="cmeta" id="cmeta"></div>
    </div>
    <div class="timeline-rail" id="mini" aria-label="时间线">
      <div class="timeline-pop" id="miniPanel">
        <div class="timeline-head">聊天时间线</div>
        <div class="timeline-items" id="miniItems"></div>
      </div>
    </div>
  </div>`;

  $("#cname").textContent = S.char.name || "未命名";
  $("#csub").textContent = `${S.msgs.length} 条 · ${S.char.persona ? "已设人设" : "还没设人设"}`;
  $("#btnSet").onclick = openSettings;
  $("#btnTimeline").onclick = openTimeline;
  $("#btnChats").onclick = () => openChatList();
  $("#stream").addEventListener("click", onMsgAction);
  $("#stream").addEventListener("input", onMsgInput);
  $("#stream").addEventListener("keydown", onMsgKeydown);
  $("#btnMenu").onclick = () => openChatList();
  $("#btnSearch").onclick = () => openMessageSearch();
  $("#btnNewTop").onclick = () => {
    const name = prompt("新对话的名字", "新对话");
    if (name !== null) createChat(name.trim() || "新对话");
  };
  $("#pillThink").onclick = () => togglePill("thinking");
  $("#pillSearch").onclick = () => togglePill("search");
  $("#pillEnter").onclick = () => togglePill("enter");
  syncPills();
  $("#btnSend").onclick = send;
  $("#btnImg").onclick = pickImage;
  $("#btnStop").onclick = () => S.ctrl && S.ctrl.abort();
  bindMinimap();

  const ta = $("#input");
  ta.value = S.drafts.get(draftKey()) || "";
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 132) + "px";
  ta.addEventListener("input", () => {
    saveCurrentDraft();
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 132) + "px";
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const enterSend = S.cfg.enterSend !== false;
    const shouldSend = enterSend ? !e.shiftKey : e.shiftKey;
    if (shouldSend) { e.preventDefault(); send(); }
  });

  renderStream();
}

async function hydrateImages(root) {
  const imgs = [...root.querySelectorAll("img[data-f]")];
  let cursor = 0;

  const worker = async () => {
    while (cursor < imgs.length) {
      const img = imgs[cursor++];
      const id = img.dataset.f;
      let url = S.urls.get(id);
      if (!url) {
        const rec = await fileGet(id).catch(() => null);
        if (!rec) continue;
        url = URL.createObjectURL(rec.blob);
        S.urls.set(id, url);
      }
      img.src = url;
    }
  };

  await Promise.all(Array.from({ length: 4 }, worker));
}


function renderMath(root) {
  if (!root || typeof window.renderMathInElement !== "function") return;
  if (!/[\\$]/.test(root.textContent || "")) return;
  try {
    window.renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
  } catch (_) {}
}

const ICON = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  regen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
  cont: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M8 17c6 0 4-8 8-8"/></svg>',
};

function msgNode(m, opts = {}) {
  const u = m.role === "user";
  const idxAttr = typeof opts.idx === "number" ? ` data-idx="${opts.idx}"` : "";
  const imgs = (m.images || []).map((id) => `<img data-f="${id}" alt="" loading="lazy" decoding="async">`).join("");
  const imgHtml = imgs ? `<div class="imgs">${imgs}</div>` : "";

  if (u && opts.editing) {
    return `<div class="msg u editing"${idxAttr}><div class="body">
      ${imgHtml}
      <div class="inline-editor">
        <textarea data-role="editText" rows="1" aria-label="修改消息">${esc(m.text || "")}</textarea>
        <div class="editor-actions">
          <button type="button" class="attach" data-act="editAttach" data-idx="${opts.idx}" title="加图片" aria-label="加图片">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.6 12.7 20.3a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8"/></svg>
          </button>
          <button type="button" class="cancel" data-act="cancelEdit" data-idx="${opts.idx}">取消</button>
          <button type="button" class="primary" data-act="sendEdit" data-idx="${opts.idx}">发送</button>
        </div>
      </div>
    </div></div>`;
  }

  const think = m.reasoning
    ? `<details class="think"><summary>${esc(thinkingSummary(m))}</summary><div class="tb">${esc(m.reasoning)}</div></details>` : "";
  const cites = (m.cites || []).length
    ? `<div class="cites"><span>来源</span>${m.cites.map((c) =>
        `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || new URL(c.url).hostname)}</a>`).join("")}</div>` : "";
  const err = m.error ? errorNoticeHTML(m.error) : "";
  const filtered = (m.finishReason === "content_filter" || m.status === "refused")
    ? '<div class="notice warn" style="margin-top:8px">内容被过滤了，换个说法再试。</div>' : "";
  const always = opts.alwaysShow ? " always" : "";
  const branchBar = opts.branch
    ? `<div class="branchbar"><span>版本 ${opts.branch.index + 1}/${opts.branch.count}</span>
        <button type="button" data-act="prevBranch" data-idx="${opts.idx}" aria-label="上一个版本">‹</button>
        <button type="button" data-act="nextBranch" data-idx="${opts.idx}" aria-label="下一个版本">›</button>
      </div>` : "";
  const acts = typeof opts.idx === "number"
    ? u
      ? `<div class="mact uacts${always}">
          <button type="button" class="iact" data-act="copy" data-idx="${opts.idx}" title="复制" aria-label="复制">${ICON.copy}</button>
          ${opts.canFork ? `<button type="button" class="iact" data-act="fork" data-idx="${opts.idx}" title="修改" aria-label="修改">${ICON.edit}</button>` : ""}
          <button type="button" class="iact" data-act="del" data-idx="${opts.idx}" title="删除" aria-label="删除">${ICON.trash}</button>
        </div>`
      : `<div class="mact aacts${always}">
          <button type="button" class="iact" data-act="copy" data-idx="${opts.idx}" title="复制" aria-label="复制">${ICON.copy}</button>
          <button type="button" class="iact" data-act="speak" data-idx="${opts.idx}" title="朗读" aria-label="朗读">${ICON.speak}</button>
          <button type="button" class="iact" data-act="del" data-idx="${opts.idx}" title="删除" aria-label="删除">${ICON.trash}</button>
          ${opts.canRegen ? `<button type="button" class="iact" data-act="regen" data-idx="${opts.idx}" title="重新生成" aria-label="重新生成">${ICON.regen}</button>` : ""}
          ${opts.canContinue ? `<button type="button" class="iact" data-act="continue" data-idx="${opts.idx}" title="继续生成" aria-label="继续生成">${ICON.cont}</button>` : ""}
          <button type="button" class="chatbranch" data-act="branchChat" data-idx="${opts.idx}" title="从这条新建对话分支">${ICON.branch}<span>新增分支</span></button>
        </div>`
    : "";
  const bottom = acts || branchBar ? `<div class="ubottom">${acts}${branchBar}</div>` : "";
  const inner = `${think}
    <div class="text">${md(m.text)}</div>
    ${imgHtml}
    ${cites}
    ${err}
    ${filtered}
    ${m.ts ? `<div class="meta"><span>${fmtTime(m.ts)}</span></div>` : ""}`;
  return u
    ? `<div class="msg u"${idxAttr}><div class="body">${inner}</div>${bottom}</div>`
    : `<div class="msg"${idxAttr}><div class="body">${inner}${acts}</div></div>`;
}

function renderStream(opts = {}) {
  const el = $("#stream");
  const total = S.msgs.length;
  const keepScroll = !!opts.keepScroll;
  const prevTop = keepScroll ? el.scrollTop : 0;

  if (!total) {
    el.innerHTML = `<div class="empty-chat">
      <div class="eo-ring"><span></span></div>
      <div class="eo-t">跟她说点什么吧</div>
      <div class="eo-s">你写的第一句，就是这段对话的开始</div>
    </div>`;
    return;
  }
  const mobile = window.matchMedia("(max-width:899px)").matches;
  const batch = mobile ? 36 : 60;
  if (S.showFrom == null) S.showFrom = Math.max(0, total - batch);
  const start = Math.min(S.showFrom, total);

  let html = "";
  if (start > 0) {
    html += `<div class="more"><button id="btnMore">载入更早的 ${Math.min(40, start)} 条</button></div>`;
  }
  html += S.msgs.slice(start).map((m, i) => msgNode(m, {
    idx: start + i,
    canRegen: m.role !== "user",
    canContinue: start + i === total - 1 && canContinueMsg(m),
    canFork: m.role === "user" && S.editIdx !== start + i,
    editing: S.editIdx === start + i,
    alwaysShow: (m.role === "user" && (start + i === total - 1 || start + i === total - 2))
      || (m.role !== "user" && start + i === total - 1),
    branch: m.role === "user" && m.branchAnchor && S.branches.length > 1
      ? { index: S.branchIdx, count: S.branches.length } : null,
  })).join("");
  el.innerHTML = html;
  el.scrollTop = keepScroll ? prevTop : el.scrollHeight;
  hydrateImages(el);
  renderMath(el);
  buildMiniTicks();

  const more = $("#btnMore");
  if (more) {
    more.onclick = () => {
      const prevH = el.scrollHeight;
      S.showFrom = Math.max(0, start - 40);
      renderStream();
      el.scrollTop = el.scrollHeight - prevH;
    };
  }
}

async function regenerate(idx = null) {
  if (S.busy) return;
  const from = typeof idx === "number" ? idx : S.msgs.length - 1;
  const target = S.msgs[from];
  if (!target || target.role === "user") return;
  const flags = { thinkingOn: target.thinkingOn !== false, searchOn: !!target.searchOn };
  let userIdx = -1;
  for (let i = from - 1; i >= 0; i--) {
    if (S.msgs[i].role === "user") { userIdx = i; break; }
  }
  if (userIdx < 0) return;
  await forkFrom(userIdx, null, [], flags);
}

async function pickImage() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    const dl = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(f);
    });
    S.pending.push({ dl, blob: f });
    renderPending();
  };
  inp.click();
}

function renderPending() {
  const box = $("#pending");
  if (!box) return;
  box.innerHTML = "";
  S.pending.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "pthumb";
    d.innerHTML = `<img src="${it.dl}" alt=""><button>×</button>`;
    d.querySelector("button").onclick = () => { S.pending.splice(i, 1); renderPending(); };
    box.appendChild(d);
  });
}

function appendNode(html) {
  const el = $("#stream");
  const d = document.createElement("div");
  d.innerHTML = html;
  const node = d.firstElementChild;
  el.appendChild(node);
  el.scrollTop = el.scrollHeight;
  hydrateImages(node);
  renderMath(node);
  return node;
}

async function send() {
  if (S.busy) return;
  const ta = $("#input");
  const text = ta.value.trim();
  const imgs = S.pending.slice();
  if (!text && !imgs.length) return;
  if (!S.cfg.apiKey) { openSettings(); return alertBox("先填 API Key：设置 → 接口。"); }

  ta.value = "";
  ta.style.height = "auto";
  S.drafts.delete(draftKey());
  S.pending = [];
  if (window.matchMedia("(pointer: coarse)").matches) ta.blur();
  renderPending();

  const userMsg = {
    role: "user", text, ts: Math.floor(Date.now() / 1000), reasoning: "", images: [],
  };
  for (const it of imgs) {
    const id = uid();
    await filePut({ id, name: "image", blob: it.blob });
    userMsg.images.push(id);
  }

  S.msgs.push(userMsg);
  appendNode(msgNode(userMsg));
  await runStream(text, imgs);
}

async function runStream(text, images = [], opts = {}) {
  const prefixIdx = typeof opts.prefixIdx === "number" ? opts.prefixIdx : null;
  const prefix = prefixIdx != null ? S.msgs[prefixIdx] : null;
  const thinkingOn = typeof opts.thinkingOn === "boolean"
    ? opts.thinkingOn
    : (prefix ? prefix.thinkingOn !== false : S.cfg.thinking === "on");
  const searchOn = typeof opts.searchOn === "boolean"
    ? opts.searchOn
    : (prefix ? !!prefix.searchOn : !!S.cfg.search);

  let node, textEl, thinkEl, thinkBody;
  if (prefix) {
    node = $("#stream").querySelector(`.msg[data-idx="${prefixIdx}"]`);
    if (!node) return;
    node.classList.add("busy");
    node.querySelector(".mact")?.remove();
    node.querySelector(".notice.bad")?.remove();
    textEl = node.querySelector(".text");
    thinkEl = node.querySelector(".think");
    if (!thinkEl) {
      thinkEl = document.createElement("details");
      thinkEl.className = "think live";
      thinkEl.innerHTML = "<summary>思考中…</summary><div class=\"tb\"></div>";
      node.querySelector(".body")?.prepend(thinkEl);
    }
    thinkBody = thinkEl.querySelector(".tb");
    thinkEl.hidden = false;
    thinkEl.open = true;
  } else {
    node = appendNode(`<div class="msg"><div class="body">
      <details class="think live" hidden><summary>思考中…</summary><div class="tb"></div></details>
      <div class="text"><span class="caret"></span></div>
    </div></div>`);
    textEl = node.querySelector(".text");
    thinkEl = node.querySelector(".think");
    thinkBody = node.querySelector(".tb");
  }

  const baseText = prefix ? (prefix.text || "") : "";
  let reasoning = prefix ? (prefix.reasoning || "") : "";
  let thinkStart = prefix?.thinkStart || (reasoning ? Date.now() : 0);
  let thinkEnd = prefix?.thinkEnd || 0;

  S.busy = true;
  $("#btnSend").hidden = true;
  $("#btnStop").hidden = false;
  S.ctrl = new AbortController();

  let acc = "", queued = false, finishReason = "";
  const cites = prefix ? [...(prefix.cites || [])] : [];
  const paint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      textEl.innerHTML = md(baseText + acc) + '<span class="caret"></span>';
      renderMath(textEl);
      const el = $("#stream");
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
    });
  };

  const saveReply = (status, err = null) => {
    const data = {
      role: "assistant",
      text: baseText + acc,
      ts: prefix?.ts || Math.floor(Date.now() / 1000),
      reasoning: reasoning.slice(0, 4000),
      images: [],
      cites,
      status,
      finishReason: finishReason || (status === "stopped" ? "stopped" : ""),
      thinkStart,
      thinkEnd,
      thinkingOn,
      searchOn,
      error: err,
    };
    if (prefix && prefixIdx != null) S.msgs[prefixIdx] = data;
    else S.msgs.push(data);
  };

  try {
    const budget = Math.max(2000, S.cfg.budget - S.cfg.maxTokens);
    let userIdx = -1;
    if (prefix) {
      for (let i = prefixIdx - 1; i >= 0; i--) {
        if (S.msgs[i].role === "user") { userIdx = i; break; }
      }
      if (userIdx < 0) throw new Error("找不到续写对应的提问");
    }

    const historySource = prefix ? S.msgs.slice(0, userIdx) : S.msgs.slice(0, -1);
    const reserve = prefix ? Math.ceil(baseText.length / 2) + 80 : 0;
    const { history } = pickHistory(historySource, Math.max(2000, budget - reserve));

    const currentUser = prefix ? S.msgs[userIdx] : null;
    const currentImages = prefix
      ? await imagesFromIds(currentUser?.images)
      : images;

    const body = {
      model: S.cfg.model,
      stream: true,
      max_tokens: S.cfg.maxTokens,
      messages: [
        { role: "system", content: buildSystem(S.char) },
        ...history.map((m) => ({
          role: m.role,
          content: m.images && m.images.length ? m.text + "\n[此前发过图片]" : m.text,
        })),
        {
          role: "user",
          content: currentImages.length
            ? [{ type: "text", text: prefix ? (currentUser?.text || "（看图）") : (text || "（看图）") },
               ...currentImages.map((i) => ({ type: "image_url", image_url: { url: i.dl } }))]
            : (prefix ? (currentUser?.text || "") : text),
        },
      ],
    };
    if (prefix) {
      body.messages.push({ role: "assistant", content: baseText });
      body.messages.push({ role: "user", content: "继续刚才的回答。不要重复已经输出的内容，也不要解释，直接从中断处接着写。" });
    }
    if (searchOn) body.tools = [{ type: "deepseek_web_search" }];
    if (!thinkingOn) body.thinking = { type: "disabled" };
    if (thinkingOn) body.thinking = { type: "enabled" };
    if (!thinkingOn) body.temperature = Number(S.cfg.temperature) || 1.1;

    const res = await fetch(S.cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + S.cfg.apiKey },
      body: JSON.stringify(body),
      signal: S.ctrl.signal,
    });

    if (!res.ok) {
      const raw = await res.text();
      const err = new Error(`上游 ${res.status}：${raw.slice(0, 200)}`);
      err.status = res.status;
      err.info = apiError(res.status, raw);
      throw err;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.finish_reason) finishReason = ev.finish_reason;

        const anns = ev.annotations || (ev.choices || []).flatMap((ch) =>
          ch.message?.annotations || ch.delta?.annotations || []);
        for (const a of anns || []) {
          const url = a?.url || a?.source?.url || a?.web_search_tool_result?.url;
          const title = a?.title || a?.source?.title;
          if (url && !cites.some((c) => c.url === url)) cites.push({ url, title });
        }

        for (const ch of ev.choices || []) {
          if (ch.finish_reason) finishReason = ch.finish_reason;
          const d = ch.delta || {};
          if (d.reasoning_content) {
            if (!thinkStart) thinkStart = Date.now();
            reasoning += d.reasoning_content;
            thinkEl.hidden = false;
            thinkEl.open = true;
            thinkEl.querySelector("summary").textContent = `思考中… ${reasoning.length} 字`;
            thinkBody.textContent = reasoning.length > 1500 ? "…" + reasoning.slice(-1500) : reasoning;
            thinkBody.scrollTop = thinkBody.scrollHeight;
          }
          if (d.content) {
            if (!acc) {
              if (thinkStart && !thinkEnd) thinkEnd = Date.now();
              if (!thinkEl.hidden) {
                thinkEl.classList.remove("live");
                thinkEl.open = false;
                thinkEl.querySelector("summary").textContent =
                  thinkStart && thinkEnd
                    ? `已思考 ${Math.max(1, Math.round((thinkEnd - thinkStart) / 1000))} 秒（${reasoning.length} 字）`
                    : `思考过程（${reasoning.length} 字）`;
              }
            }
            acc += d.content;
            paint();
          }
        }
      }
    }

    if (reasoning && !thinkEnd) thinkEnd = Date.now();
    textEl.innerHTML = md(baseText + acc) || (finishReason === "content_filter" ? "（内容被过滤）" : "（空回复）");
    renderMath(textEl);
    saveReply("done");
    await saveActiveMsgs();
    renderStream();
  } catch (e) {
    const abort = e.name === "AbortError";
    const info = abort ? null : (e.info || apiError(e.status || 0, e.message));
    if (abort && acc.trim()) {
      saveReply("stopped");
      await saveActiveMsgs();
      renderStream();
    } else if (abort && prefix) {
      Object.assign(S.msgs[prefixIdx], {
        status: "stopped", finishReason: "stopped",
        reasoning: reasoning.slice(0, 4000), thinkStart, thinkEnd,
      });
      await saveActiveMsgs();
      renderStream();
    } else if (acc.trim() || prefix) {
      saveReply("error", info);
      await saveActiveMsgs();
      renderStream();
    } else {
      node.querySelector(".body").insertAdjacentHTML("beforeend", errorNoticeHTML(info));
      textEl.innerHTML = "";
    }
  } finally {
    S.busy = false;
    S.ctrl = null;
    const send = $("#btnSend"), stop = $("#btnStop");
    if (send) send.hidden = false;
    if (stop) stop.hidden = true;
    const sub = $("#csub");
    if (sub) sub.textContent = `${S.msgs.length} 条 · ${S.char?.persona ? "已设人设" : "还没设人设"}`;
    buildMiniTicks();
  }
}

/* ---------------------------------------------------------------- 设置 */


/* ---------------------------------------------------------------- 备份 / 迁移 */

function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: type || "application/octet-stream" });
}



function download(filename, text, type) {
  const blob = new Blob([text], { type: type || "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}


const safeName = (n) => (n || "角色").replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 24);

function exportCard() {
  const c = S.char;
  const firstAsst = (S.msgs.find((m) => m.role === "assistant") || {}).text || "";
  const card = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: c.name || "未命名",
      description: c.persona || "",
      personality: "",
      scenario: "",
      first_mes: firstAsst,
      mes_example: "",
      creator_notes: c.anchors || "",
      system_prompt: c.persona || "",
      post_history_instructions: "",
      tags: ["rehydrate"],
      creator: "rehydrate",
      character_version: "1.0",
      extensions: {},
    },
  };
  download(safeName(c.name) + ".card.json", JSON.stringify(card, null, 2));
}

function exportJsonl() {
  const c = S.char;
  const head = {
    user_name: "我", character_name: c.name || "", create_date: new Date().toISOString(),
    talkativeness: "0.5", mes: "", fav: false, tags: [], title: c.name || "",
    description: c.persona || "", personality: "", scenario: "",
    first_mes: (S.msgs.find((m) => m.role === "assistant") || {}).text || "",
    mes_example: "", creator_notes: c.anchors || "", system_prompt: c.persona || "",
    post_history_instructions: "", alternate_greetings: [], character_book: null,
    extensions: {}, character_version: "", creator: "rehydrate", chat_metadata: {},
  };
  const lines = [JSON.stringify(head)];
  for (const m of S.msgs) {
    lines.push(JSON.stringify({
      name: m.role === "user" ? "我" : (c.name || "她"),
      is_user: m.role === "user", is_system: false,
      send_date: m.ts ? new Date(m.ts * 1000).toISOString() : "",
      mes: m.text, extra: {},
    }));
  }
  download(safeName(c.name) + ".jsonl", lines.join("\n"), "application/jsonl");
}

async function distillAnchors() {
  const btn = $("#btnDistill");
  const key = $("#fKey").value.trim() || S.cfg.apiKey;
  const base = ($("#fBase").value.trim() || S.cfg.baseUrl).replace(/\/$/, "");
  const model = $("#fModel").value === "__custom" ? $("#fModelCustom").value.trim() : $("#fModel").value;
  if (!key) return alertBox("先填 API Key");
  if (S.msgs.length < 4) return alertBox("对话太短，攒几轮再提炼");

  btn.disabled = true;
  btn.textContent = "提炼中…";
  try {
    const who = S.char.name || "她";
    const convo = S.msgs.slice(-60).map((m) =>
      (m.role === "user" ? "我：" : who + "：") + (m.text || "").slice(0, 500)).join("\n");
    const prompt = `这是「${who}」与对方最近的一段对话。请提炼出为了以后接着聊、必须记住的长期事实。\n\n` +
      "要求：\n- 每条一行，以「- 」开头，最多 12 条\n" +
      "- 只写事实：身份、称呼、约定、共同经历、明确的好恶与禁忌、说到一半没讲完的事\n" +
      "- 不写情绪形容，不写「关系很好」这类空话，不复述剧情细节\n" +
      "- 已有的锚点不要重复\n\n" +
      `已有锚点：\n${$("#fAnchors").value || "（无）"}\n\n对话：\n${convo}`;

    const body = {
      model, stream: false, max_tokens: 900,
      messages: [
        { role: "system", content: "你在帮一段长期角色扮演做记忆压缩。只输出条目，不解释、不寒暄。" },
        { role: "user", content: prompt },
      ],
    };
    if ($("#fThink").value === "off") body.thinking = { type: "disabled" };

    const res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("上游 " + res.status + " " + (await res.text()).slice(0, 160));
    const data = await res.json();
    const text = ((data.choices || [])[0]?.message?.content || "").trim();
    if (!text) throw new Error("模型没有返回内容");
    const ta = $("#fAnchors");
    ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + text;
  } catch (e) {
    alertBox("提炼失败：" + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = "从最近 60 条提炼锚点";
  }
}

function fillModelSelect(models, current) {
  const sel = $("#fModel");
  if (!sel) return;
  const ids = (models || []).map((m) => m.id).filter(Boolean);
  if (current && !ids.includes(current)) ids.unshift(current);
  sel.innerHTML = "";
  ids.forEach((id) => {
    const o = document.createElement("option");
    o.value = id; o.textContent = id;
    sel.appendChild(o);
  });
  const c = document.createElement("option");
  c.value = "__custom"; c.textContent = "＋ 手动输入";
  sel.appendChild(c);
  sel.value = current && ids.includes(current) ? current : (ids[0] || "__custom");
  const box = $("#fModelCustom");
  if (box) box.hidden = sel.value !== "__custom";
  sel.onchange = () => {
    const b = $("#fModelCustom");
    if (!b) return;
    b.hidden = sel.value !== "__custom";
    if (!b.hidden) b.focus();
  };
}

function bindModelPicker(cfg) {
  fillModelSelect([], cfg.model);
  const btn = $("#btnModels");
  if (!btn) return;
  btn.onclick = async () => {
    const key = $("#fKey").value.trim() || cfg.apiKey;
    const base = ($("#fBase").value.trim() || cfg.baseUrl).replace(/\/$/, "");
    const hint = $("#modelHint");
    if (!key) { hint.textContent = "先填 API Key"; return; }
    btn.disabled = true; btn.textContent = "读取中";
    try {
      const res = await fetch(base + "/models", { headers: { Authorization: "Bearer " + key } });
      if (!res.ok) throw new Error("上游 " + res.status);
      const data = await res.json();
      const raw = data.data || data.models || [];
      const list = raw.map((m) => (typeof m === "string" ? { id: m } : { id: m.id || m.name })).filter((m) => m.id);
      const cur = $("#fModel").value === "__custom" ? $("#fModelCustom").value.trim() : $("#fModel").value;
      fillModelSelect(list, cur || cfg.model);
      hint.textContent = list.length ? `读到 ${list.length} 个模型，点下拉选` : "接口通了但没返回模型，手动填吧";
    } catch (e) {
      hint.textContent = "拉不到清单（" + (e.message || e) + "），手动填模型名也行";
    } finally {
      btn.disabled = false; btn.textContent = "读清单";
    }
  };
}

async function exportZip() {
  const btn = $("#zipBtn");
  btn.disabled = true;
  btn.textContent = "打包中…";
  try {
    const enc = new TextEncoder();
    const files = [];
    const manifest = {
      app: "rehydrate-mobile", v: 3, kind: "full-export",
      exportedAt: new Date().toISOString(),
      cfg: {
        baseUrl: S.cfg.baseUrl, model: S.cfg.model, thinking: S.cfg.thinking,
        budget: S.cfg.budget, maxTokens: S.cfg.maxTokens,
        temperature: S.cfg.temperature, search: !!S.cfg.search, font: S.cfg.font || 15,
      },
      chats: [],
    };

    let bytes = 0;
    const CAP = 200 * 1024 * 1024;

    for (const c of S.chats) {
      const msgs = c.id === S.activeId ? S.msgs : ((await kvGet(msgsKey(c.id))) || []);
      const out = { id: c.id, name: c.name, persona: c.persona, anchors: c.anchors, msgs: [], branches: [], branchIdx: 0 };
      const chatBranches = c.id === S.activeId
        ? S.branches
        : ((await kvGet(branchesKey(c.id)).catch(() => null)) || []);
      const sourceBranches = Array.isArray(chatBranches) && chatBranches.length ? chatBranches : [msgs];
      out.branchIdx = c.id === S.activeId
        ? S.branchIdx
        : (Number(await kvGet(branchKey(c.id)).catch(() => 0)) || 0);
      out.branchIdx = Math.max(0, Math.min(out.branchIdx, sourceBranches.length - 1));

      const fileNames = new Map();
      const exportBranch = async (branch) => {
        const result = [];
        for (const m of branch || []) {
          const imgs = [];
          for (const fid of m.images || []) {
            let fname = fileNames.get(fid);
            if (!fname) {
              if (bytes > CAP) continue;
              const rec = await fileGet(fid).catch(() => null);
              if (!rec) continue;
              const raw = new Uint8Array(await rec.blob.arrayBuffer());
              const safe = (rec.name || "image").replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 60);
              fname = fid + "_" + safe;
              files.push({ name: `chat_sessions/${c.id}_files/${fname}`, bytes: raw });
              bytes += raw.length;
              fileNames.set(fid, fname);
            }
            imgs.push(fname);
          }
          result.push({
            role: m.role, text: m.text, ts: m.ts || 0,
            reasoning: m.reasoning || "", images: imgs,
            branchAnchor: !!m.branchAnchor,
          });
        }
        return result;
      };

      for (const branch of sourceBranches) out.branches.push(await exportBranch(branch));
      out.msgs = out.branches[out.branchIdx] || [];
      manifest.chats.push(out);
    }

    files.unshift({
      name: "rehydrate-manifest.json",
      bytes: enc.encode(JSON.stringify(manifest, null, 2)),
    });

    const blob = makeZip(files);
    const name = `${safeName(S.char?.name)}-全部数据-${new Date().toISOString().slice(0, 10)}.zip`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);

    dataResult(`已打包 ${manifest.chats.length} 段对话、${files.length - 1} 张图片（${(bytes / 1048576).toFixed(1)} MB）。这个 zip 可以再导入回来。`, "ok");
  } catch (e) {
    dataResult("打包失败：" + (e.message || e), "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "导出全部数据（ZIP，可再导入）";
  }
}

async function importOwnZip(zip, maniEntry) {
  const mani = JSON.parse(new TextDecoder().decode(await zip.read(maniEntry)));
  const chats = mani.chats || [];
  const total = chats.reduce((n, c) => n + (c.msgs || []).length, 0);
  if (!confirm(`这是「续语」的备份包：${chats.length} 段对话、${total} 条消息。\n\n导入会覆盖手机上现有数据，继续吗？`)) return;

  const keepKey = S.cfg.apiKey;
  await wipe();

  const list = [];
  for (const c of chats) {
    const id = uid();
    const msgs = [];
    const fileIds = new Map();
    for (const m of c.msgs || []) {
      const ids = [];
      for (const fname of m.images || []) {
        let fid = fileIds.get(fname);
        if (!fid) {
          const e = zip.entries.find((x) => x.name.endsWith("/" + fname));
          if (!e) continue;
          const raw = await zip.read(e);
          fid = uid();
          const ext = (fname.split(".").pop() || "").toLowerCase();
          const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
          await filePut({ id: fid, name: fname, blob: new Blob([raw], { type: mime }) });
          fileIds.set(fname, fid);
        }
        ids.push(fid);
      }
      msgs.push({
        role: m.role, text: m.text, ts: m.ts || 0,
        reasoning: m.reasoning || "", images: ids,
        branchAnchor: !!m.branchAnchor,
      });
    }
    list.push({
      id, name: c.name || "未命名", persona: c.persona || "", anchors: c.anchors || "",
      ts: Date.now(), count: msgs.length,
      last: (msgs[msgs.length - 1] || {}).text || "",
    });
    await kvSet(msgsKey(id), msgs);
    const branches = Array.isArray(c.branches) && c.branches.length
      ? c.branches.map((branch) => branch.map((bm, bi) => ({
          role: bm.role, text: bm.text, ts: bm.ts || 0,
          reasoning: bm.reasoning || "",
          images: (bm.images || []).map((fname) => fileIds.get(fname)).filter(Boolean),
          branchAnchor: !!bm.branchAnchor,
        })))
      : [msgs];
    await kvSet(branchesKey(id), branches);
    await kvSet(branchKey(id), Math.max(0, Math.min(Number(c.branchIdx) || 0, branches.length - 1)));
  }

  await kvSet(CHATS_KEY, list);
  await kvSet(ACTIVE_KEY, list[0] ? list[0].id : "");
  await kvSet("cfg", { ...DEFAULT_CFG, ...(mani.cfg || {}), apiKey: keepKey });
  S.chats = list;
  dataResult(`导入完成：${list.length} 段对话、${total} 条消息。即将重新载入。`, "ok");
  setTimeout(() => location.reload(), 900);
}

async function exportData() {
  const withFiles = confirm(
    "要把图片一起打包吗？\n\n" +
    "确定 = 连图片一起（文件大，最多 20MB）\n" +
    "取消 = 只带文字和人设（几十 KB，换手机够用）"
  );

  // 收集所有对话（当前这条在内存里，其余从库里读）
  const chats = [];
  for (const c of S.chats) {
    const msgs = c.id === S.activeId ? S.msgs : ((await kvGet(msgsKey(c.id))) || []);
    const stored = c.id === S.activeId ? S.branches : ((await kvGet(branchesKey(c.id)).catch(() => null)) || []);
    const branches = Array.isArray(stored) && stored.length ? stored : [msgs];
    const branchIdx = Math.max(0, Math.min(
      Number(c.id === S.activeId ? S.branchIdx : (await kvGet(branchKey(c.id)).catch(() => 0))) || 0,
      branches.length - 1,
    ));
    chats.push({
      name: c.name, persona: c.persona, anchors: c.anchors,
      msgs: branches[branchIdx] || [], branches, branchIdx,
    });
  }
  if (!chats.length) chats.push({ name: S.char?.name || "角色", persona: S.char?.persona || "", anchors: S.char?.anchors || "", msgs: S.msgs, branches: [S.msgs], branchIdx: 0 });

  const pack = packAll(chats, S.cfg);
  const all = chats.flatMap((c) => (c.branches || [c.msgs]).flat());

  if (withFiles) {
    let bytes = 0, n = 0;
    for (const m of all) {
      for (const id of m.images || []) {
        if (bytes > 20 * 1024 * 1024) break;
        if (pack.files[id]) continue;
        const rec = await fileGet(id).catch(() => null);
        if (!rec) continue;
        pack.files[id] = { name: rec.name || id, data: await blobToB64(rec.blob) };
        bytes += rec.blob.size;
        n++;
      }
    }
    pack.withFiles = n;
  }

  const safe = safeName(S.char?.name);
  const stamp = new Date().toISOString().slice(0, 10);
  download(`${safe}-${stamp}.json`, JSON.stringify(pack));
  dataResult(`已导出 ${chats.length} 段对话、共 ${all.length} 条${withFiles ? "，含图片" : "，不含图片"}。API Key 不在文件里，换手机后要重填。`, "ok");
}

async function importData() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,application/json";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const data = unpack(JSON.parse(await f.text()));
      const total = data.chats.reduce((n, c) => n + c.msgs.length, 0);
      if (!confirm(`导入 ${data.chats.length} 段对话（共 ${total} 条）？会覆盖这台手机上现有的全部数据。`)) return;

      const keepKey = S.cfg.apiKey;
      await wipe();

      const list = [];
      for (const c of data.chats) {
        const id = uid();
        list.push({
          id, name: c.name, persona: c.persona, anchors: c.anchors,
          ts: Date.now(), count: c.msgs.length,
          last: (c.msgs[c.msgs.length - 1] || {}).text || "",
        });
        await kvSet(msgsKey(id), c.msgs);
        const branches = Array.isArray(c.branches) && c.branches.length ? c.branches : [c.msgs];
        await kvSet(branchesKey(id), branches);
        await kvSet(branchKey(id), Math.max(0, Math.min(Number(c.branchIdx) || 0, branches.length - 1)));
      }
      await kvSet(CHATS_KEY, list);
      await kvSet(ACTIVE_KEY, list[0] ? list[0].id : "");
      await kvSet("cfg", { ...DEFAULT_CFG, ...data.cfg, apiKey: keepKey });

      const files = Object.entries(data.files || {});
      for (const [id, rec] of files) {
        await filePut({ id, name: rec.name || id, blob: b64ToBlob(rec.data) });
      }
      dataResult(`导入完成：${list.length} 段对话、${total} 条消息${files.length ? "，" + files.length + " 张图片" : ""}。即将重新载入。`, "ok");
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      dataResult("导入失败：" + (e.message || e), "bad");
    }
  };
  inp.click();
}


async function hardReload() {
  const btn = $("#hardReload");
  btn.disabled = true;
  btn.textContent = "更新中…";
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        try { await r.update(); } catch {}
        await r.unregister();
      }
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}
  location.reload();
}


function scrollToMsg(idx) {
  const el = $("#stream");
  if (!el) return;
  if (idx < (S.showFrom || 0)) S.showFrom = Math.max(0, idx - 5);
  renderStream();
  requestAnimationFrame(() => {
    const node = el.querySelector(`[data-idx="${idx}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1400);
  });
}

function fullTime(ts) {
  if (!ts) return "刚刚";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function openTimeline() {
  const existing = document.querySelector(".timeline-drawer");
  if (existing) {
    existing.querySelector("#tlClose")?.click();
    return;
  }
  const sheet = document.createElement("div");
  sheet.className = "sheet timeline-drawer";
  const scrim = document.createElement("div");
  scrim.className = "timeline-scrim";
  document.body.appendChild(scrim);

  sheet.innerHTML = `
    <div class="shead">
      <span>时间线</span>
      <button class="icon" id="tlClose" aria-label="关闭">✕</button>
    </div>
    <div class="tl-tabs">
      <button class="on" data-view="msg">消息</button>
      <button data-view="img">图片</button>
    </div>
    <div class="sbody" id="tlBody"></div>`;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => { sheet.classList.add("on"); scrim.classList.add("on"); });

  const close = () => {
    sheet.classList.remove("on");
    scrim.classList.remove("on");
    setTimeout(() => { sheet.remove(); scrim.remove(); }, 240);
  };
  $("#tlClose").onclick = close;

  const renderMsgs = () => {
    const body = $("#tlBody");
    body.innerHTML = "";
    if (!S.msgs.length) {
      body.innerHTML = `<div class="hint">还没有消息</div>`;
      return;
    }
    let lastDay = "";
    S.msgs.forEach((m, i) => {
      if (!m.ts) return;
      const d = new Date(m.ts * 1000);
      const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (day !== lastDay) {
        const h = document.createElement("div");
        h.className = "tl-day";
        h.textContent = day;
        body.appendChild(h);
        lastDay = day;
      }
      const row = document.createElement("button");
      row.className = "tl-item";
      row.innerHTML = `<div class="tl-top"><b></b><time></time></div>
        <div class="tl-text"></div>`;
      row.querySelector("b").textContent = m.role === "user" ? "我" : (S.char.name || "她");
      row.querySelector("time").textContent = fullTime(m.ts);
      row.querySelector(".tl-text").textContent =
        (m.text || "").replace(/\\|\*\*|`|\*/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "（图片）";
      row.onclick = () => scrollToMsg(i);
      body.appendChild(row);
    });
  };

  const renderImgs = async () => {
    const body = $("#tlBody");
    body.innerHTML = "";
    const items = [];
    S.msgs.forEach((m, i) => (m.images || []).forEach((id) => items.push({ id, i, role: m.role, ts: m.ts })));
    if (!items.length) {
      body.innerHTML = `<div class="hint">还没有图片</div>`;
      return;
    }
    for (const it of items) {
      const row = document.createElement("button");
      row.className = "tl-img";
      row.innerHTML = `<img data-f="${it.id}" alt=""><div><b></b><time></time></div>`;
      row.querySelector("b").textContent = "来自 " + (it.role === "user" ? "我" : (S.char.name || "她"));
      row.querySelector("time").textContent = fullTime(it.ts);
      row.onclick = () => scrollToMsg(it.i);
      body.appendChild(row);
    }
    hydrateImages(body);
  };

  sheet.querySelectorAll(".tl-tabs button").forEach((b) => {
    b.onclick = () => {
      sheet.querySelectorAll(".tl-tabs button").forEach((x) => x.classList.toggle("on", x === b));
      if (b.dataset.view === "img") renderImgs(); else renderMsgs();
    };
  });
  renderMsgs();
}

function openSettings() {
  const existing = document.querySelector(".sheet.settings-sheet");
  if (existing) {
    existing.querySelector("#x")?.click();
    return;
  }
  const c = S.char, cfg = S.cfg;
  const sheet = document.createElement("div");
  sheet.className = "sheet settings-sheet";
  sheet.innerHTML = `
    <div class="shead"><span>设置</span><button class="icon" id="x">✕</button></div>
    <div class="sbody">
      <div class="field"><label>角色名</label><input id="fName" value="${esc(c.name || "")}"></div>
      <div class="field">
        <label>人设 / 系统提示</label>
        <textarea id="fPersona" placeholder="她是谁、怎么说话、和你是什么关系…">${esc(c.persona || "")}</textarea>
        <div class="hint">把你当初那段开场原样贴进来最好。没有的话写清：身份、说话习惯、对你的称呼、现在的关系进度。</div>
      </div>
      <div class="field">
        <label>记忆锚点</label>
        <textarea id="fAnchors" placeholder="一、我们在 3 月认识&#10;二、她讨厌被问「你是 AI 吗」&#10;三、上次聊到一半，约定下次讲完那个故事">${esc(c.anchors || "")}</textarea>
        <div class="hint">历史会被 token 预算切掉，切掉的部分只能靠这里记住。一行一条，只写事实。</div>
        <button class="btn ghost" id="btnDistill" style="margin-top:10px">从最近 60 条提炼锚点</button>
      </div>
      <div class="divider"></div>
      <div class="field"><label>API Key</label><input id="fKey" type="password" placeholder="${cfg.apiKey ? "已保存 " + cfg.apiKey.slice(-4) : "sk-..."}">
        <div class="hint">只存在这台手机。还没有 Key？<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">去开放平台创建</a>。建议用低额度 Key。</div>
      </div>
      <div class="field"><label>Base URL</label><input id="fBase" value="${esc(cfg.baseUrl)}">
        <div class="hint">官方填 https://api.deepseek.com；校园网关填到 /v1 为止。</div>
      </div>
      <div class="field">
        <label>模型</label>
        <div class="mrow">
          <select id="fModel"></select>
          <button class="mini" id="btnModels" type="button">读清单</button>
        </div>
        <input id="fModelCustom" placeholder="手填模型名" hidden>
        <div class="hint" id="modelHint">点「读清单」用你的 Key 拉一次 /models，能用的都会列进下拉。</div>
      </div>
      <div class="field"><label>思考模式</label>
        <select id="fThink">
          <option value="off">关闭 — 快，温度才生效</option>
          <option value="on">开启 — 先想再答，慢且贵</option>
          <option value="auto">跟随模型默认</option>
        </select>
      </div>
      <div class="field">
        <label>温度 temperature</label>
        <input id="fTemp" type="number" step="0.1" min="0" max="2" value="${cfg.temperature ?? 1.1}">
        <div class="hint">说话有多放得开。0.7 稳但容易车轱辘话，1.0–1.2 适合角色扮演，1.5 以上开始散。思考模式开着时这项不生效。</div>
      </div>
      <div class="field">
        <label>单条回复上限 max_tokens</label>
        <input id="fMax" type="number" step="1000" min="1" max="393216" value="${cfg.maxTokens ?? 8192}">
        <div class="hint">只决定这一条最多写多长，不影响记忆。</div>
      </div>
      <div class="field">
        <label>正文字号</label>
        <input id="fFont" type="number" min="12" max="20" step="1" value="${cfg.font || 15}">
        <div class="hint">只改聊天气里的字，不影响按钮。</div>
      </div>
      <div class="field">
        <label>上下文预算（输入 + 输出合计）</label>
        <input id="fBudget" type="number" step="10000" min="2000" max="1048576" value="${cfg.budget ?? 128000}">
        <div class="hint">每轮带多少历史，上限 1048576。装得越满越慢越贵，常见 6–20 万。</div>
      </div>
      <button class="btn" id="save">保存</button>
      <div class="divider"></div>
      <div class="hint" id="dataStatus">导入会覆盖本机现有对话，操作前建议先导出备份。</div>
      <button class="btn ghost" id="expBtn" style="margin-bottom:8px">导出数据（备份 / 换手机）</button>
      <button class="btn ghost" id="zipBtn" style="margin-bottom:8px">导出全部数据（ZIP，可再导入）</button>
      <button class="btn ghost" id="cardBtn" style="margin-bottom:8px">导出角色卡 JSON（酒馆用）</button>
      <button class="btn ghost" id="jsonlBtn" style="margin-bottom:8px">导出对话 JSONL</button>
      <button class="btn ghost" id="impBtn" style="margin-bottom:8px">从备份导入</button>
      <button class="btn ghost" id="hardReload" style="margin-bottom:8px">检查更新（清缓存重载）</button>
      <button class="btn danger" id="reset">清除数据，重新导入</button>
      <div class="hint" style="text-align:center">手机本地版 · 数据不经过任何服务器</div>
    </div>`;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add("on"));
  $("#fThink").value = cfg.thinking || "off";
  $("#x").onclick = () => { sheet.classList.remove("on"); setTimeout(() => sheet.remove(), 240); };

  $("#save").onclick = async () => {
    S.char = {
      ...c,
      name: $("#fName").value.trim() || c.name,
      persona: $("#fPersona").value,
      anchors: $("#fAnchors").value,
    };
    const key = $("#fKey").value.trim();
    S.cfg = {
      ...cfg,
      apiKey: key || cfg.apiKey,
      baseUrl: $("#fBase").value.trim() || cfg.baseUrl,
      model: $("#fModel").value === "__custom"
        ? ($("#fModelCustom").value.trim() || cfg.model)
        : ($("#fModel").value || cfg.model),
      thinking: $("#fThink").value,
      temperature: Number($("#fTemp").value) || 1.1,
      maxTokens: Math.round(Number($("#fMax").value) || 8192),
      budget: Math.round(Number($("#fBudget").value) || 128000),
      font: Math.min(20, Math.max(12, Math.round(Number($("#fFont").value) || 15))),
    };
    await saveActiveMsgs();
    await kvSet("cfg", S.cfg);
    applyFont();
    syncPills();
    $("#cname").textContent = S.char.name;
    $("#csub").textContent = `${S.msgs.length} 条 · ${S.char.persona ? "已设人设" : "还没设人设"}`;
    $("#x").click();
  };

  bindModelPicker(cfg);
  $("#btnDistill").onclick = distillAnchors;
  $("#zipBtn").onclick = exportZip;
  $("#cardBtn").onclick = exportCard;
  $("#jsonlBtn").onclick = exportJsonl;

  $("#expBtn").onclick = exportData;
  $("#impBtn").onclick = importData;
  const hasData = S.chats.length > 0 || S.msgs.length > 0;
  for (const id of ["#expBtn", "#zipBtn", "#cardBtn", "#jsonlBtn"]) {
    const b = $(id);
    if (b) b.disabled = !hasData;
  }

  $("#hardReload").onclick = hardReload;

  $("#reset").onclick = async () => {
    if (!confirm("清除手机上的全部对话和设置？这个操作不可恢复。")) return;
    await wipe();
    location.reload();
  };
}


/* ---------------------------------------------------------------- 离线 */

const secure = location.protocol === "https:" ||
  ["localhost", "127.0.0.1"].includes(location.hostname);

if ("serviceWorker" in navigator && secure) {
  navigator.serviceWorker.register("./sw.js").then(
    () => console.log("SW-OK"),
    (e) => console.log("SW-FAIL " + e.message)
  );
}

boot().catch((e) => {
  app.innerHTML = `<div class="intro"><div class="notice bad">启动失败：${esc(e.message || e)}</div></div>`;
});
