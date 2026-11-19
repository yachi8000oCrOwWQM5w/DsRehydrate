// CDK 门禁（前端校验）。
//
// 当前状态：已关闭，所有人直接进入。
// 需要重新启用时，把下面 GATE_ENABLED 改成 true 并重新发布即可。
//
// 一客一码：CODES 里每个 h 是一个 CDK 的 SHA-256，n 只是给你自己看的编号。
// 码本身不在代码里，只有哈希对得上才放行。
//
// 它挡的是"顺手转发"，不是有意攻击——源码可读，哈希在前端。
// 真要硬门禁得在边缘做（Cloudflare Access）或用后端。
//
// 发新码：node ../cdk-gen.mjs 20 21   （从第 21 号开始生成 20 个）
// 把输出的数组粘到下面 CODES 里，重新发布即可。
// 作废某客户：删掉那一行，重新发布；其他客户的码不受影响。

export const CODES = [
  { n: "001", h: "90b88037ec923cd8b54ad4a45f1dcd8e66e3d9b381e281d94c8f948e286e13c5" },
  { n: "002", h: "219404e74ef46905829697b64ff7f1a07eb86ab461c6c2b4e964e7fc86cc08ef" },
  { n: "003", h: "7d2d86345dad4ead899498fec1d67852db25cd4ed3fb6ed5902401d1b9d14fc6" },
  { n: "004", h: "4e415b250b6e2d32c765542b4b5eee402989f2bc110afd8491e82b3ddbd6c3ac" },
  { n: "005", h: "ade84ce6fea5e11538fcc79de780019532e55947c53b67ba08b3d8d64a57ac9a" },
  { n: "006", h: "be952e4923d83ecf7fa3e87abc70e9fdad97bf2ae4cc318cd322b325aeb8aef9" },
  { n: "007", h: "8bce76ba348e3073a2b59ab80aef7a4188011ca50104e475f01013265608894c" },
  { n: "008", h: "41e3618238c06bc6315cb753db62adeebe3f18648214d39a32ca415c10d7db0d" },
  { n: "009", h: "a70eca468a92b4b7d768b2a682d90874238507e0e6e2977bb0924217c8ea4873" },
  { n: "010", h: "3a966b800c037010341bd1255abd1dd1344bad4723559f02a3ea5981003db8d4" },
  { n: "011", h: "c1cd763617b1b06d7345de1fc48572a3ad4afc31db296328d64482044a55a352" },
  { n: "012", h: "5d69a1f52a74491ec3176410d863f080000a77f20be89fcdfc2648e217f6e2a5" },
  { n: "013", h: "9207b2445b6b3889bb2a0d409a878097d712fc9d463cb8dc4be0f2e8e6143e19" },
  { n: "014", h: "0732a158e83aca3c2a15c0c1ca50e446642b775160b6df4dab5581436727646e" },
  { n: "015", h: "f5a028b8a4db4292b82d128ce5570aa835f5363a64eeef7c2bf6e8fbdd5b4d3b" },
  { n: "016", h: "c165145e333ffd6109e6f6e5e4d792ffd2a2446b704ca542b12c1097e1a76ef5" },
  { n: "017", h: "64911bbed61a3470d57bc5febba6dda608df2c0e16ad8b87cd35c6d3216bc123" },
  { n: "018", h: "b73c01619a12195cf0befb1301f7e5c53469b6300cd1f2c34d9f6bca9559910b" },
  { n: "019", h: "97e93a61bcff07ed46a76d8595bf0f62b42b90aec1a17e2e2001b85869b15186" },
  { n: "020", h: "e11bdbc1768590c99042327cfe614122600e4c9312266af4de2c827013b84dab" },
];

export const GATE_ENABLED = false;

const KEY = "gate_exp";
const DAYS = 30;

// 输入可以是 RB-ATLT-RXG7，也可以是 rbatltrxg7，统一成后者再哈希
export function normalize(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function gatePassed() {
  if (!GATE_ENABLED) return true;
  try {
    return Date.now() < Number(localStorage.getItem(KEY) || 0);
  } catch {
    return false;
  }
}

function remember() {
  try {
    localStorage.setItem(KEY, String(Date.now() + DAYS * 86400000));
  } catch {}
}

async function sha256(text) {
  if (!crypto?.subtle) throw new Error("当前环境不支持加密校验，请用 https 打开");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function checkCode(input) {
  const code = normalize(input);
  if (code.length < 6) return false;
  const h = await sha256(code);
  return CODES.some((c) => c.h === h);
}

// 链接里带 ?k=CDK 直接放行，方便发给客户：点开就进。
// 代价是码会留在浏览历史里，介意就让客户手输。
export async function tryUrlCode() {
  const k = new URLSearchParams(location.search).get("k");
  if (!k) return false;
  try {
    if (await checkCode(k)) {
      remember();
      return true;
    }
  } catch {}
  return false;
}

export function renderGate(root, onPass) {
  root.innerHTML = `<div class="gate">
    <div class="gate-box">
      <div class="mark"></div>
      <div class="gate-t">输入你的 CDK</div>
      <div class="gate-s">一客一码，输一次记 30 天<br>没有的话找卖家要</div>
      <input id="gateInput" inputmode="text" autocomplete="off" spellcheck="false"
             maxlength="14" placeholder="RB-XXXX-XXXX">
      <button id="gateGo">进入</button>
      <div class="gate-err" id="gateErr"></div>
      <div class="gate-note">不需要注册，码只用来确认你是买家。<br>对话只存在这台手机上。</div>
    </div>
  </div>`;

  const inp = root.querySelector("#gateInput");
  const btn = root.querySelector("#gateGo");
  const err = root.querySelector("#gateErr");
  let fails = 0;
  let lockedUntil = 0;

  // 边输边补连字符，看起来像卡号
  inp.addEventListener("input", () => {
    const raw = normalize(inp.value).slice(0, 10);
    let out = raw;
    if (raw.length > 2) out = raw.slice(0, 2) + "-" + raw.slice(2);
    if (raw.length > 6) out = out.slice(0, 7) + "-" + raw.slice(6);
    inp.value = out;
  });

  const submit = async () => {
    if (Date.now() < lockedUntil) return;
    btn.disabled = true;
    err.textContent = "";
    try {
      if (await checkCode(inp.value)) {
        remember();
        onPass();
        return;
      }
      fails++;
      inp.value = "";
      if (fails >= 5) {
        lockedUntil = Date.now() + 30000;
        err.textContent = "错太多次，等 30 秒再试";
      } else {
        err.textContent = "码不对，检查一下有没有少字符";
      }
      inp.focus();
    } catch (e) {
      err.textContent = e.message || "校验失败";
    } finally {
      btn.disabled = false;
    }
  };

  btn.onclick = submit;
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  setTimeout(() => inp.focus(), 120);
}
