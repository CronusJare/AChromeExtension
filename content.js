// @ts-check

const ContentCmd = {
    GetPageImages:     'GetPageImages',     // 返回图片 URL 列表（右键菜单用）
    GetPageImagesMeta: 'GetPageImagesMeta', // 返回含尺寸的图片元数据（popup 用）
};

// ── 被动：响应来自 background / popup 的消息 ───────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const minSize        = msg.data?.minSize ?? 0;
    const includeUnknown = msg.data?.includeUnknown ?? true;
    if (msg.cmd === ContentCmd.GetPageImages) {
        sendResponse({ data: collectPageImagesMeta(minSize, includeUnknown).map(m => m.url) });
    } else if (msg.cmd === ContentCmd.GetPageImagesMeta) {
        sendResponse({ data: collectPageImagesMeta(minSize, includeUnknown) });
    }
    return true;
});

// ── 主动：Alt+点击图片立即下载 ────────────────────────────────────
document.addEventListener('click', (e) => {
    if (!e.altKey) return;
    const img = /** @type {HTMLElement} */ (e.target).closest('img');
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();

    const url = /** @type {HTMLImageElement} */ (img).src;
    chrome.runtime.sendMessage({ cmd: 'DownloadImage', data: { url } }, (res) => {
        if (res?.error) showToast(`下载失败: ${res.error}`, true);
        else showToast('图片下载中…');
    });
}, true);

// ── 扫描页面所有图片，返回含尺寸的元数据 ─────────────────────────
/**
 * @param {number} [minSize]
 * @param {boolean} [includeUnknown]
 * @returns {{ url: string, name: string, width: number, height: number }[]}
 */
function collectPageImagesMeta(minSize = 0, includeUnknown = true) {
    const seen = new Set();
    /** @type {{ url: string, name: string, width: number, height: number }[]} */
    const result = [];

    /** @param {string | undefined} url @param {number} w @param {number} h */
    function add(url, w, h) {
        if (!isValidUrl(url) || seen.has(url)) return;
        seen.add(url);
        result.push({ url, name: urlFilename(url), width: w, height: h });
    }

    // <img> 标签：src、各种懒加载 data-* 属性、srcset（取最大分辨率）
    document.querySelectorAll('img').forEach((img) => {
        const i = /** @type {HTMLImageElement} */ (img);
        const w = i.naturalWidth;
        const h = i.naturalHeight;

        // 已加载的图片按像素尺寸过滤；未加载（naturalWidth===0）不过滤，避免漏掉懒加载图片
        if (minSize > 0 && w > 0 && w < minSize && h < minSize) return;

        [i.src, i.dataset.src, i.dataset.lazySrc, i.dataset.original, i.dataset.lazy, i.dataset.url]
            .forEach(u => add(u, w, h));

        if (i.srcset) {
            const best = parseSrcset(i.srcset);
            if (best) add(best, w, h);
        }
    });

    // <picture><source srcset="..."> — 尺寸未知
    document.querySelectorAll('source[srcset]').forEach((src) => {
        const best = parseSrcset(/** @type {HTMLSourceElement} */ (src).srcset);
        if (best) add(best, 0, 0);
    });

    // CSS background-image — 尺寸未知
    document.querySelectorAll('*').forEach((el) => {
        const bg = getComputedStyle(el).backgroundImage;
        const match = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
        if (match) add(match[1], 0, 0);
    });

    return includeUnknown ? result : result.filter(m => m.width > 0 || m.height > 0);
}

/**
 * 从 srcset 字符串中取宽度最大（或排列最后）的 URL。
 * @param {string} srcset
 * @returns {string | null}
 */
function parseSrcset(srcset) {
    const entries = srcset.split(',').map(s => {
        const [url, descriptor = ''] = s.trim().split(/\s+/);
        const w = parseFloat(descriptor) || 0;
        return { url, w };
    }).filter(e => isValidUrl(e.url));

    if (!entries.length) return null;
    return entries.reduce((best, e) => e.w > best.w ? e : best).url;
}


/** @param {string | undefined} url @returns {boolean} */
function isValidUrl(url) {
    if (!url || url.startsWith('data:')) return false;
    try { new URL(url); return true; } catch { return false; }
}

/** @param {string} url @returns {string} */
function urlFilename(url) {
    try {
        return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
    } catch {
        return url;
    }
}

/** @param {string} text @param {boolean} [isError] */
function showToast(text, isError = false) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
        position:     'fixed',
        bottom:       '24px',
        right:        '24px',
        zIndex:       '2147483647',
        padding:      '10px 18px',
        borderRadius: '8px',
        fontSize:     '14px',
        color:        '#fff',
        background:   isError ? '#e53935' : '#323232',
        boxShadow:    '0 2px 8px rgba(0,0,0,.35)',
        transition:   'opacity .4s',
        opacity:      '1',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2000);
    setTimeout(() => { el.remove(); }, 2500);
}
