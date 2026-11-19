#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""角色接续台 — 把 C 端养出来的对话搬到本地，用 API 接着聊。

零依赖：只用 Python 标准库。数据全部落在 ./data 里，纯文本 + 裸文件，
备份就是复制文件夹。
"""

import base64
import io
import json
import os
import re
import socket
import sys
import threading
import time
import uuid
import zipfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("REHYDRATE_DATA") or (ROOT / "data")).resolve()
CHARS = DATA / "chars"
TMP = DATA / "tmp"
STATIC = ROOT / "static"
CONFIG_PATH = DATA / "config.json"

PORT = int(os.environ.get("PORT", "8765"))

DEFAULT_CONFIG = {
    "api_key": "",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "temperature": 1.1,
    "context_budget": 131072,
    "max_tokens": 8192,
    "thinking": "auto",
}

LIMITS = {
    "temperature": (0.0, 2.0),
    "context_budget": (2000, 1048576),
    "max_tokens": (1, 393216),
}
MODEL_CONTEXT = 1048576

# 续接提示：这段话是“她还是她”的关键，不要删。
BRIDGE_NOTE = (
    "【续接说明】以上对话是你与对方此前已经发生的真实交流，不是小说素材、不是别人的聊天记录。"
    "请保持同一身份、同一语气、同一称呼与同一关系进度继续往下说，"
    "不要复述、不要总结、不要重新自我介绍、不要提醒对方“我们之前聊过”。"
)

SKIP_FRAGMENTS = {"THINK", "TIP", "TOOL_SEARCH", "SEARCH", "TOOL_OPEN", "TOOL_RESULT"}

MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".json": "application/json",
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
}


# ---------------------------------------------------------------- 基础工具

def ensure_dirs():
    for d in (DATA, CHARS, TMP):
        d.mkdir(parents=True, exist_ok=True)


def now():
    return int(time.time())


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(read_json(CONFIG_PATH, {}))
    return cfg


def save_config(cfg):
    write_json(CONFIG_PATH, cfg)


def new_id():
    return uuid.uuid4().hex[:12]


def _safe_rel(rel):
    """只允许包内相对路径，挡掉 ../ 和绝对路径。"""
    if not rel:
        return None
    p = Path(str(rel).replace("\\", "/"))
    if p.is_absolute() or ".." in p.parts:
        return None
    return p


def char_dir(cid):
    return CHARS / cid


def load_char(cid):
    p = char_dir(cid) / "char.json"
    if not p.exists():
        return None
    return read_json(p, None)


def save_char(char):
    char["updated"] = now()
    write_json(char_dir(char["id"]) / "char.json", char)


def load_messages(cid):
    return read_json(char_dir(cid) / "messages.json", [])


def save_messages(cid, msgs):
    write_json(char_dir(cid) / "messages.json", msgs)


def plain_preview(text, limit=60):
    """侧栏摘要用的纯文本：去掉 markdown 记号，避免出现 ** 和 #。"""
    s = str(text or "")
    s = s.replace("**", "").replace("`", "").replace("*", "")
    s = re.sub(r"(?m)^\s*[>#]+\s*", "", s)
    s = s.replace("---", "")
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def list_chars():
    out = []
    if not CHARS.exists():
        return out
    for d in sorted(CHARS.iterdir()):
        if not d.is_dir():
            continue
        c = read_json(d / "char.json", None)
        if not c:
            continue
        msgs = read_json(d / "messages.json", [])
        last = plain_preview(msgs[-1]["text"]) if msgs else ""
        out.append({
            "id": c.get("id") or d.name,
            "name": c.get("name", "未命名"),
            "count": len(msgs),
            "updated": c.get("updated", 0),
            "last": last,
        })
    out.sort(key=lambda x: x["updated"], reverse=True)
    return out


def est_tokens(text):
    """粗估。中文按 0.75 token/字，其余按 0.3，误差够用来切窗口了。"""
    if not text:
        return 0
    cjk = 0
    for ch in text:
        if "\u3400" <= ch <= "\u9fff":
            cjk += 1
    return int(cjk * 0.75 + (len(text) - cjk) * 0.3) + 4


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def suggest_dirs():
    """找一下旁边有没有解压好的导出目录，省得手打路径。"""
    out = []
    for base in (ROOT.parent, Path.home() / "Downloads", Path.home() / "Desktop"):
        try:
            for d in sorted(base.iterdir()):
                if d.is_dir() and d.name.lower().startswith("deepseek_data"):
                    out.append(str(d))
        except Exception:
            continue
    return out[:5]


# ---------------------------------------------------------------- 导入解析

def _as_text(v):
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        buf = []
        for p in v:
            if isinstance(p, str):
                buf.append(p)
            elif isinstance(p, dict):
                t = p.get("text") or p.get("content")
                if isinstance(t, str):
                    buf.append(t)
        return "\n".join(buf)
    return ""


def message_text(m):
    """尽量把一条消息的可见正文捞出来，去掉思考/工具片段。"""
    chunks = []

    for f in (m.get("fragments") or []):
        if not isinstance(f, dict):
            continue
        ftype = str(f.get("type") or "").upper()
        if ftype in SKIP_FRAGMENTS:
            continue
        t = f.get("content")
        if isinstance(t, str) and t.strip():
            chunks.append(t)

    if not chunks:
        c = m.get("content")
        if isinstance(c, dict):
            c = c.get("parts") or c.get("text") or ""
        chunks.append(_as_text(c))

    for k in ("text", "mes", "message"):
        v = m.get(k)
        if isinstance(v, str) and v.strip():
            chunks.append(v)

    seen, out = set(), []
    for c in chunks:
        c = c.strip()
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return "\n".join(out).strip()


def normalize_role(m):
    r = m.get("role")
    if not r and isinstance(m.get("author"), dict):
        r = m["author"].get("role")
    if not r:
        r = m.get("from")
    r = str(r or "").lower()
    if r in ("user", "human", "用户"):
        return "user"
    if r in ("assistant", "ai", "bot", "助手", "model"):
        return "assistant"
    if r in ("system", "系统"):
        return "system"
    return None


def message_ts(m):
    for k in ("create_time", "inserted_at", "timestamp", "created_at", "time"):
        v = m.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return int(v / 1000) if v > 10_000_000_000 else int(v)
        if isinstance(v, str) and v.isdigit():
            n = int(v)
            return int(n / 1000) if n > 10_000_000_000 else n
    return 0


MESSAGE_LIST_KEYS = ("chat_messages", "messages", "conversation", "msgs", "dialog", "items")


def _looks_like_messages(lst):
    if not isinstance(lst, list) or not lst:
        return False
    hit = 0
    for x in lst[:8]:
        if not isinstance(x, dict):
            return False
        if normalize_role(x) or "fragments" in x or "content" in x:
            hit += 1
    return hit >= max(1, len(lst[:8]) // 2)


def find_conversations(obj, depth=0):
    """容错遍历：任何看起来像“一段对话”的对象都收进来。"""
    found = []
    if depth > 6:
        return found

    if isinstance(obj, dict):
        msgs = None
        hit_key = None
        for k in MESSAGE_LIST_KEYS:
            v = obj.get(k)
            if _looks_like_messages(v):
                msgs = v
                hit_key = k
                break
        if msgs is not None:
            found.append({"title": obj.get("title") or obj.get("name") or "", "raw": msgs})
        else:
            mapping = obj.get("mapping")
            if isinstance(mapping, dict) and mapping:
                seq = []
                for node in mapping.values():
                    if not isinstance(node, dict):
                        continue
                    msg = node.get("message")
                    if isinstance(msg, dict) and normalize_role(
                        {"author": msg.get("author") or {}} if isinstance(msg.get("author"), dict) else msg
                    ):
                        seq.append(msg)
                seq.sort(key=message_ts)
                if seq:
                    found.append({"title": obj.get("title") or "", "raw": seq})
        for kk, v in obj.items():
            if kk == hit_key:
                continue
            if isinstance(v, (dict, list)):
                found.extend(find_conversations(v, depth + 1))

    elif isinstance(obj, list):
        if _looks_like_messages(obj):
            found.append({"title": "", "raw": obj})
        else:
            for v in obj:
                if isinstance(v, (dict, list)):
                    found.extend(find_conversations(v, depth + 1))

    return found


def iso_ts(v):
    if not v:
        return 0
    s = str(v).strip().replace("Z", "+00:00")
    if s.isdigit():
        n = int(s)
        return n // 1000 if n > 10_000_000_000 else n
    try:
        return int(datetime.fromisoformat(s).timestamp())
    except Exception:
        return 0


def _conv_from_session(d):
    """官方 v3 导出：messages 是靠 parent_id 串成的树，current_message_id 指向当前分支。

    平铺着读会把每一次「重新生成」的废稿都当成正文，所以必须先走链。
    """
    raw = d.get("messages")
    if not isinstance(raw, list) or len(raw) < 2:
        return None

    byid = {m.get("id"): m for m in raw if isinstance(m, dict)}
    cur = d.get("current_message_id")
    chain, guard = [], 0
    while cur in byid and guard < 200000:
        m = byid[cur]
        chain.append(m)
        cur = m.get("parent_id")
        guard += 1
    if not chain:
        chain = sorted([m for m in raw if isinstance(m, dict)], key=lambda m: m.get("id") or 0)
    chain.reverse()

    msgs = []
    for m in chain:
        role = normalize_role(m)
        if role not in ("user", "assistant"):
            continue
        status = str(m.get("status") or "").upper()
        text, think, files = [], [], []
        for f in m.get("fragments") or []:
            if not isinstance(f, dict):
                continue
            ft = str(f.get("type") or "").upper()
            c = f.get("content")
            if ft in ("REQUEST", "RESPONSE", "TEMPLATE_RESPONSE"):
                if isinstance(c, str) and c.strip():
                    text.append(c.strip())
            elif ft == "THINK":
                if isinstance(c, str) and c.strip():
                    think.append(c.strip())
            elif ft == "FILE":
                for x in (f.get("files") or []):
                    if isinstance(x, dict) and x.get("export_path"):
                        files.append({
                            "path": x["export_path"],
                            "name": x.get("file_name") or Path(x["export_path"]).name,
                            "image": bool(x.get("is_image")),
                        })
        body = "\n".join(text).strip()
        if not body:
            continue
        if status in ("TIMEOUT", "FAILED") and ("服务繁忙" in body or "稍后再试" in body):
            continue
        msgs.append({
            "role": role,
            "text": body,
            "ts": iso_ts(m.get("inserted_at")),
            "reasoning": "\n".join(think)[:4000],
            "files": files,
        })

    if len(msgs) < 2:
        return None
    first_user = next((x["text"] for x in msgs if x["role"] == "user"), "")
    return {
        "title": (d.get("title") or first_user[:24] or "未命名对话").strip(),
        "count": len(msgs),
        "first_user": first_user,
        "preview": " / ".join(x["text"][:40].replace("\n", " ") for x in msgs[:2]),
        "start": msgs[0]["ts"],
        "end": msgs[-1]["ts"],
        "messages": msgs,
        "files": sum(len(x["files"]) for x in msgs),
    }


def _conv_from_raw(title, raw):
    msgs = []
    for m in raw:
        role = normalize_role(m)
        text = message_text(m)
        if role not in ("user", "assistant") or not text:
            continue
        msgs.append({"role": role, "text": text, "ts": message_ts(m), "reasoning": "", "files": []})
    if len(msgs) < 2:
        return None
    first_user = next((x["text"] for x in msgs if x["role"] == "user"), "")
    return {
        "title": (title or first_user[:24] or "未命名对话").strip(),
        "count": len(msgs),
        "first_user": first_user,
        "preview": " / ".join(x["text"][:40].replace("\n", " ") for x in msgs[:2]),
        "start": msgs[0]["ts"],
        "end": msgs[-1]["ts"],
        "messages": msgs,
        "files": 0,
    }


def scan_blobs(blobs):
    convs, seen = [], set()
    for blob in blobs:
        found = []
        if isinstance(blob, dict) and isinstance(blob.get("messages"), list):
            c = _conv_from_session(blob)
            if c:
                found.append(c)
        if not found:
            for c in find_conversations(blob):
                cc = _conv_from_raw(c["title"], c["raw"])
                if cc:
                    found.append(cc)
        for c in found:
            key = (c["count"], c["messages"][0]["text"][:60], c["messages"][-1]["text"][:60])
            if key in seen:
                continue
            seen.add(key)
            convs.append(c)
    convs.sort(key=lambda c: c["count"], reverse=True)
    return convs


def parse_zip_zip(data):
    zf = zipfile.ZipFile(io.BytesIO(data))
    blobs = []
    for info in zf.infolist():
        if info.is_dir() or not info.filename.lower().endswith(".json"):
            continue
        if info.file_size > 200 * 1024 * 1024:
            continue
        try:
            blobs.append(json.loads(zf.read(info).decode("utf-8", "ignore")))
        except Exception:
            continue
    return scan_blobs(blobs)


def parse_dir(root):
    """直接读解压后的导出目录。304MB 的包没必要再从浏览器传一遍。"""
    root = Path(root).expanduser()
    if not root.is_dir():
        raise FileNotFoundError(f"目录不存在：{root}")
    cand = []
    if (root / "chat_sessions").is_dir():
        cand = sorted((root / "chat_sessions").glob("*.json"))
    else:
        cand = sorted(root.glob("*.json"))
    if not cand:
        raise FileNotFoundError(f"这个目录里没找到导出的 json：{root}")

    blobs = []
    for p in cand:
        try:
            if p.stat().st_size > 200 * 1024 * 1024:
                continue
            blobs.append(json.loads(p.read_text(encoding="utf-8", errors="ignore")))
        except Exception:
            continue
    convs = scan_blobs(blobs)
    if not convs:
        raise ValueError("扫到 json 了，但没解析出对话。格式可能又变了。")
    return convs


MD_ROLE = re.compile(r"^\s{0,3}#{1,4}\s*(user|assistant|human|ai|用户|助手)\s*$", re.I)
PREFIX_ROLE = re.compile(r"^\s*(user|assistant|用户|助手|human|ai)\s*[:：]\s*", re.I)


def parse_plain(text):
    """解析 ## User / ## Assistant 这种分节的 Markdown，或 "用户:" 前缀。"""
    lines = text.replace("\r\n", "\n").split("\n")
    msgs, role, buf = [], None, []

    def flush():
        nonlocal buf
        body = "\n".join(buf).strip()
        body = re.sub(r"\n*-{3,}\s*$", "", body).strip()
        if role and body:
            msgs.append({"role": role, "text": body, "ts": 0})
        buf = []

    for ln in lines:
        m1 = MD_ROLE.match(ln)
        if m1:
            flush()
            r = m1.group(1).lower()
            role = "user" if r in ("user", "human", "用户") else "assistant"
            continue
        if role is None:
            m2 = PREFIX_ROLE.match(ln)
            if m2:
                r = m2.group(1).lower()
                role = "user" if r in ("user", "human", "用户") else "assistant"
                buf.append(PREFIX_ROLE.sub("", ln))
                continue
        buf.append(ln)
    flush()
    return msgs


# ---------------------------------------------------------------- 上下文拼装

def build_system(char):
    parts = []
    persona = (char.get("persona") or "").strip()
    anchors = (char.get("anchors") or "").strip()
    if persona:
        parts.append(persona)
    if anchors:
        parts.append("【必须遵守的既有事实与记忆锚点】\n" + anchors)
    parts.append(BRIDGE_NOTE)
    return "\n\n".join(parts)


def pick_history(msgs, budget, reserve=2500):
    used = 0
    picked = []
    for m in reversed(msgs):
        t = est_tokens(m["text"]) + 8
        if used + t > max(1000, budget - reserve):
            break
        picked.append(m)
        used += t
    picked.reverse()
    while picked and picked[0]["role"] != "user":
        picked.pop(0)
    return picked, used


def build_request(char, msgs, payload, cfg):
    # 上下文是「输入 + 输出」合计，所以历史能用的部分要先把回复额度扣掉
    total = int(cfg["context_budget"])
    input_budget = max(2000, min(total, MODEL_CONTEXT) - int(cfg["max_tokens"]))
    history, used = pick_history(msgs, input_budget, reserve=600)
    out = [{"role": "system", "content": build_system(char)}]
    for m in history:
        text = m["text"]
        if m.get("images"):
            text = (text + "\n[此前发过图片]").strip()
        out.append({"role": m["role"], "content": text})

    user_text = (payload.get("text") or "").strip()
    images = payload.get("images") or []
    if images:
        content = [{"type": "text", "text": user_text or "（看图）"}]
        for rel in images[:4]:
            path = char_dir(char["id"]) / "files" / rel
            if not path.exists():
                continue
            ext = path.suffix.lower()
            mime = MIME.get(ext, "image/png")
            b64 = base64.b64encode(path.read_bytes()).decode()
            content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
        out.append({"role": "user", "content": content})
    else:
        out.append({"role": "user", "content": user_text})

    return out, len(history), used


def call_api_once(cfg, messages, max_tokens=1200, temperature=0.3):
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    body = {
        "model": cfg["model"],
        "messages": messages,
        "stream": False,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    req = Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["api_key"]},
        method="POST",
    )
    with urlopen(req, timeout=180) as r:
        obj = json.loads(r.read().decode("utf-8", "ignore"))
    return ((obj.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()


def char_card(char, msgs):
    first_asst = next((m["text"] for m in msgs if m["role"] == "assistant"), "")
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": char.get("name") or "未命名",
            "description": char.get("persona") or "",
            "personality": "",
            "scenario": "",
            "first_mes": first_asst,
            "mes_example": "",
            "creator_notes": char.get("anchors") or "",
            "system_prompt": char.get("persona") or "",
            "post_history_instructions": BRIDGE_NOTE,
            "tags": ["rehydrate"],
            "creator": "rehydrate",
            "character_version": "1.0",
            "extensions": {},
        },
    }


def model_error(e, base=""):
    """把上游的 401 翻译成人能看懂的一句话，原始响应留在 detail 里。"""
    detail = e.read().decode("utf-8", "ignore")[:400]
    if e.code == 401:
        where = "platform.deepseek.com" if "api.deepseek.com" in (base or "") else "你的网关后台"
        return {
            "error": f"这个 Key 无效（401）。去{where}看看它还在不在、有没有被删、复制时有没有少字符。",
            "detail": detail,
        }
    if e.code == 403:
        return {"error": "这个 Key 没权限（403），可能属于别的账号或已被停用。", "detail": detail}
    if e.code == 404:
        return {"error": "接口路径不对（404），检查 Base URL 是不是少了或多了后缀。", "detail": detail}
    return {"error": f"上游 {e.code}：{detail[:200]}", "detail": detail}


def list_models(key, base):
    req = Request(
        base.rstrip("/") + "/models",
        headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
    )
    with urlopen(req, timeout=30) as r:
        obj = json.loads(r.read().decode("utf-8", "ignore"))
    raw = obj.get("data") or obj.get("models") or []
    out = []
    for m in raw:
        if isinstance(m, str):
            out.append({"id": m})
        elif isinstance(m, dict):
            mid = m.get("id") or m.get("name") or m.get("model")
            if mid:
                out.append({
                    "id": mid,
                    "context_window": m.get("context_window") or m.get("context_length"),
                    "max_output_tokens": m.get("max_output_tokens") or m.get("max_tokens"),
                })
    return out


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "Rehydrate/1.0"

    def log_message(self, fmt, *args):
        pass

    # -- 输出helpers

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body, ctype, status=200, download=None, cache=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            self.send_header("Cache-Control", cache)
        if download:
            # 头只能写 latin-1，中文名必须 percent-encode 后再进 filename*
            self.send_header(
                "Content-Disposition",
                "attachment; filename=\"download\"; filename*=UTF-8''" + quote(download, safe=""),
            )
        self.end_headers()
        self.wfile.write(body)

    def sse_open(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def sse(self, obj):
        try:
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()
        except Exception:
            pass

    def body_raw(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return b""
        buf = bytearray()
        while len(buf) < n:
            chunk = self.rfile.read(min(262144, n - len(buf)))
            if not chunk:
                break
            buf.extend(chunk)
        return bytes(buf)

    def body_json(self):
        raw = self.body_raw()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # -- GET

    def do_GET(self):
        u = urlparse(self.path)
        path, qs = u.path, parse_qs(u.query)

        if path in ("/", "/index.html"):
            return self.serve_static("index.html")
        if path.startswith("/static/"):
            return self.serve_static(path[len("/static/"):])
        if path == "/manifest.webmanifest":
            return self.serve_static("manifest.webmanifest")

        if path == "/api/boot":
            cfg = load_config()
            return self.send_json({
                "chars": list_chars(),
                "config": {
                    "base_url": cfg["base_url"],
                    "model": cfg["model"],
                    "temperature": cfg["temperature"],
                    "context_budget": cfg["context_budget"],
                    "max_tokens": cfg["max_tokens"],
                    "thinking": cfg.get("thinking", "off"),
                    "key_set": bool(cfg["api_key"]),
                    "key_tail": cfg["api_key"][-4:] if cfg["api_key"] else "",
                },
                "lan": local_ip(),
                "port": PORT,
                "suggest_dirs": suggest_dirs(),
            })

        if path == "/api/char":
            cid = (qs.get("id") or [""])[0]
            char = load_char(cid)
            if not char:
                return self.send_json({"error": "角色不存在"}, 404)
            msgs = load_messages(cid)
            return self.send_json({"char": char, "messages": msgs})

        if path == "/api/file":
            cid = (qs.get("char") or [""])[0]
            name = (qs.get("name") or [""])[0]
            p = char_dir(cid) / "files" / name
            if not p.exists() or p.parent != char_dir(cid) / "files":
                return self.send_json({"error": "文件不存在"}, 404)
            return self.send_bytes(p.read_bytes(), MIME.get(p.suffix.lower(), "application/octet-stream"))

        if path == "/api/export":
            cid = (qs.get("id") or [""])[0]
            if not load_char(cid):
                return self.send_json({"error": "角色不存在"}, 404)
            buf = io.BytesIO()
            base = char_dir(cid)
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in base.rglob("*"):
                    if f.is_file():
                        zf.write(f, f.relative_to(base).as_posix())
            name = f"{cid}.rehydrate.zip"
            return self.send_bytes(buf.getvalue(), "application/zip", download=name)

        if path in ("/api/export/card", "/api/export/jsonl"):
            cid = (qs.get("id") or [""])[0]
            char = load_char(cid)
            if not char:
                return self.send_json({"error": "角色不存在"}, 404)
            msgs = load_messages(cid)

            if path == "/api/export/card":
                body = json.dumps(char_card(char, msgs), ensure_ascii=False, indent=2).encode("utf-8")
                return self.send_bytes(
                    body, "application/json; charset=utf-8",
                    download=f"{char.get('name') or 'card'}.json",
                )

            head = char_card(char, msgs)["data"]
            head.update({
                "user_name": "我",
                "character_name": char.get("name") or "",
                "create_date": datetime.now().isoformat(timespec="seconds"),
                "talkativeness": "0.5",
                "mes": "",
                "fav": False,
                "title": char.get("name") or "",
                "alternate_greetings": [],
                "character_book": None,
                "chat_metadata": {},
            })
            lines = [json.dumps(head, ensure_ascii=False)]
            for m in msgs:
                stamp = ""
                if m.get("ts"):
                    try:
                        stamp = datetime.fromtimestamp(m["ts"]).isoformat()
                    except Exception:
                        stamp = ""
                lines.append(json.dumps({
                    "name": "我" if m["role"] == "user" else (char.get("name") or "她"),
                    "is_user": m["role"] == "user",
                    "is_system": False,
                    "send_date": stamp,
                    "mes": m["text"],
                    "extra": {},
                }, ensure_ascii=False))
            return self.send_bytes(
                "\n".join(lines).encode("utf-8"), "application/jsonl; charset=utf-8",
                download=f"{char.get('name') or 'chat'}.jsonl",
            )

        if path == "/api/models":
            cfg = load_config()
            if not cfg["api_key"]:
                return self.send_json({"error": "先填 API Key，才能读模型清单"}, 400)
            try:
                return self.send_json({"models": list_models(cfg["api_key"], cfg["base_url"])})
            except HTTPError as e:
                return self.send_json(model_error(e, cfg["base_url"]), 400)
            except Exception as e:
                return self.send_json({"error": f"读不到：{type(e).__name__} {e}"}, 400)

        return self.send_json({"error": "not found"}, 404)

    def serve_static(self, rel):
        p = (STATIC / rel).resolve()
        if not str(p).startswith(str(STATIC.resolve())) or not p.exists() or p.is_dir():
            return self.send_json({"error": "not found"}, 404)
        self.send_bytes(
            p.read_bytes(),
            MIME.get(p.suffix.lower(), "application/octet-stream"),
            cache="no-cache",
        )

    # -- POST / PUT / DELETE

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path

        if path == "/api/char":
            b = self.body_json()
            cid = new_id()
            char = {
                "id": cid,
                "name": (b.get("name") or "新的她").strip(),
                "persona": (b.get("persona") or "").strip(),
                "anchors": (b.get("anchors") or "").strip(),
                "created": now(),
                "updated": now(),
            }
            save_char(char)
            save_messages(cid, [])
            return self.send_json({"char": char})

        if path in ("/api/import/scan", "/api/import/scan_dir"):
            token = new_id()
            if path == "/api/import/scan_dir":
                b = self.body_json()
                target = (b.get("path") or "").strip()
                if not target:
                    return self.send_json({"error": "给个目录路径"}, 400)
                try:
                    convs = parse_dir(target)
                except Exception as e:
                    return self.send_json({"error": str(e)}, 400)
                src = {"kind": "dir", "root": str(Path(target).expanduser().resolve())}
            else:
                raw = self.body_raw()
                if not raw:
                    return self.send_json({"error": "没有收到文件"}, 400)
                try:
                    convs = parse_zip_zip(raw)
                except Exception as e:
                    return self.send_json({"error": f"解压失败：{e}"}, 400)
                zp = TMP / f"{token}.zip"
                zp.write_bytes(raw)
                src = {"kind": "zip", "path": str(zp)}

            if not convs:
                return self.send_json({"error": "没找到能识别的对话。可以改用「粘贴文本」导入。"}, 400)

            write_json(TMP / f"{token}.json", convs)
            write_json(TMP / f"{token}.src.json", src)
            items = []
            for i, c in enumerate(convs[:300]):
                items.append({
                    "idx": i,
                    "title": c["title"],
                    "count": c["count"],
                    "files": c.get("files", 0),
                    "preview": c["preview"],
                    "first_user": c["first_user"],
                    "start": c["start"],
                    "end": c["end"],
                })
            return self.send_json({"token": token, "items": items, "total": len(convs)})

        if path == "/api/import/apply":
            b = self.body_json()
            token = b.get("token") or ""
            idx = int(b.get("idx") or 0)
            convs = read_json(TMP / f"{token}.json", None)
            if not convs or idx >= len(convs):
                return self.send_json({"error": "导入会话已过期，重新上传一次"}, 400)
            conv = convs[idx]

            cid = b.get("char_id") or new_id()
            if b.get("char_id"):
                char = load_char(cid)
                if not char:
                    return self.send_json({"error": "角色不存在"}, 404)
                msgs = load_messages(cid)
            else:
                char = {
                    "id": cid,
                    "name": (b.get("name") or conv["title"] or "未命名").strip(),
                    "persona": (b.get("persona") or conv["first_user"]).strip(),
                    "anchors": (b.get("anchors") or "").strip(),
                    "created": now(),
                    "updated": now(),
                }
                msgs = []

            base_ts = msgs[-1].get("ts", 0) if msgs else 0
            src = read_json(TMP / f"{token}.src.json", {}) or {}
            zf = None
            if src.get("kind") == "zip":
                try:
                    zf = zipfile.ZipFile(src["path"])
                except Exception:
                    zf = None
            root = Path(src["root"]) if src.get("kind") == "dir" else None
            fdir = char_dir(cid) / "files"
            copied = 0

            for m in conv["messages"]:
                imgs, others = [], []
                for f in (m.get("files") or []):
                    rel = _safe_rel(f.get("path"))
                    if rel is None:
                        continue
                    data = None
                    try:
                        if zf is not None:
                            data = zf.read(rel.as_posix())
                        elif root is not None:
                            p = root / rel
                            if p.is_file():
                                data = p.read_bytes()
                    except Exception:
                        data = None
                    if not data:
                        continue
                    ext = Path(f.get("name") or rel.name).suffix.lower()
                    if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext):
                        ext = ".bin"
                    stored = new_id() + ext
                    fdir.mkdir(parents=True, exist_ok=True)
                    (fdir / stored).write_bytes(data)
                    copied += 1
                    if f.get("image"):
                        imgs.append(stored)
                    else:
                        others.append({"n": stored, "t": f.get("name") or stored})

                ts = m.get("ts") or 0
                if ts and base_ts and ts <= base_ts:
                    ts = base_ts + 1
                msgs.append({
                    "id": new_id(),
                    "role": m["role"],
                    "text": m["text"],
                    "ts": ts or (base_ts + 1),
                    "images": imgs,
                    "files": others,
                    "reasoning": m.get("reasoning") or "",
                })
                if ts:
                    base_ts = ts

            if zf is not None:
                zf.close()

            save_char(char)
            save_messages(cid, msgs)
            return self.send_json({"char": char, "count": len(msgs), "files": copied})

        if path == "/api/import/text":
            b = self.body_json()
            text = b.get("text") or ""
            msgs = parse_plain(text)
            if not msgs:
                return self.send_json({"error": "没解析出消息。需要 ## User / ## Assistant 这种分节，或「用户:」前缀。"}, 400)
            cid = new_id()
            char = {
                "id": cid,
                "name": (b.get("name") or "从文本导入").strip(),
                "persona": (b.get("persona") or (msgs[0]["text"] if msgs[0]["role"] == "user" else "")).strip(),
                "anchors": "",
                "created": now(),
                "updated": now(),
            }
            base = now()
            for i, m in enumerate(msgs):
                m["id"] = new_id()
                m["ts"] = base + i
                m["images"] = []
                m["files"] = []
                m["reasoning"] = ""
            save_char(char)
            save_messages(cid, msgs)
            return self.send_json({"char": char, "count": len(msgs)})

        if path == "/api/upload":
            cid = (parse_qs(u.query).get("char") or [""])[0]
            name = (parse_qs(u.query).get("name") or ["img"])[0]
            if not load_char(cid):
                return self.send_json({"error": "角色不存在"}, 404)
            raw = self.body_raw()
            safe = re.sub(r"[^\w.\-]+", "_", name)[:80] or "file"
            ext = Path(safe).suffix.lower() or ".png"
            fname = f"{new_id()}{ext}"
            d = char_dir(cid) / "files"
            d.mkdir(parents=True, exist_ok=True)
            (d / fname).write_bytes(raw)
            return self.send_json({"name": fname, "size": len(raw)})

        if path == "/api/config":
            b = self.body_json()
            cfg = load_config()
            for k in ("base_url", "model"):
                if isinstance(b.get(k), str) and b[k].strip():
                    cfg[k] = b[k].strip().rstrip("/")
            for k, (lo, hi) in LIMITS.items():
                if isinstance(b.get(k), (int, float)):
                    cfg[k] = max(lo, min(hi, b[k]))
            if b.get("thinking") in ("off", "on", "auto"):
                cfg["thinking"] = b["thinking"]
            if isinstance(b.get("api_key"), str) and b["api_key"].strip():
                cfg["api_key"] = b["api_key"].strip()
            if b.get("clear_key"):
                cfg["api_key"] = ""
            save_config(cfg)
            return self.send_json({
                "ok": True,
                "key_set": bool(cfg["api_key"]),
                "temperature": cfg["temperature"],
                "context_budget": cfg["context_budget"],
                "max_tokens": cfg["max_tokens"],
                "thinking": cfg["thinking"],
            })

        if path == "/api/models":
            b = self.body_json()
            cfg = load_config()
            key = (b.get("api_key") or "").strip() or cfg["api_key"]
            base = ((b.get("base_url") or "").strip() or cfg["base_url"]).rstrip("/")
            if not key:
                return self.send_json({"error": "先填 API Key，才能读模型清单"}, 400)
            try:
                return self.send_json({"models": list_models(key, base)})
            except HTTPError as e:
                return self.send_json(model_error(e, base), 400)
            except Exception as e:
                return self.send_json({"error": f"读不到：{type(e).__name__} {e}"}, 400)

        if path == "/api/memory/distill":
            b = self.body_json()
            cid = b.get("char") or ""
            char = load_char(cid)
            if not char:
                return self.send_json({"error": "角色不存在"}, 404)
            cfg = load_config()
            if not cfg["api_key"]:
                return self.send_json({"error": "先在设置里填 API Key"}, 400)
            rounds = max(6, min(200, int(b.get("rounds") or 60)))
            msgs = load_messages(cid)[-rounds:]
            if len(msgs) < 4:
                return self.send_json({"error": "对话太短，攒几轮再提炼"}, 400)

            who = char.get("name") or "她"
            convo = "\n".join(
                ("我：" if m["role"] == "user" else who + "：") + (m["text"] or "")[:500]
                for m in msgs
            )
            prompt = (
                f"这是「{who}」与对方最近的一段对话。请提炼出为了以后接着聊、必须记住的长期事实。\n\n"
                "要求：\n"
                "- 每条一行，以「- 」开头，最多 12 条\n"
                "- 只写事实：身份、称呼、约定、共同经历、明确的好恶与禁忌、说到一半没讲完的事\n"
                "- 不写情绪形容，不写「关系很好」这类空话，不复述剧情细节\n"
                "- 已有的锚点不要重复\n\n"
                f"已有锚点：\n{char.get('anchors') or '（无）'}\n\n"
                f"对话：\n{convo}"
            )
            try:
                out = call_api_once(
                    cfg,
                    [
                        {"role": "system", "content": "你在帮一段长期角色扮演做记忆压缩。只输出条目，不解释、不寒暄。"},
                        {"role": "user", "content": prompt},
                    ],
                    max_tokens=900,
                    temperature=0.2,
                )
            except HTTPError as e:
                detail = e.read().decode("utf-8", "ignore")[:300]
                return self.send_json({"error": f"上游 {e.code}：{detail}"}, 400)
            except Exception as e:
                return self.send_json({"error": f"{type(e).__name__}: {e}"}, 400)
            return self.send_json({"text": out, "used": len(msgs)})

        if path == "/api/chat":
            return self.handle_chat()

        if path == "/api/messages/delete":
            b = self.body_json()
            cid = b.get("char") or ""
            mid = b.get("id") or ""
            msgs = [m for m in load_messages(cid) if m.get("id") != mid]
            save_messages(cid, msgs)
            return self.send_json({"ok": True, "count": len(msgs)})

        return self.send_json({"error": "not found"}, 404)

    def do_PUT(self):
        u = urlparse(self.path)
        if u.path != "/api/char":
            return self.send_json({"error": "not found"}, 404)
        b = self.body_json()
        cid = b.get("id") or ""
        char = load_char(cid)
        if not char:
            return self.send_json({"error": "角色不存在"}, 404)
        for k in ("name", "persona", "anchors"):
            if isinstance(b.get(k), str):
                char[k] = b[k]
        save_char(char)
        return self.send_json({"char": char})

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path != "/api/char":
            return self.send_json({"error": "not found"}, 404)
        cid = (parse_qs(u.query).get("id") or [""])[0]
        d = char_dir(cid)
        if not d.exists():
            return self.send_json({"error": "角色不存在"}, 404)
        for f in sorted(d.rglob("*"), reverse=True):
            try:
                f.unlink() if f.is_file() else f.rmdir()
            except Exception:
                pass
        try:
            d.rmdir()
        except Exception:
            pass
        return self.send_json({"ok": True})

    # -- 聊天主链路

    def handle_chat(self):
        b = self.body_json()
        cid = b.get("char") or ""
        char = load_char(cid)
        if not char:
            return self.send_json({"error": "角色不存在"}, 404)

        cfg = load_config()
        if not cfg["api_key"]:
            return self.send_json({"error": "还没填 API Key。打开设置，粘一个 platform.deepseek.com 的 key。"}, 400)

        text = (b.get("text") or "").strip()
        images = b.get("images") or []

        if b.get("regenerate"):
            msgs = load_messages(cid)
            while msgs and msgs[-1]["role"] != "user":
                msgs.pop()
            if not msgs:
                return self.send_json({"error": "没有可以重新生成的问答"}, 400)
            user_msg = msgs[-1]
            text = user_msg.get("text") or ""
            images = user_msg.get("images") or []
            save_messages(cid, msgs)
        else:
            if not text and not images:
                return self.send_json({"error": "空消息"}, 400)
            msgs = load_messages(cid)
            user_msg = {"id": new_id(), "role": "user", "text": text, "ts": now(), "images": images}
            msgs.append(user_msg)
            save_messages(cid, msgs)

        payload_msgs, sent_n, used = build_request(char, msgs[:-1], {"text": text, "images": images}, cfg)
        if images:
            sent_n += 1

        body = {
            "model": cfg["model"],
            "messages": payload_msgs,
            "stream": True,
            "max_tokens": int(cfg["max_tokens"]),
        }
        mode = cfg.get("thinking", "off")
        if mode == "off":
            body["thinking"] = {"type": "disabled"}
        elif mode == "on":
            body["thinking"] = {"type": "enabled"}
        if mode != "on":
            # 思考模式下官方会忽略 temperature，别发没用的东西
            body["temperature"] = float(cfg["temperature"])

        url = cfg["base_url"].rstrip("/") + "/chat/completions"
        req = Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + cfg["api_key"],
                "Accept": "text/event-stream",
            },
            method="POST",
        )

        self.sse_open()
        self.sse({"type": "meta", "sent": sent_n, "tokens": used, "model": cfg["model"], "uid": user_msg["id"]})

        answer, reasoning = [], []
        usage = {}
        try:
            with urlopen(req, timeout=600) as resp:
                buf = b""
                while True:
                    chunk = resp.read1(8192) if hasattr(resp, "read1") else resp.read(8192)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        line = line.strip()
                        if not line or line.startswith(b":"):
                            continue
                        if not line.startswith(b"data:"):
                            continue
                        data = line[5:].strip()
                        if data == b"[DONE]":
                            buf = b""
                            break
                        try:
                            obj = json.loads(data.decode("utf-8", "ignore"))
                        except Exception:
                            continue
                        if obj.get("usage"):
                            usage = obj["usage"]
                        for ch in (obj.get("choices") or []):
                            d = ch.get("delta") or {}
                            if d.get("reasoning_content"):
                                reasoning.append(d["reasoning_content"])
                                self.sse({"type": "think", "text": d["reasoning_content"]})
                            if d.get("content"):
                                answer.append(d["content"])
                                self.sse({"type": "delta", "text": d["content"]})
        except HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:600]
            self.sse({"type": "error", "message": f"上游 {e.code}：{detail}"})
            self.sse({"type": "end"})
            return
        except URLError as e:
            self.sse({"type": "error", "message": f"连不上 {url}：{e.reason}"})
            self.sse({"type": "end"})
            return
        except Exception as e:
            self.sse({"type": "error", "message": f"{type(e).__name__}: {e}"})
            self.sse({"type": "end"})
            return

        full = "".join(answer)
        msgs = load_messages(cid)
        if full.strip():
            msgs.append({
                "id": new_id(),
                "role": "assistant",
                "text": full,
                "ts": now(),
                "images": [],
                "reasoning": "".join(reasoning)[:4000],
            })
            save_messages(cid, msgs)
        self.sse({"type": "end", "usage": usage, "text": full})


def main():
    ensure_dirs()
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ip = local_ip()
    print("=" * 52)
    print("  Rehydrate  -  local")
    print(f"  http://127.0.0.1:{PORT}")
    print(f"  http://{ip}:{PORT}   (phone, same Wi-Fi)")
    print("  data:", DATA)
    print("=" * 52)
    if os.environ.get("NO_BROWSER") != "1":
        def _open():
            time.sleep(0.7)
            try:
                import webbrowser
                webbrowser.open(f"http://127.0.0.1:{PORT}")
            except Exception:
                pass
        threading.Thread(target=_open, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
