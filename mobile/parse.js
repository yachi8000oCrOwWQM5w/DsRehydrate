// 官方导出（export_format_version 3）的解析逻辑，从 app.py 移植而来。
// 纯函数，不碰 DOM，方便在 Node 里直接跑测试。

export const BRIDGE_NOTE =
  "【续接说明】以上对话是你与对方此前已经发生的真实交流，不是小说素材、不是别人的聊天记录。" +
  "请保持同一身份、同一语气、同一称呼与同一关系进度继续往下说，" +
  "不要复述、不要总结、不要重新自我介绍、不要提醒对方“我们之前聊过”。";

const TEXT_FRAGMENTS = new Set(["REQUEST", "RESPONSE", "TEMPLATE_RESPONSE"]);

export function normalizeRole(m) {
  const r = String(m?.role || "").toLowerCase();
  if (r === "user") return "user";
  if (r === "assistant") return "assistant";
  return null;
}

export function isoToTs(v) {
  if (!v) return 0;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

export function parseSession(d) {
  const raw = d?.messages;
  if (!Array.isArray(raw) || raw.length < 2) return null;

  const byId = new Map();
  for (const m of raw) if (m && m.id != null) byId.set(m.id, m);

  let cur = d.current_message_id;
  const chain = [];
  let guard = 0;
  while (byId.has(cur) && guard++ < 200000) {
    const m = byId.get(cur);
    chain.push(m);
    cur = m.parent_id;
  }
  if (!chain.length) chain.push(...raw.filter(Boolean));
  chain.reverse();

  const messages = [];
  for (const m of chain) {
    const role = normalizeRole(m);
    if (!role) continue;

    const status = String(m.status || "").toUpperCase();
    const texts = [];
    const thinks = [];
    const files = [];

    for (const f of m.fragments || []) {
      if (!f) continue;
      const t = String(f.type || "").toUpperCase();
      const c = f.content;
      if (TEXT_FRAGMENTS.has(t)) {
        if (typeof c === "string" && c.trim()) texts.push(c.trim());
      } else if (t === "THINK") {
        if (typeof c === "string" && c.trim()) thinks.push(c.trim());
      } else if (t === "FILE") {
        for (const x of f.files || []) {
          if (x && x.export_path) {
            files.push({
              path: x.export_path.replace(/\\/g, "/"),
              name: x.file_name || x.export_path.split("/").pop(),
              image: !!x.is_image,
            });
          }
        }
      }
    }

    const text = texts.join("\n").trim();
    if (!text) continue;
    if ((status === "TIMEOUT" || status === "FAILED") && /服务繁忙|稍后再试/.test(text)) continue;

    messages.push({
      role,
      text,
      ts: isoToTs(m.inserted_at),
      reasoning: thinks.join("\n").slice(0, 4000),
      files,
    });
  }

  if (messages.length < 2) return null;
  const firstUser = messages.find((x) => x.role === "user")?.text || "";
  return {
    title: (d.title || firstUser.slice(0, 24) || "未命名对话").trim(),
    count: messages.length,
    firstUser,
    preview: messages.slice(0, 2).map((x) => x.text.slice(0, 40).replace(/\n/g, " ")).join(" / "),
    messages,
    fileCount: messages.reduce((n, m) => n + m.files.length, 0),
  };
}

export function isSessionJson(name) {
  return /(^|\/)chat_sessions\/[^/]+\.json$/.test(name) || /^chat_sessions\/[^/]+\.json$/.test(name);
}

export function estTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x3400 && c <= 0x9fff) cjk++;
  }
  return Math.ceil(cjk * 0.75 + (text.length - cjk) * 0.3) + 4;
}

export function buildSystem(char) {
  const parts = [];
  if (char.persona?.trim()) parts.push(char.persona.trim());
  if (char.anchors?.trim()) parts.push("【必须遵守的既有事实与记忆锚点】\n" + char.anchors.trim());
  parts.push(BRIDGE_NOTE);
  return parts.join("\n\n");
}

export function pickHistory(messages, budget, reserve = 1200) {
  let used = 0;
  const picked = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estTokens(messages[i].text) + 8;
    if (used + t > Math.max(800, budget - reserve)) break;
    picked.push(messages[i]);
    used += t;
  }
  picked.reverse();
  while (picked.length && picked[0].role !== "user") picked.shift();
  return { history: picked, used };
}

/* ---------------------------------------------------------------- 备份 */

export const PACK_TAG = "rehydrate-mobile";

const cleanMsgs = (msgs) => (msgs || []).map((m) => ({
  role: m.role, text: m.text, ts: m.ts || 0,
  reasoning: m.reasoning || "", images: m.images || [],
  status: m.status || "done", finishReason: m.finishReason || "",
  thinkStart: m.thinkStart || 0, thinkEnd: m.thinkEnd || 0,
  error: m.error || null, cites: m.cites || [],
}));

// v2：一次带走所有对话
export function packAll(chats, cfg) {
  return {
    app: PACK_TAG,
    v: 2,
    exportedAt: new Date().toISOString(),
    cfg: {
      baseUrl: cfg?.baseUrl || "",
      model: cfg?.model || "",
      thinking: cfg?.thinking || "off",
      budget: cfg?.budget || 128000,
      maxTokens: cfg?.maxTokens || 8192,
      temperature: cfg?.temperature ?? 1.1,
      font: cfg?.font || 15,
      search: !!cfg?.search,
      enterSend: cfg?.enterSend !== false,
    },
    chats: (chats || []).map((c) => ({
      name: c.name || "未命名",
      persona: c.persona || "",
      anchors: c.anchors || "",
      msgs: cleanMsgs(c.msgs),
    })),
    files: {},
  };
}

export function unpack(json) {
  if (!json || json.app !== PACK_TAG) throw new Error("这不是「续语」导出的备份文件");
  if (json.v >= 2 && Array.isArray(json.chats)) {
    return {
      cfg: json.cfg || {},
      chats: json.chats.map((c) => ({
        name: c.name || "未命名",
        persona: c.persona || "",
        anchors: c.anchors || "",
        msgs: cleanMsgs(c.msgs),
      })),
      files: json.files || {},
    };
  }
  if (!Array.isArray(json.msgs)) throw new Error("备份文件缺少对话数据");
  return {
    cfg: json.cfg || {},
    chats: [{
      name: json.char?.name || "未命名",
      persona: json.char?.persona || "",
      anchors: json.char?.anchors || "",
      msgs: cleanMsgs(json.msgs),
    }],
    files: json.files || {},
  };
}

/* ---------------------------------------------------------------- 文本导入 */

const MD_ROLE = /^\s{0,3}#{1,4}\s*(user|assistant|human|ai|用户|助手)\s*$/i;
const PREFIX_ROLE = /^\s*(user|assistant|用户|助手|human|ai)\s*[:：]\s*/i;

export function parseText(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let role = null;
  let buf = [];

  const flush = () => {
    const body = buf.join("\n").replace(/\n*-{3,}\s*$/, "").trim();
    if (role && body) out.push({ role, text: body, ts: 0 });
    buf = [];
  };

  for (const ln of lines) {
    const m = ln.match(MD_ROLE);
    if (m) {
      flush();
      const r = m[1].toLowerCase();
      role = ["user", "human", "用户"].includes(r) ? "user" : "assistant";
      continue;
    }
    if (role === null) {
      const pm = ln.match(PREFIX_ROLE);
      if (pm) {
        const r = pm[1].toLowerCase();
        role = ["user", "human", "用户"].includes(r) ? "user" : "assistant";
        buf.push(ln.replace(PREFIX_ROLE, ""));
        continue;
      }
    }
    buf.push(ln);
  }
  flush();
  return out;
}
