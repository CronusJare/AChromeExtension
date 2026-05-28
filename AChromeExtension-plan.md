# 图片下载 Chrome 插件 — 开发设计文档

> 目标：右键 / Alt+点击把网页图片下载到本地 Downloads 文件夹，支持需要登录的站点（Pinterest 等）。
> 参考：Billfish 插件源码（billfish）

---

## 一、文件结构

```
AChromeExtension/
├── manifest.json          ← 插件配置、权限声明
├── background.js          ← Service Worker（下载核心逻辑）
├── content.js             ← 注入到每个网页（感知用户操作、扫描图片）
└── popup/
    ├── index.html         ← 弹窗 UI
    └── popup.js           ← 弹窗逻辑
```

---

## 二、manifest.json

```json
{
  "manifest_version": 3,
  "permissions": [
    "downloads",    // chrome.downloads.download
    "contextMenus", // 右键菜单
    "activeTab",    // 访问当前标签页
    "scripting"     // executeScript 注入 fetch（两阶段下载的关键）
  ],
  "host_permissions": ["http://*/*", "https://*/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{ "matches": ["http://*/*", "https://*/*"], "js": ["content.js"] }],
  "action": { "default_popup": "popup/index.html" }
}
```

---

## 三、background.js — Service Worker

### 设计模式一：枚举指令对象

用对象代替裸字符串，拼错时 JS 引擎会报 undefined 而不是静默失败。

```js
const BgCmd = {
    DownloadImage: 'DownloadImage', // 下载单张图片
    DownloadAll:   'DownloadAll',   // 批量下载
    GetStats:      'GetStats',      // 查询已下载数量
};
const ContentCmd = {
    GetPageImages:     'GetPageImages',     // 让 content.js 返回 URL 列表（右键菜单用）
    GetPageImagesMeta: 'GetPageImagesMeta', // 返回含尺寸的元数据（popup 用）
};
```

### 设计模式二：MessageRouter 消息路由

统一管理所有来自 popup / content.js 的消息，避免一堆 if-else。

```js
class MessageRouter {
    on(cmd, handler) { ... }               // 注册某 cmd 的处理函数
    async handle(msg, sender) { ... }      // 收到消息 → 找 handler → 统一包装 {data} 或 {error}
}

router
    .on(BgCmd.DownloadImage, ({ url }, sender) => downloadImage(url, sender.tab?.id))
    .on(BgCmd.DownloadAll,   ({ urls, tabId }, sender) => Promise.all(urls.map(u => downloadImage(u, tabId))))
    .on(BgCmd.GetStats,      () => ({ count: downloadCount }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    router.handle(msg, sender).then(sendResponse);
    return true; // 告诉 Chrome 我们会异步调用 sendResponse
});
```

### 核心：两阶段下载策略（借鉴 Billfish）

```
第一阶段：Service Worker 直接调用 chrome.downloads.download
    优点：快，无额外开销
    缺点：SW 没有站点 Cookie，遇到需要登录的图片会被 403

第二阶段：scripting.executeScript 把 fetch 注入到目标 Tab 执行
    关键：fetch 运行在用户已登录的页面环境中
    浏览器自动附带该站点的 Cookie 和正确的 Referer
    适用：微博、Pinterest 等需要登录才能访问的图片
```

触发第二阶段的两种情况：
1. 第一阶段 API 调用本身失败（跨域限制、URL 格式错误等）→ 立即切换
2. 第一阶段下载启动后被服务端中断（`onChanged` 检测到 `interrupted`）→ 重试

```js
// 注入到目标页面执行的函数（不能引用外部变量）
async function fetchBlobInPage(url) {
    const res = await fetch(url, {
        credentials: 'include',               // 携带站点 Cookie（登录态）
        referrerPolicy: 'no-referrer-when-downgrade',
    });
    const blob = await res.blob();
    return URL.createObjectURL(blob);         // 返回 blob URL 给 SW 使用
}

async function downloadViaScripting(url, tabId, filename) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: fetchBlobInPage,
        args: [url],
    });
    const blobUrl = results?.[0]?.result;
    // 再用 blobUrl 调用 chrome.downloads.download
}
```

**对比 Billfish**：Billfish 也是完全一样的两阶段策略，SW fetch 失败后用 `executeScript` 注入 fetch 到 tab。Cookie 不是主动拼接到请求头的，而是靠页面执行上下文自动携带。

---

## 四、content.js — 注入到每个网页

两个职责：

**1. 被动：响应来自 background / popup 的消息**

```js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.cmd === 'GetPageImages')     sendResponse({ data: collectPageImagesMeta(...).map(m => m.url) });
    if (msg.cmd === 'GetPageImagesMeta') sendResponse({ data: collectPageImagesMeta(...) });
    return true;
});
```

**2. 主动：Alt+点击图片立即下载**

```js
document.addEventListener('click', (e) => {
    if (!e.altKey) return;
    const img = e.target.closest('img');
    if (!img) return;
    e.preventDefault();
    chrome.runtime.sendMessage({ cmd: 'DownloadImage', data: { url: img.src } }, (res) => {
        if (res?.error) showToast('下载失败: ' + res.error, true);
        else showToast('图片下载中…');
    });
}, true); // 捕获阶段，避免被页面事件拦截
```

**collectPageImagesMeta** 扫描以下来源：
- `<img>` 的 `src`、`data-src`、`data-lazy-src`、`srcset`（取最大分辨率）
- `<picture><source srcset>`
- CSS `background-image`

返回格式：`{ url, name, width, height }[]`，width/height 为 0 表示尺寸未知（懒加载未触发等）。

> 注意：`FetchAsBase64` 已删除。fetch 逻辑统一由 background.js 的 `fetchBlobInPage` 通过 `executeScript` 注入执行，不再经过消息传递。

---

## 五、popup/index.html + popup.js

**UI 功能：**
- 显示本次已下载数量
- 最小尺寸滑块（0–800px，防抖 200ms 刷新列表）
- "包含尺寸未知" 开关
- 图片列表（每项带 checkbox）+ 顶部全选 checkbox（支持半选状态）
- "下载页面所有图片" 按钮 → 只下载勾选项

**数据流：**
```
popup.js
  → callContent('GetPageImagesMeta', {minSize, includeUnknown})
  → content.js 扫描并返回 [{url, name, width, height}]
  → renderList() 渲染列表

点击下载
  → getSelectedUrls() 收集勾选的 URL
  → callBg('DownloadAll', { urls, tabId })
  → background.js 两阶段下载
```

> `tabId` 由 popup.js 用 `chrome.tabs.query` 取得后传给 background，确保第二阶段能找到正确的 tab 注入 fetch。

---

## 六、实现顺序

| 步骤 | 写什么 | 验证方式 | 状态 |
|------|--------|---------|------|
| 1 | `manifest.json` | `chrome://extensions` 加载不报错 | ✅ |
| 2 | `background.js` — 右键菜单 + 基础 `downloadImage` | 右键图片点击能下载 | ✅ |
| 3 | `background.js` — `MessageRouter` + `GetStats` | Service Worker 控制台：`router.handle({cmd:'GetStats',data:null},{}).then(console.log)` | ✅ |
| 4 | `content.js` — Alt+点击 + Toast + `collectPageImagesMeta` | Alt 点图片下载，右下角出现 Toast | ✅ |
| 5 | `background.js` — 两阶段下载（`executeScript` + Cookie） | 下载需要登录的站点图片能成功 | ✅ |
| 6 | `popup/index.html` + `popup.js` — 完整 UI | 弹窗显示图片列表，checkbox 勾选后下载 | ✅ |

---

## 七、与 Billfish 的设计对比

| 功能模块 | Billfish 做法 | 本插件做法 |
|----------|--------------|-----------|
| 消息路由 | `CommandInvoker`（Map + TypeScript 枚举） | `MessageRouter` 类，相同思路 |
| 指令定义 | `BackgroundCmd`（31条）`ContentCmd`（19条） | `BgCmd`（3条）`ContentCmd`（2条） |
| 两阶段下载 | SW fetch 失败 → `executeScript` 注入 fetch | 完全相同策略 |
| Cookie 注入 | 页面上下文执行 fetch，浏览器自动携带 | 完全相同机制 |
| 图片扫描 | `<img>`、srcset、CSS bg、懒加载属性 | 相同，额外支持 `data-lazy-src` 等 |
| 数据目标 | POST 给本地桌面客户端 | `chrome.downloads`，无外部通信 |
| 持久化 | `chrome.storage.local` | 不需要 |

---

## 八、关键 Chrome API 速查

```js
// 下载文件
chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, callback)

// 监听下载状态变化（检测中断）
chrome.downloads.onChanged.addListener(change => { if (change.state?.current === 'interrupted') ... })

// 注入函数到目标页面执行（两阶段下载核心）
chrome.scripting.executeScript({ target: { tabId }, func: myFunc, args: [url] })

// 发消息给 background（从 content/popup 调用）
chrome.runtime.sendMessage({ cmd, data })

// 发消息给指定标签页的 content.js（从 background/popup 调用）
chrome.tabs.sendMessage(tabId, { cmd, data })

// 查询当前活动标签
chrome.tabs.query({ active: true, currentWindow: true })

// Service Worker 控制台测试 MessageRouter（绕过消息传递）
router.handle({ cmd: 'GetStats', data: null }, {}).then(console.log)
```
