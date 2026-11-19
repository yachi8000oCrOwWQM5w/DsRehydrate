// 纯浏览器 ZIP 读取器：只读中央目录，按需切片解压，避免把 300MB 一次性读进内存。
// 同时可在 Node 18+ 里直接 import 做测试（Blob / DecompressionStream 都有）。

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LH = 0x04034b50;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("这个浏览器不支持流式解压（需要 Chrome 103+ / Android 9 以上）");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeName(bytes, utf8) {
  if (utf8) return new TextDecoder("utf-8").decode(bytes);
  // 老式 zip 用 cp437/latin1，中文包一般会带 utf8 标志位
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("latin1").decode(bytes); }
}

export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new Error("这不是一个有效的 ZIP");

  const tailLen = Math.min(size, 65557);
  const tail = new Uint8Array(await blob.slice(size - tailLen).arrayBuffer());

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("找不到 ZIP 目录，可能文件不完整");

  const total = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOff = u32(tail, eocd + 16);
  if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error("这个 ZIP 用了 ZIP64 格式，暂不支持");
  }

  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = [];
  let p = 0;
  for (let i = 0; i < total && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== SIG_CD) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const compSize = u32(cd, p + 20);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const offset = u32(cd, p + 42);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    entries.push({ name: name.replace(/\\/g, "/"), method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function read(entry) {
    const lh = new Uint8Array(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
    if (u32(lh, 0) !== SIG_LH) throw new Error("本地文件头损坏：" + entry.name);
    const nameLen = u16(lh, 26);
    const extraLen = u16(lh, 28);
    const start = entry.offset + 30 + nameLen + extraLen;
    const raw = new Uint8Array(await blob.slice(start, start + entry.compSize).arrayBuffer());
    if (entry.method === 0) return raw;
    if (entry.method !== 8) throw new Error("不支持的压缩方式：" + entry.method);
    return inflateRaw(raw);
  }

  return { size, entries, read };
}
