const $ = (s) => document.querySelector(s);
const S = {
  chars: [],
  char: null,
  messages: [],
  cfg: {},
  lan: "",
  port: 0,
  suggest: [],
  pending: [],
  startIdx: 0,
  controller: null,
  busy: false,
};

const api = async (path, opt = {}) => {
  const init = { method: opt.method || "GET" };
  if (opt.raw) {
    init.body = opt.raw;
    init.headers = { "Content-Type": "application/octet-stream" };
  } else if (opt.body) {
    init.body = JSON.stringify(opt.body);
    init.headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(path, init);
  const txt = await r.text();
  let data = {};
  try { data = JSON.parse(txt); } catch { data = { error: txt.slice(0, 300) }; }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}


/* ---------- 极简 Markdown：先转义再套结构，不执行任何 HTML ---------- */
const escapeHTML = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function mdToHtml(src) {
  if (!src) return "";
  let text = String(src).replace(/\r\n/g, "\n");
  const blocks = [];
  const inls = [];

  text = text.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push(`<pre class="md-pre"><code>${escapeHTML(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  text = text.replace(/`([^`\n]+)`/g, (m, code) => {
    inls.push(`<code class="md-code">${escapeHTML(code)}</code>`);
    return `\u0000I${inls.length - 1}\u0000`;
  });

  text = escapeHTML(text);

  text = text
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const lines = text.split("\n");
  const out = [];
  let i = 0;
  const isBlock = (l) =>
    /^\s*$/.test(l) || /^\u0000B\d+\u0000\s*$/.test(l) || /^\s*#{1,6}\s+/.test(l) ||
    /^\s*(?:&gt;|>)/.test(l) || /^\s*([-*+])\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    const bm = line.match(/^\u0000B(\d+)\u0000\s*$/);
    if (bm) { out.push(blocks[+bm[1]]); i++; continue; }

    if (/^\s*#{1,6}\s+/.test(line)) {
      const lv = Math.min(line.match(/^\s*(#{1,6})\s+/)[1].length + 2, 6);
      out.push(`<h${lv} class="md-h">${line.replace(/^\s*#{1,6}\s+/, "")}</h${lv}>`);
      i++; continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }

    if (/^\s*(?:&gt;|>)\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*(?:&gt;|>)\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*(?:&gt;|>)\s?/, "")); i++;
      }
      out.push(`<blockquote class="md-quote">${buf.join("<br>")}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i])) {
        buf.push(`<li>${lines[i].replace(/^\s*([-*+])\s+/, "")}</li>`); i++;
      }
      out.push(`<ul class="md-ul">${buf.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        buf.push(`<li>${lines[i].replace(/^\s*\d+[.)]\s+/, "")}</li>`); i++;
      }
      out.push(`<ol class="md-ol">${buf.join("")}</ol>`);
      continue;
    }

    const buf = [];
    while (i < lines.length && !isBlock(lines[i])) { buf.push(lines[i]); i++; }
    if (buf.length) out.push(`<p class="md-p">${buf.join("<br>")}</p>`);
  }

  let html = out.join("");
  html = html.replace(/\u0000I(\d+)\u0000/g, (m, n) => inls[+n]);
  html = html.replace(/\u0000B(\d+)\u0000/g, (m, n) => blocks[+n]);
  return html;
}

function renderRich(el, text, streaming) {
  el.innerHTML = mdToHtml(text);
  if (streaming) {
    const c = document.createElement("span");
    c.className = "caret";
    el.appendChild(c);
  }
}

function syncKeyChip() {
  const b = $("#btnKey");
  if (b) b.hidden = !!(S.cfg && S.cfg.key_set);
}
const fmtTime = (ts) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  if (isNaN(d)) return "";
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

/* ---------------------------------------------------------------- boot */

async function boot() {
  const d = await api("/api/boot");
  S.chars = d.chars;
  S.cfg = d.config;
  S.lan = d.lan;
  S.port = d.port;
  S.suggest = d.suggest_dirs || [];
  renderChars();
  syncKeyChip();
  if (S.chars.length) await openChar(S.chars[0].id);

  const ui = new URLSearchParams(location.search).get("ui");
  if (ui === "settings") openSettings(new URLSearchParams(location.search).get("tab") || "");
  else if (ui === "import") openImport();
}

function renderChars() {
  const box = $("#charList");
  box.innerHTML = "";
  if (!S.chars.length) {
    const d = document.createElement("div");
    d.className = "side-empty";
    d.innerHTML = `<div class="se-t">还没有角色</div>
      <div class="se-h">点下面「导入」，把旧对话搬进来。<br>第一次用先去「设置」填 API Key。</div>`;
    box.appendChild(d);
    return;
  }
  for (const c of S.chars) {
    const b = document.createElement("button");
    b.className = "char-item" + (S.char && S.char.id === c.id ? " on" : "");
    b.innerHTML = `<div class="cn"><b></b><span></span></div><div class="cl"></div>`;
    b.querySelector("b").textContent = c.name;
    b.querySelector("span").textContent = c.count ? c.count + " 条" : "空";
    b.querySelector(".cl").textContent = c.last || "还没有对话";
    b.onclick = () => { openChar(c.id); closeSide(); };
    box.appendChild(b);
  }
}

async function openChar(id) {
  const d = await api("/api/char?id=" + encodeURIComponent(id));
  S.char = d.char;
  S.messages = d.messages;
  S.startIdx = Math.max(0, S.messages.length - 40);
  $("#topName").textContent = S.char.name;
  $("#topSub").textContent = `${S.messages.length} 条 · ${S.char.persona ? "已设人设" : "没设人设"}`;
  $("#btnSettings").disabled = false;
  renderChars();
  renderStream();
}

/* ---------------------------------------------------------------- 消息渲染 */

function msgNode(m, opts = {}) {
  const isUser = m.role === "user";
  const wrap = document.createElement("div");
  wrap.className = "msg " + (isUser ? "msg-user" : "msg-ai");

  if (!isUser) {
    const av = document.createElement("div");
    av.className = "av";
    wrap.appendChild(av);
  }

  const body = document.createElement("div");
  body.className = "body";

  if (m.reasoning) {
    const det = document.createElement("details");
    det.className = "think";
    const sum = document.createElement("summary");
    sum.textContent = "思考过程";
    const tb = document.createElement("div");
    tb.className = "think-body";
    tb.textContent = m.reasoning;
    det.append(sum, tb);
    body.appendChild(det);
  }

  const t = document.createElement("div");
  t.className = "text";
  t.innerHTML = mdToHtml(m.text || "");
  body.appendChild(t);

  if (m.images && m.images.length) {
    const box = document.createElement("div");
    box.className = "imgs";
    for (const name of m.images) {
      const img = document.createElement("img");
      img.src = `/api/file?char=${encodeURIComponent(S.char.id)}&name=${encodeURIComponent(name)}`;
      img.alt = name;
      img.onclick = () => window.open(img.src, "_blank");
      box.appendChild(img);
    }
    body.appendChild(box);
  }

  if (m.files && m.files.length) {
    const box = document.createElement("div");
    box.className = "filechips";
    for (const f of m.files) {
      const a = document.createElement("a");
      a.className = "filechip";
      a.textContent = f.t || f.n;
      a.href = `/api/file?char=${encodeURIComponent(S.char.id)}&name=${encodeURIComponent(f.n)}`;
      a.download = f.t || f.n;
      box.appendChild(a);
    }
    body.appendChild(box);
  }

  if (m.ts || !isUser || opts.canRegen) {
    const meta = document.createElement("div");
    meta.className = "meta-line";
    const tm = document.createElement("span");
    tm.textContent = fmtTime(m.ts);
    meta.appendChild(tm);
    if (opts.canRegen) {
      const b = document.createElement("button");
      b.className = "regen";
      b.textContent = "重新生成";
      b.onclick = regenerate;
      meta.appendChild(b);
    }
    body.appendChild(meta);
  }

  wrap.appendChild(body);
  if (opts.typing) t.classList.add("typing");
  return wrap;
}

function renderStream() {
  const el = $("#stream");
  el.innerHTML = "";
  if (!S.char) {
    el.appendChild(emptyBlock());
    return;
  }
  const inner = document.createElement("div");
  inner.className = "stream-inner";

  if (S.startIdx > 0) {
    const w = document.createElement("div");
    w.className = "more-wrap";
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = `载入更早的 ${Math.min(40, S.startIdx)} 条`;
    b.onclick = () => {
      const prevH = el.scrollHeight;
      S.startIdx = Math.max(0, S.startIdx - 40);
      renderStream();
      el.scrollTop = el.scrollHeight - prevH;
    };
    w.appendChild(b);
    inner.appendChild(w);
  }

  for (let i = S.startIdx; i < S.messages.length; i++) {
    const last = i === S.messages.length - 1;
    inner.appendChild(msgNode(S.messages[i], { canRegen: last && S.messages[i].role === "assistant" }));
  }
  el.appendChild(inner);
  el.scrollTop = el.scrollHeight;
}

function emptyBlock() {
  const d = document.createElement("div");
  d.className = "empty";
  d.innerHTML = `<div class="empty-t">这里还没有人</div>
    <p>左边「导入」可以吃掉 DeepSeek 导出的 ZIP，也可以直接粘一段带 <code>## User</code> / <code>## Assistant</code> 分节的 Markdown。</p>
    <p class="empty-hint">人设和记忆锚点写在「设置」里，每轮都会带在最前面。</p>`;
  return d;
}

function appendMsg(m) {
  let inner = $("#stream .stream-inner");
  if (!inner) {
    $("#stream").innerHTML = "";
    inner = document.createElement("div");
    inner.className = "stream-inner";
    $("#stream").appendChild(inner);
  }
  const node = msgNode(m);
  inner.appendChild(node);
  $("#stream").scrollTop = $("#stream").scrollHeight;
  return node;
}

/* ---------------------------------------------------------------- 发送 */

async function send() {
  if (S.busy) return;
  if (!S.char) {
    toast("还没有角色。先「新建」或「导入」，再说话。");
    return openNew();
  }

  const input = $("#input");
  const text = input.value.trim();
  if (!text && !S.pending.length) return;

  const images = S.pending.slice();
  S.pending = [];
  renderAttach();
  input.value = "";
  autoGrow(input);

  const userMsg = { role: "user", text, ts: Date.now() / 1000, images };
  S.messages.push(userMsg);
  appendMsg(userMsg);

  await runStream({ char: S.char.id, text, images });
}

async function regenerate() {
  if (S.busy || !S.char) return;
  while (S.messages.length && S.messages[S.messages.length - 1].role !== "user") S.messages.pop();
  if (!S.messages.length) return;
  renderStream();
  await runStream({ char: S.char.id, regenerate: true });
}

async function runStream(payload) {
  const holder = { role: "assistant", text: "", ts: Date.now() / 1000, images: [] };
  const node = appendMsg(holder);
  const textEl = node.querySelector(".text");
  const bodyEl = node.querySelector(".body");

  // 思考过程实时可见：网关和 V4.1-Flash 都会先吐 reasoning_content，
  // 不显示的话用户会以为没反应。
  let thinkEl = null;
  let thinkBody = null;
  let reasoning = "";
  const setMeta = (t) => { $("#composerMeta").textContent = t; };

  const showThink = (piece) => {
    if (!thinkEl) {
      thinkEl = document.createElement("details");
      thinkEl.className = "think live";
      thinkEl.open = true;
      thinkEl.innerHTML = '<summary>思考中…</summary><div class="think-body"></div>';
      thinkBody = thinkEl.querySelector(".think-body");
      bodyEl.insertBefore(thinkEl, textEl);
    }
    reasoning += piece || "";
    thinkBody.textContent = reasoning.length > 2000 ? "…" + reasoning.slice(-2000) : reasoning;
    thinkBody.scrollTop = thinkBody.scrollHeight;
    thinkEl.querySelector("summary").textContent = `思考中… ${reasoning.length} 字`;
  };

  const foldThink = () => {
    if (!thinkEl) return;
    thinkEl.open = false;
    thinkEl.querySelector("summary").textContent = `思考过程（${reasoning.length} 字）`;
  };

  S.busy = true;
  $("#btnSend").hidden = true;
  $("#btnStop").hidden = false;
  S.controller = new AbortController();

  let started = false;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: S.controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = txt;
      try { msg = JSON.parse(txt).error || txt; } catch {}
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = "";
    let queued = false;
    const paint = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; renderRich(textEl, acc, true); });
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (ev.type === "meta") {
          started = true;
          setMeta(`本次送出 ${ev.sent} 条历史 · ≈${ev.tokens} tokens · ${ev.model} · 等首字…`);
        } else if (ev.type === "delta") {
          if (!acc) {
            foldThink();
            setMeta("");
          }
          acc += ev.text;
          paint();
          const el = $("#stream");
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 140) el.scrollTop = el.scrollHeight;
        } else if (ev.type === "think") {
          if (!started) started = true;
          showThink(ev.text);
          setMeta("模型在思考，正文马上来…");
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        } else if (ev.type === "end") {
          if (ev.text) { acc = ev.text; paint(); }
        }
      }
    }

    if (!acc.trim()) {
      textEl.textContent = "（空回复）";
    } else {
      renderRich(textEl, acc, false);
      holder.text = acc;
      S.messages.push(holder);
      const meta = document.createElement("div");
      meta.className = "meta-line";
      const tm = document.createElement("span");
      tm.textContent = fmtTime(holder.ts);
      const rb = document.createElement("button");
      rb.className = "regen";
      rb.textContent = "重新生成";
      rb.onclick = regenerate;
      holder.reasoning = reasoning.slice(0, 4000);
      meta.append(tm, rb);
      node.querySelector(".body").appendChild(meta);
    }
  } catch (e) {
    const isAbort = e.name === "AbortError";
    if (isAbort && acc.trim()) {
      renderRich(textEl, acc, false);
      holder.text = acc;
      S.messages.push(holder);
    } else {
      textEl.textContent = "";
      const n = document.createElement("div");
      n.className = "notice bad";
      n.textContent = isAbort ? "已停止。这条没存下来。" : "出错了：" + e.message;
      node.querySelector(".body").appendChild(n);
      if (!textEl.textContent) node.style.opacity = ".9";
    }
  } finally {
    S.busy = false;
    S.controller = null;
    $("#btnSend").hidden = false;
    $("#btnStop").hidden = true;
    const cs = S.chars.find((c) => c.id === S.char.id);
    if (cs) {
      cs.count = S.messages.length;
      cs.last = (S.messages[S.messages.length - 1] || {}).text || "";
      cs.updated = Date.now() / 1000;
      renderChars();
    }
    $("#topSub").textContent = `${S.messages.length} 条 · ${S.char.persona ? "已设人设" : "没设人设"}`;
    $("#input").focus();
  }
}

/* ---------------------------------------------------------------- 附件 */

function renderAttach() {
  const row = $("#attachRow");
  row.innerHTML = "";
  S.pending.forEach((name, i) => {
    const d = document.createElement("div");
    d.className = "attach-chip";
    const img = document.createElement("img");
    img.src = `/api/file?char=${encodeURIComponent(S.char.id)}&name=${encodeURIComponent(name)}`;
    const x = document.createElement("button");
    x.textContent = "×";
    x.onclick = () => { S.pending.splice(i, 1); renderAttach(); };
    d.append(img, x);
    row.appendChild(d);
  });
}

$("#btnAttach").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = async (e) => {
  if (!S.char) { toast("先建一个角色，图片才有地方放"); return; }
  for (const f of e.target.files) {
    const r = await fetch(`/api/upload?char=${encodeURIComponent(S.char.id)}&name=${encodeURIComponent(f.name)}`, {
      method: "POST",
      body: f,
    });
    if (r.ok) {
      const d = await r.json();
      S.pending.push(d.name);
    }
  }
  e.target.value = "";
  renderAttach();
};

/* ---------------------------------------------------------------- 弹层 */

const modal = $("#modal");
const sheet = $("#sheet");
function openModal(html) {
  sheet.innerHTML = html;
  modal.hidden = false;
}
function closeModal() { modal.hidden = true; sheet.innerHTML = ""; }
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
$("#modalX").onclick = closeModal;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closeModal();
});

/* ---------------- 新建 */

function openNew() {
  closeSide();
  openModal(`
    <h2>新建一个角色</h2>
    <div class="sub">名字先随便起，人设可以之后在设置里慢慢写。</div>
    <div class="field"><label>名字</label><input type="text" id="nName" placeholder="她的名字"></div>
    <div class="actions">
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="nOk">创建</button>
    </div>`);
  sheet.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModal));
  $("#nName").focus();
  $("#nOk").onclick = async () => {
    const name = $("#nName").value.trim() || "新的她";
    try {
      const d = await api("/api/char", { method: "POST", body: { name } });
      closeModal();
      await boot();
      await openChar(d.char.id);
      openSettings();
    } catch (e) { toast(e.message); }
  };
}

/* ---------------- 设置 */

function apiFieldsHTML(p, cfg) {
  return `
    <div class="field">
      <label>API Key</label>
      <input type="password" id="${p}Key" placeholder="${cfg.key_set ? "已保存 · 尾号 " + cfg.key_tail + "（留空不改）" : "sk-..."}">
      <div class="hint">存在本机 data/config.json，只走服务端直连，不经过浏览器存储。还没有 Key？<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">去开放平台创建</a>。</div>
    </div>

    <div class="field">
      <label>模型</label>
      <div class="row-inline">
        <select id="${p}Model"></select>
        <button class="btn" id="${p}ModelsBtn" type="button">读取清单</button>
      </div>
      <input type="text" id="${p}ModelCustom" class="model-custom" placeholder="填网关文档里给的模型名" spellcheck="false" hidden>
      <div class="hint" id="${p}ModelsHint">不用记模型名。填好 Key 之后点「读取清单」，这个账号能用的会全部列进下拉；拉不到就选「手动输入」自己填。</div>
    </div>

    <div class="field">
      <label>思考模式</label>
      <select id="${p}Thinking">
        <option value="auto">跟随模型默认 — DeepSeek 默认开启思考</option>
        <option value="off">关闭 — 快、稳，温度才生效</option>
        <option value="on">开启 — 会先想一段再答，慢且贵</option>
      </select>
      <div class="hint">V4.1-Flash 默认开着思考，回复前先写一段推理，这些字算在输出里、也一起计费。跟随默认就是交给模型自己定；想让温度真的起作用、回复更快一点，选「关闭」。</div>
    </div>

    <div class="row2">
      <div class="field">
        <label>温度 temperature</label>
        <input type="number" id="${p}Temp" step="0.1" min="0" max="2" value="${cfg.temperature}">
        <div class="hint">说话有多「放得开」。0.7 稳但容易车轱辘话；1.0–1.2 适合角色扮演；1.5 以上开始胡言乱语、逻辑散。思考模式开着时这项不生效（官方行为）。</div>
      </div>
      <div class="field">
        <label>单条回复上限 max_tokens</label>
        <input type="number" id="${p}Max" step="1000" min="1" max="393216" value="${cfg.max_tokens}">
        <div class="hint">只决定这一条最多写多长，不影响记忆。上限 393216（384K）。填大了不额外花钱，只按实际字数计费。</div>
      </div>
    </div>

    <div class="field">
      <label>上下文预算（输入 + 输出合计）</label>
      <input type="number" id="${p}Budget" step="10000" min="2000" max="1048576" value="${cfg.context_budget}">
      <div class="hint">每轮真正带上的历史有多少，上限 1048576（1M）。装得越满越慢越贵，她也容易「记得太多反而没重点」：6 万够几十轮，20 万以上给长线角色。会用这个数先扣掉上面那条回复的额度。</div>
      <div class="presets" data-preset="${p}Budget">
        <button type="button" data-v="60000">6 万</button>
        <button type="button" data-v="131072">13 万</button>
        <button type="button" data-v="262144">26 万</button>
        <button type="button" data-v="524288">52 万</button>
        <button type="button" data-v="1048576">1M</button>
      </div>
    </div>

    <details class="adv">
      <summary>Base URL（一般不用动）</summary>
      <div class="field" style="margin-top:8px">
        <input type="text" id="${p}Base" value="${esc(cfg.base_url)}">
        <div class="hint">换中转或自建网关时改这里，必须是 OpenAI 兼容接口：能拼出 /chat/completions 和 /models。</div>
      </div>
    </details>`;
}

function fillModelSelect(p, models, current) {
  const sel = $(`#${p}Model`);
  if (!sel) return;
  const ids = (models || []).map((m) => m.id).filter(Boolean);
  if (current && !ids.includes(current)) ids.unshift(current);
  sel.innerHTML = "";
  ids.forEach((id) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id;
    sel.appendChild(o);
  });
  const c = document.createElement("option");
  c.value = "__custom";
  c.textContent = "＋ 手动输入其他模型";
  sel.appendChild(c);
  sel.value = current && ids.includes(current) ? current : (ids[0] || "__custom");
  const box = $(`#${p}ModelCustom`);
  if (box) box.hidden = sel.value !== "__custom";
  sel.onchange = () => {
    const b = $(`#${p}ModelCustom`);
    if (!b) return;
    b.hidden = sel.value !== "__custom";
    if (!b.hidden) b.focus();
  };
}

function bindApiFields(p, cfg) {
  const sel = $(`#${p}Thinking`);
  if (sel) sel.value = cfg.thinking || "off";
  fillModelSelect(p, [], cfg.model);

  const pre = sheet.querySelector(`.presets[data-preset="${p}Budget"]`);
  if (pre) {
    pre.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        $(`#${p}Budget`).value = b.dataset.v;
        pre.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      };
    });
  }

  const btn = $(`#${p}ModelsBtn`);
  if (!btn) return;
  btn.onclick = async () => {
    const key = $(`#${p}Key`).value.trim();
    const base = $(`#${p}Base`).value.trim();
    if (!key && !cfg.key_set) return toast("先填 API Key，再读清单");
    btn.disabled = true;
    btn.textContent = "读取中…";
    try {
      const d = await api("/api/models", { method: "POST", body: { api_key: key, base_url: base } });
      const list = d.models || [];
      const cur = $(`#${p}Model`).value === "__custom"
        ? ($(`#${p}ModelCustom`).value.trim() || cfg.model)
        : $(`#${p}Model`).value;
      fillModelSelect(p, list, cur);
      const lim = list.filter((m) => m.max_output_tokens).length;
      $(`#${p}ModelsHint`).textContent = list.length
        ? `读到 ${list.length} 个模型${lim ? `，${lim} 个带长度信息` : ""}。点模型输入框会出下拉。`
        : "接口通了但没返回模型，手填吧。";
      if (list.length === 1) $(`#${p}Model`).value = list[0].id;
      toast(list.length ? `读到 ${list.length} 个模型` : "清单是空的");
    } catch (e) {
      toast(e.message);
      $(`#${p}ModelsHint`).textContent = "读不到清单，直接手填模型名也行。";
    } finally {
      btn.disabled = false;
      btn.textContent = "读取清单";
    }
  };
}

function cfg_model_fallback(p) {
  return (S.cfg && S.cfg.model) || "deepseek-flash";
}

function readApiFields(p) {
  const num = (id, fb) => {
    const v = parseFloat($(`#${id}`).value);
    return Number.isFinite(v) ? v : fb;
  };
  return {
    api_key: $(`#${p}Key`).value.trim(),
    base_url: $(`#${p}Base`).value.trim(),
    model: $(`#${p}Model`).value === "__custom"
      ? ($(`#${p}ModelCustom`).value.trim() || cfg_model_fallback(p))
      : $(`#${p}Model`).value,
    temperature: num(`${p}Temp`, 1.1),
    max_tokens: Math.round(num(`${p}Max`, 8192)),
    context_budget: Math.round(num(`${p}Budget`, 131072)),
    thinking: $(`#${p}Thinking`).value,
  };
}

function openSettings(tab) {
  closeSide();
  if (!S.char) return openGlobalSettings();
  const c = S.char;
  const cfg = S.cfg;
  openModal(`
    <h2>${esc(c.name)}</h2>
    <div class="sub">人设和锚点每轮都会带在上下文最前面，所以写得越具体，她越像她。</div>
    <div class="tabs">
      <button class="on" data-tab="t1">人设</button>
      <button data-tab="t2">记忆</button>
      <button data-tab="t3">接口</button>
      <button data-tab="t4">数据</button>
    </div>

    <div data-pane="t1">
      <div class="field">
        <label>名字</label>
        <input type="text" id="sName" value="${esc(c.name)}">
      </div>
      <div class="field">
        <label>人设 / 系统提示</label>
        <textarea id="sPersona" style="min-height:220px" placeholder="她是谁、怎么说话、和你是什么关系…">${esc(c.persona)}</textarea>
        <div class="hint">把你当初在 DeepSeek 里那段开场原样贴进来最好。没有的话，就写清：身份、说话习惯、对你的称呼、现在的关系进度。</div>
      </div>
    </div>

    <div data-pane="t2" hidden>
      <div class="field">
        <label>记忆锚点</label>
        <textarea id="sAnchors" style="min-height:220px" placeholder="一、我们在 3 月认识&#10;二、她讨厌被问「你是 AI 吗」&#10;三、上次聊到一半，约定下次讲完那个故事">${esc(c.anchors)}</textarea>
        <div class="hint">历史一旦被 token 预算切掉，被切掉的就不存在了。这里写的是「不能忘的事实」，一行一条，别写形容词。</div>
      </div>
      <div class="field">
        <button class="btn" id="sDistill">从最近 60 轮提炼锚点</button>
        <div class="hint">调一次模型，把最近的对话压成事实条目，追加到上面的框里。生成完自己删一遍——它偶尔会把剧情当事实写进来。</div>
      </div>
    </div>

    <div data-pane="t3" hidden>
      ${apiFieldsHTML("s", cfg)}
    </div>

    <div data-pane="t4" hidden>
      <p class="hint" style="margin-top:0">全部数据都在 <code>data/chars/${esc(c.id)}/</code>：人设是 char.json，对话是 messages.json，图在 files/。复制这个文件夹就是完整备份。</p>
      <div class="field"><button class="btn" id="sExport">导出角色包（zip，含附件）</button></div>
      <div class="field"><button class="btn" id="sCard">导出角色卡 · JSON（SillyTavern V2）</button></div>
      <div class="field"><button class="btn" id="sJsonl">导出对话 · JSONL（酒馆可直接导入）</button></div>
      <div class="field"><button class="btn danger" id="sDelete">删除这个角色</button></div>
    </div>

    <div class="actions">
      <button class="btn" data-close>关闭</button>
      <button class="btn primary" id="sSave">保存</button>
    </div>`);

  sheet.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModal));
  const tabs = sheet.querySelectorAll(".tabs button");
  tabs.forEach((t) => (t.onclick = () => {
    tabs.forEach((x) => x.classList.toggle("on", x === t));
    sheet.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.tab));
  }));
  bindApiFields("s", cfg);
  if (tab) {
    const tb = sheet.querySelector(`.tabs button[data-tab="${tab}"]`);
    if (tb) tb.click();
  }

  $("#sExport").onclick = () => window.open("/api/export?id=" + encodeURIComponent(c.id), "_blank");
  $("#sCard").onclick = () => window.open("/api/export/card?id=" + encodeURIComponent(c.id), "_blank");
  $("#sJsonl").onclick = () => window.open("/api/export/jsonl?id=" + encodeURIComponent(c.id), "_blank");

  $("#sDistill").onclick = async () => {
    const btn = $("#sDistill");
    btn.disabled = true;
    btn.textContent = "提炼中…";
    try {
      const d = await api("/api/memory/distill", { method: "POST", body: { char: c.id, rounds: 60 } });
      const ta = $("#sAnchors");
      ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + d.text;
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "从最近 60 轮提炼锚点";
    }
  };
  $("#sDelete").onclick = async () => {
    if (!confirm(`确定删掉「${c.name}」？这个操作不会进回收站。`)) return;
    await api("/api/char?id=" + encodeURIComponent(c.id), { method: "DELETE" });
    closeModal();
    S.char = null; S.messages = [];
    await boot();
  };

  $("#sSave").onclick = async () => {
    try {
      const d = await api("/api/char", {
        method: "PUT",
        body: { id: c.id, name: $("#sName").value, persona: $("#sPersona").value, anchors: $("#sAnchors").value },
      });
      await api("/api/config", {
        method: "POST",
        body: readApiFields("s"),
      });
      S.char = d.char;
      const b = await api("/api/boot");
      S.cfg = b.config;
      syncKeyChip();
      $("#topName").textContent = S.char.name;
      $("#topSub").textContent = `${S.messages.length} 条 · ${S.char.persona ? "已设人设" : "没设人设"}`;
      renderChars();
      closeModal();
    } catch (e) { toast(e.message); }
  };
}

function openGlobalSettings() {
  const cfg = S.cfg;
  openModal(`
    <h2>设置</h2>
    <div class="sub">还没有角色，所以这里只有全局的接口配置。人设和记忆是按角色存的。</div>
    <div class="notice">先在左下角「新建」或「导入」建一个角色，那两页才有地方写。</div>
    ${apiFieldsHTML("g", cfg)}
    <div class="actions">
      <button class="btn" data-close>关闭</button>
      <button class="btn primary" id="gSave">保存</button>
    </div>`);

  sheet.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModal));
  bindApiFields("g", cfg);
  $("#gSave").onclick = async () => {
    try {
      await api("/api/config", {
        method: "POST",
        body: readApiFields("g"),
      });
      const b = await api("/api/boot");
      S.cfg = b.config;
      syncKeyChip();
      $("#gSave").textContent = "已保存";
      setTimeout(closeModal, 480);
    } catch (e) { toast(e.message); }
  };
}

/* ---------------- 导入 */

function openImport() {
  closeSide();
  const hint = S.suggest.length ? S.suggest[0] : "";
  openModal(`
    <h2>导入一段旧对话</h2>
    <div class="sub">导入会新建一个角色，不动现有的。</div>
    <div class="tabs">
      <button class="on" data-tab="d">本地文件夹</button>
      <button data-tab="z">ZIP</button>
      <button data-tab="m">Markdown / 文本</button>
    </div>

    <div data-pane="d">
      <div class="field">
        <label>解压出来的导出目录</label>
        <input type="text" id="dPath" value="${esc(hint)}" placeholder="D:\\...\\deepseek_data-2026-11-17">
        <div class="hint">解压后的那个 deepseek_data-xxxx 文件夹。服务端直接读盘，不用把 300MB 再从浏览器传一遍。附件原图也在里面，会一起搬过来。</div>
      </div>
      <button class="btn primary" id="dScan">扫描这个目录</button>
      <div id="convBoxD" style="margin-top:14px"></div>
    </div>

    <div data-pane="z" hidden>
      <div class="drop" id="drop">
        <div><b>选一个 ZIP</b>，或把文件拖到这里</div>
        <div class="hint">包小的话走这条。大包建议左边用文件夹，省内存。</div>
      </div>
      <input type="file" id="zipInput" accept=".zip" hidden>
      <div id="convBox" style="margin-top:14px"></div>
    </div>

    <div data-pane="m" hidden>
      <div class="field">
        <label>角色名</label>
        <input type="text" id="mName" placeholder="留空就用默认">
      </div>
      <div class="field">
        <label>粘进来</label>
        <textarea id="mText" style="min-height:200px" placeholder="## User&#10;……&#10;&#10;## Assistant&#10;……"></textarea>
        <div class="hint">支持 <code>## User</code> / <code>## Assistant</code> 分节，也支持每行开头的「用户:」「助手:」。</div>
      </div>
      <div class="actions">
        <button class="btn primary" id="mOk">导入</button>
      </div>
    </div>`);

  const tabs = sheet.querySelectorAll(".tabs button");
  tabs.forEach((t) => (t.onclick = () => {
    tabs.forEach((x) => x.classList.toggle("on", x === t));
    sheet.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.tab));
  }));

  $("#dScan").onclick = async () => {
    const box = $("#convBoxD");
    const p = $("#dPath").value.trim();
    if (!p) return toast("先填解压后的目录路径。把 ZIP 解压在工作区里，会自动填上。");
    box.innerHTML = `<div class="hint">读盘中…</div>`;
    try {
      const d = await api("/api/import/scan_dir", { method: "POST", body: { path: p } });
      renderConvList(box, d);
    } catch (e) {
      box.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
    }
  };

  const zipInput = $("#zipInput");
  const drop = $("#drop");
  drop.onclick = () => zipInput.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = "var(--accent)"; };
  drop.ondragleave = () => { drop.style.borderColor = ""; };
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.style.borderColor = "";
    if (e.dataTransfer.files[0]) scanZip(e.dataTransfer.files[0]);
  };
  zipInput.onchange = () => zipInput.files[0] && scanZip(zipInput.files[0]);

  $("#mOk").onclick = async () => {
    const text = $("#mText").value;
    if (!text.trim()) return;
    try {
      const d = await api("/api/import/text", {
        method: "POST",
        body: { text, name: $("#mName").value.trim() },
      });
      closeModal();
      await boot();
      await openChar(d.char.id);
      openSettings();
    } catch (e) { toast(e.message); }
  };
}

async function scanZip(file) {
  const box = $("#convBox");
  box.innerHTML = `<div class="hint">正在解包…（大包会慢一点）</div>`;
  try {
    const r = await fetch("/api/import/scan", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "解析失败");
    renderConvList(box, d);
  } catch (e) {
    box.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  }
}

function renderConvList(box, d) {
  const old = box.querySelector("#applyBox");
  if (old) old.remove();
  const items = d.items.slice(0, 60);
  box.innerHTML = `<div class="hint">找到 ${d.total} 段对话，按条数排序。挑你要的那段：</div>`;

  items.forEach((it) => {
    const b = document.createElement("button");
    b.className = "conv-item";
    b.innerHTML = `<div class="ct"><b></b><span></span></div><div class="cp"></div>`;
    b.querySelector("b").textContent = it.title;
    b.querySelector("span").textContent = it.count + " 条" + (it.files ? ` · ${it.files} 附件` : "");
    b.querySelector(".cp").textContent = it.preview;
    b.onclick = () => {
      box.querySelectorAll(".conv-item").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      showApply(box, d.token, it);
    };
    box.appendChild(b);
  });

  if (d.total > items.length) {
    const more = document.createElement("div");
    more.className = "hint";
    more.textContent = `其余 ${d.total - items.length} 段没列出来（多半很短），真要找可以用文本导入。`;
    box.appendChild(more);
  }
}

function showApply(box, token, it) {
  const old = box.querySelector("#applyBox");
  if (old) old.remove();
  const f = document.createElement("div");
  f.id = "applyBox";
  f.style.marginTop = "14px";
  f.innerHTML = `
    <div class="notice">已选「${esc(it.title)}」· ${it.count} 条${it.files ? " · " + it.files + " 个附件" : ""}。下面两项会被预填，之后随时能改。</div>
    <div class="field"><label>角色名</label><input type="text" id="aName"></div>
    <div class="field"><label>人设（默认取第一句用户消息）</label><textarea id="aPersona" style="min-height:120px"></textarea></div>
    <div class="actions">
      <button class="btn" id="aCancel">换一段</button>
      <button class="btn primary" id="aOk">导入并打开</button>
    </div>`;
  f.querySelector("#aName").value = it.title;
  f.querySelector("#aPersona").value = it.first_user || "";
  f.querySelector("#aCancel").onclick = () => f.remove();
  f.querySelector("#aOk").onclick = async () => {
    const btn = f.querySelector("#aOk");
    btn.disabled = true;
    btn.textContent = it.files ? "导入中（附件要搬一会儿）…" : "导入中…";
    try {
      const r2 = await api("/api/import/apply", {
        method: "POST",
        body: {
          token,
          idx: it.idx,
          name: f.querySelector("#aName").value.trim(),
          persona: f.querySelector("#aPersona").value,
        },
      });
      closeModal();
      await boot();
      await openChar(r2.char.id);
      openSettings();
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      btn.textContent = "导入并打开";
    }
  };
  box.appendChild(f);
  f.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------------------------------------------------------- 交互绑定 */

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}
$("#input").addEventListener("input", (e) => autoGrow(e.target));
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$("#btnSend").onclick = send;
$("#btnStop").onclick = () => S.controller && S.controller.abort();
$("#btnNew").onclick = openNew;
$("#btnImport").onclick = openImport;
$("#btnSettings").onclick = openSettings;
$("#btnKey").onclick = () => openSettings("t3");

const side = $("#side");
const sideMask = $("#sideMask");
function openSide() {
  side.classList.add("open");
  sideMask.hidden = false;
}
function closeSide() {
  side.classList.remove("open");
  sideMask.hidden = true;
}
$("#btnSide").onclick = () => (side.classList.contains("open") ? closeSide() : openSide());
$("#btnSideClose").onclick = closeSide;
sideMask.onclick = closeSide;

$("#btnLan").onclick = async () => {
  const url = `http://${S.lan}:${S.port}`;
  try {
    await navigator.clipboard.writeText(url);
    $("#btnLan").textContent = "已复制：" + url;
  } catch {
    prompt("手机在同一个 Wi-Fi 下打开：", url);
  }
  setTimeout(() => ($("#btnLan").textContent = "手机访问"), 2600);
};

boot().catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;font:14px/1.7 system-ui">连不上本地服务：${esc(e.message)}<br><br>确认 app.py 还在跑。</div>`;
});
