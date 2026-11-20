# 续语 · DsRehydrate

把从 DeepSeek 导出的历史对话接回本地，用你自己的 API Key 继续聊。桌面端和手机 PWA 共用一套本地数据格式，图片、人设、锚点、思考过程都保留。

## 在线版 · 续语

**公网地址（必须带 sharecode）：**

[https://wbapp-vtlutfpxprgkrvaikbmocs.app.workbuddy.host/?sharecode=N4GSTG4GTQ](https://wbapp-vtlutfpxprgkrvaikbmocs.app.workbuddy.host/?sharecode=N4GSTG4GTQ)

> 不要只复制域名。`?sharecode=N4GSTG4GTQ` 是访问参数，缺了会返回 403。

**教学视频：** [B 站 · 续语使用教学](https://www.bilibili.com/video/BV1izsh65ET4/)

这是当前正在运行的**公网版本**，不用装 Python、不用建服务器，打开即用：

- 数据只保存在你自己的浏览器（IndexedDB），不上传
- 手机浏览器可“添加到主屏幕”，当作 App 使用
- API Key 在页面里的「设置 → 接口」自行填写
- 想完全本地运行，见下方「桌面版本地部署」

**作者 / 源码：** [github.com/yachi8000oCrOwWQM5w/DsRehydrate](https://github.com/yachi8000oCrOwWQM5w/DsRehydrate)

> 非 DeepSeek 官方项目，与 DeepSeek 无隶属关系。API 用量和费用由使用者自己的账号承担。


## 功能

- 导入 DeepSeek 导出的 ZIP，本地解析，不上传服务器
- 多段对话切换、角色人设、长期锚点、上下文预算
- 深度思考 / 智能搜索开关
- Markdown 渲染 + 本地 KaTeX 数学公式（离线可用）
- 消息复制、朗读、删除、重新生成
- 对话时间线：右侧细轨道与视口滑块，支持点击定位、按住拖动、悬停预览带日期的用户消息
- 全对话正文搜索：跨会话关键词命中，显示会话名、日期和片段，点击直接跳转
- 回车模式切换：一键在「Enter 发送 / Shift+Enter 换行」与「Enter 换行 / Shift+Enter 发送」之间切换，设置会记住
- 分对话草稿：每个对话未发送的内容单独保存，切换时不会丢
- 继续生成：回复因长度截断或手动停止后，可从中断处续写
- 错误提示带动作：区分 Key、余额、限流和服务错误，给出下一步入口
- 思考用时：完成后显示「已思考 N 秒」并可折叠
- 数据导出：完整 ZIP（可再导入）、JSON 备份、角色卡、JSONL
- 手机 PWA：可安装到桌面，断网后仍能打开

## 环境要求

| 项目 | 要求 |
|---|---|
| 桌面版 | Python 3.10+，**不需要 pip install** |
| 手机 PWA | 任意现代浏览器；离线/安装需要 HTTPS 或 localhost |
| API | DeepSeek 官方 API Key（也兼容 OpenAI 格式网关） |

## 桌面版本地部署

```bash
git clone https://github.com/yachi8000oCrOwWQM5w/DsRehydrate.git
cd DsRehydrate
python app.py
```

Windows 也可以直接双击 `start.bat`。

启动后访问：

```
http://127.0.0.1:8765
```

终端会同时打印局域网地址，手机连同一个 Wi-Fi 时可直接打开：

```
http://192.168.x.x:8765
```

常用环境变量：

```bash
PORT=9000            # 改端口
REHYDRATE_DATA=...   # 改数据目录
NO_BROWSER=1         # 启动时不自动打开浏览器
```

首次启动如果 Windows 防火墙弹窗，允许“专用网络”即可。

## 手机 PWA 部署

`mobile/` 是纯静态站点，不需要后端。

### 本机预览

```bash
cd mobile
python -m http.server 8080
```

打开 `http://localhost:8080`。localhost 属于安全上下文，Service Worker 和离线缓存可以正常工作。

### 手机上使用

手机通过局域网 IP 访问时是普通 HTTP，浏览器不会注册 Service Worker，**不能安装成 PWA，也没有离线能力**。要真正在手机上用，把 `mobile/` 部署到任意 HTTPS 静态托管：

- Cloudflare Pages：上传 `mobile/` 目录，无构建命令
- Netlify Drop：直接拖入 `mobile/` 目录
- Vercel / GitHub Pages：把 `mobile/` 作为站点根目录

**不要把 `data/` 一起部署。** 手机版的数据只存在访问者自己的浏览器里，服务器上不需要也不应该有数据目录。

### 关闭/恢复卡密门禁

`mobile/gate.js` 顶部：

```js
export const GATE_ENABLED = false;
```

默认关闭，所有人可直接进入。改成 `true` 并重新部署即可恢复 CDK 校验，`CODES` 数组里的哈希继续有效。

## 首次使用

1. 打开设置 → 接口
2. 填 API Key
3. Base URL 保持 `https://api.deepseek.com`
4. 模型选 `deepseek-flash`（便宜、支持图片）或 `deepseek-v4-pro`
5. 保存后回到首页，选择导出的 ZIP

导入说明：

- DeepSeek 网页版、手机 App / 客户端都可以导出
- 手机端如果不能直接下载，用「生成下载链接 → 复制到浏览器地址栏打开」
- 300MB 左右的包首次解析约 10–20 秒，解析期间不要切走页面

## 数据与隐私

- 桌面版：数据在 `data/`，`config.json` 含 API Key，**已被 `.gitignore` 排除**
- 手机版：数据在浏览器 IndexedDB / localStorage，不上传
- 本项目没有中转服务器；桌面版由本机 Python 进程直接请求 API
- 换手机或重装浏览器前，先在设置里导出 ZIP 备份

## 目录结构

```text
.
├─ app.py                 # 桌面版本地服务器（零依赖）
├─ start.bat              # Windows 启动脚本
├─ static/                # 桌面端前端
├─ mobile/                # 手机 PWA
│  ├─ app.js
│  ├─ style.css
│  ├─ parse.js            # DeepSeek ZIP / JSON 解析
│  ├─ zip.js              # 解压
│  ├─ zipwrite.js         # 打包导出
│  ├─ gate.js             # CDK 门禁（默认关闭）
│  └─ vendor/             # 本地 KaTeX / markdown-it
├─ listing/               # 宣传图与文案（可选）
└─ data/                  # 本地数据，不进入 git
```

## 第三方组件

- [KaTeX](https://katex.org/) 0.19.1 — MIT
- [markdown-it](https://github.com/markdown-it/markdown-it) 14.1.0 — MIT

许可证文件在各自 `vendor/` 目录下。

## 作者

- GitHub：[@yachi8000oCrOwWQM5w](https://github.com/yachi8000oCrOwWQM5w)
- 仓库：[DsRehydrate](https://github.com/yachi8000oCrOwWQM5w/DsRehydrate)
