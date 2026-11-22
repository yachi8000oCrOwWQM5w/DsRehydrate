// 离线缓存（网络优先版）
//
// 之前的版本是"缓存优先"，结果每次发布新版本，浏览器都拿旧的缓存在跑。
// 现在改成：联网时永远走网络拿最新的；断网才回退到缓存。
// 代价是每次打开多一次请求，本地几十 KB，可以忽略。

const CACHE = "rehydrate-v47";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./zip.js",
  "./zipwrite.js",
  "./parse.js",
  "./gate.js",
  "./manifest.webmanifest",
  "./vendor/markdown-it/markdown-it.min.js",
  "./vendor/katex/katex.min.css",
  "./vendor/katex/katex.min.js",
  "./vendor/katex/contrib/auto-render.min.js",
  "./vendor/katex/fonts/KaTeX_AMS-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_AMS-Regular.woff",
  "./vendor/katex/fonts/KaTeX_AMS-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Caligraphic-Bold.ttf",
  "./vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff",
  "./vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2",
  "./vendor/katex/fonts/KaTeX_Caligraphic-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Fraktur-Bold.ttf",
  "./vendor/katex/fonts/KaTeX_Fraktur-Bold.woff",
  "./vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2",
  "./vendor/katex/fonts/KaTeX_Fraktur-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Fraktur-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Main-Bold.ttf",
  "./vendor/katex/fonts/KaTeX_Main-Bold.woff",
  "./vendor/katex/fonts/KaTeX_Main-Bold.woff2",
  "./vendor/katex/fonts/KaTeX_Main-BoldItalic.ttf",
  "./vendor/katex/fonts/KaTeX_Main-BoldItalic.woff",
  "./vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2",
  "./vendor/katex/fonts/KaTeX_Main-Italic.ttf",
  "./vendor/katex/fonts/KaTeX_Main-Italic.woff",
  "./vendor/katex/fonts/KaTeX_Main-Italic.woff2",
  "./vendor/katex/fonts/KaTeX_Main-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Main-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Main-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Math-BoldItalic.ttf",
  "./vendor/katex/fonts/KaTeX_Math-BoldItalic.woff",
  "./vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2",
  "./vendor/katex/fonts/KaTeX_Math-Italic.ttf",
  "./vendor/katex/fonts/KaTeX_Math-Italic.woff",
  "./vendor/katex/fonts/KaTeX_Math-Italic.woff2",
  "./vendor/katex/fonts/KaTeX_SansSerif-Bold.ttf",
  "./vendor/katex/fonts/KaTeX_SansSerif-Bold.woff",
  "./vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2",
  "./vendor/katex/fonts/KaTeX_SansSerif-Italic.ttf",
  "./vendor/katex/fonts/KaTeX_SansSerif-Italic.woff",
  "./vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2",
  "./vendor/katex/fonts/KaTeX_SansSerif-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_SansSerif-Regular.woff",
  "./vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Script-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Script-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Script-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Size1-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Size1-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Size1-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Size2-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Size2-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Size2-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Size3-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Size3-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Size3-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Size4-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Size4-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Size4-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Typewriter-Regular.ttf",
  "./vendor/katex/fonts/KaTeX_Typewriter-Regular.woff",
  "./vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API 请求不接管

  e.respondWith(
    fetch(req, { cache: "no-store" })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match("./index.html"))
      )
  );
});
