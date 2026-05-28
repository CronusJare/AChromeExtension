// @ts-check

// ── 指令名称常量 ────────────────────────────────────────────────────────────
// 用对象代替裸字符串，避免拼错时静默失败
const BgCmd = {
    DownloadImage: 'DownloadImage', // 下载单张图片
    DownloadAll:   'DownloadAll',   // 批量下载
    GetStats:      'GetStats',      // 查询已下载数量
};

const ContentCmd = {
    GetPageImages: 'GetPageImages', // 让 content.js 收集页面图片 URL 列表
};

// ── 消息路由 ────────────────────────────────────────────────────────────────
// 统一管理所有来自 popup / content.js 的消息，避免一堆 if-else
class MessageRouter {
    constructor() {
        /** @type {Map<string, (data: any, sender: chrome.runtime.MessageSender) => any>} */
        this.handlers = new Map();
    }

    /** 注册某个 cmd 的处理函数 */
    /** @param {string} cmd @param {(data: any, sender: chrome.runtime.MessageSender) => any} handler */
    on(cmd, handler) {
        this.handlers.set(cmd, handler);
        return this; // 支持链式调用
    }

    /** 收到消息后找到对应 handler 执行，统一包装返回 {data} 或 {error} */
    /** @param {{cmd: string, data: any}} msg @param {chrome.runtime.MessageSender} sender */
    async handle(msg, sender) {
        const handler = this.handlers.get(msg.cmd);
        if (!handler) return { error: 'Unknown cmd: ' + msg.cmd };
        try {
            return { data: await handler(msg.data, sender) };
        } catch (err) {
            return { error: /** @type {Error} */ (err).message };
        }
    }
}

// ── 状态 ────────────────────────────────────────────────────────────────────
let downloadCount = 0;

// 记录"已发起但还没完成"的下载，key 是 chrome.downloads 返回的 downloadId
// 用途：onChanged 监听到下载中断时，能拿到原始 url/tabId 发起第二阶段重试
/** @type {Map<number, {url: string, filename: string, tabId: number|null}>} */
const pendingDownloads = new Map();

// ── 注册消息处理 ─────────────────────────────────────────────────────────────
const router = new MessageRouter();

router
    .on(BgCmd.DownloadImage, ({ url }, sender) =>
        // sender.tab 是发消息的标签页（content.js / Alt+点击 来的消息会带 tab）
        downloadImage(url, sender.tab?.id ?? null))

    .on(BgCmd.DownloadAll, ({ urls, tabId }, sender) =>
        // popup 发来的消息不带 sender.tab，所以 tabId 从 data 里传过来
        Promise.all(urls.map(/** @param {string} u */ u =>
            downloadImage(u, tabId ?? sender.tab?.id ?? null))))

    .on(BgCmd.GetStats, () => ({ count: downloadCount }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    router.handle(msg, sender).then(sendResponse);
    return true; // 告诉 Chrome 我们会异步调用 sendResponse，不要关闭通道
});

// ── 右键菜单 ─────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: 'download-one', title: '下载图片',       contexts: ['image'] });
    chrome.contextMenus.create({ id: 'download-all', title: '下载页面所有图片', contexts: ['page']  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const tabId = tab?.id ?? null;
    if (info.menuItemId === 'download-one' && info.srcUrl) {
        await downloadImage(info.srcUrl, tabId);
    }
    if (info.menuItemId === 'download-all' && tabId) {
        // 让 content.js 扫描页面，返回图片 URL 列表
        const res = await chrome.tabs.sendMessage(tabId, { cmd: ContentCmd.GetPageImages });
        for (const url of res?.data ?? []) {
            await downloadImage(url, tabId);
        }
    }
});

// ── 下载中断监听（第二阶段兜底）────────────────────────────────────────────
// 有些站点第一阶段下载会启动，但中途被服务端中断（403/302 到登录页等）
// onChanged 能感知到这种中断，此时切换到第二阶段重试
chrome.downloads.onChanged.addListener(async (change) => {
    if (change.state?.current !== 'interrupted') return;
    const pending = pendingDownloads.get(change.id);
    if (!pending) return;
    pendingDownloads.delete(change.id);
    if (!pending.tabId) return; // 没有 tabId 无法注入，放弃

    console.log('[onChanged] 下载中断，切换第二阶段重试', pending.url);
    try {
        await downloadViaScripting(pending.url, pending.tabId, pending.filename);
    } catch {
        // 第二阶段也失败（页面已关闭等），静默放弃
    }
});

// ── 核心下载函数 ─────────────────────────────────────────────────────────────
/**
 * 两阶段下载策略（参考 Billfish 设计）：
 *
 * 第一阶段：Service Worker 直接调用 chrome.downloads.download
 *   - 速度快，无额外开销
 *   - 缺点：SW 没有站点 Cookie，遇到需要登录的图片会失败
 *
 * 第二阶段：scripting.executeScript 把 fetch 注入到目标 Tab 执行
 *   - fetch 运行在用户已登录的页面环境中
 *   - 浏览器自动附带该站点的 Cookie 和正确的 Referer
 *   - 适用于微博、Pinterest 等需要登录才能访问的图片
 *
 * @param {string} url
 * @param {number|null} [tabId]
 */
async function downloadImage(url, tabId = null) {
    const filename = 'images/' + getFilenameFromUrl(url);

    // ── 第一阶段：SW 直接下载 ──────────────────────────────────────────────
    return new Promise((resolve, reject) => {
        chrome.downloads.download(
            { url, filename, conflictAction: 'uniquify', saveAs: false },
            (downloadId) => {
                if (chrome.runtime.lastError) {
                    // API 调用本身就失败了（跨域限制、URL 格式错误等）
                    // 如果有 tabId，立即尝试第二阶段；否则只能放弃
                    if (tabId) {
                        console.log('[downloadImage] 第一阶段 API 失败，切换第二阶段', url);
                        downloadViaScripting(url, tabId, filename).then(resolve).catch(reject);
                    } else {
                        reject(new Error(chrome.runtime.lastError.message));
                    }
                } else {
                    // 下载已发起，存入 pendingDownloads
                    // 若后续 onChanged 检测到中断，会再次触发第二阶段
                    pendingDownloads.set(downloadId, { url, filename, tabId });
                    downloadCount++;
                    updateBadge();
                    resolve(downloadId);
                }
            }
        );
    });
}

/**
 * 第二阶段：通过 scripting.executeScript 把 fetchBlob 注入到目标 Tab 执行
 *
 * 关键：func 里的代码在目标页面上下文运行，不是 Service Worker
 * 浏览器因此自动附带该站点的 Cookie（same-origin 默认行为）
 *
 * @param {string} url
 * @param {number} tabId
 * @param {string} filename
 */
async function downloadViaScripting(url, tabId, filename) {
    console.log('[downloadViaScripting] 第二阶段，页面环境 fetch', url);

    // 将 fetchBlob 注入到 tabId 对应的页面执行，拿回 blob URL
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: fetchBlobInPage,  // 这个函数会被序列化后发到页面执行
        args:  [url],
    });

    const blobUrl = results?.[0]?.result;
    if (!blobUrl) throw new Error('fetchBlobInPage 未返回结果');

    // 用拿到的 blob URL 发起下载（blob URL 只在页面上下文有效，需立即下载）
    return new Promise((resolve, reject) => {
        chrome.downloads.download(
            { url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false },
            (downloadId) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(downloadId);
            }
        );
    });
}

/**
 * 此函数会被 scripting.executeScript 序列化后注入到目标页面执行。
 *
 * 注意：这里不能引用外部变量，因为注入后是一个独立的执行上下文。
 * fetch 在页面环境运行 → 浏览器自动附带 Cookie 和 Referer。
 *
 * @param {string} url
 * @returns {Promise<string>} blob URL
 */
async function fetchBlobInPage(url) {
    const res = await fetch(url, {
        credentials: 'include',                    // 携带站点 Cookie（登录态）
        referrerPolicy: 'no-referrer-when-downgrade', // 同域/降级时带 Referer
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob); // 返回 blob URL 给 Service Worker 使用
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────
/** @param {string} url @returns {string} */
function getFilenameFromUrl(url) {
    try {
        const name = new URL(url).pathname.split('/').pop();
        return name?.includes('.') ? name : `img_${Date.now()}.jpg`;
    } catch {
        return `img_${Date.now()}.jpg`;
    }
}

function updateBadge() {
    chrome.action.setBadgeText({ text: String(downloadCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#2196F3' });
}
