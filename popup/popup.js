// @ts-check

/** @param {string} cmd @param {any} [data] */
async function callBg(cmd, data) {
    return chrome.runtime.sendMessage({ cmd, data });
}

/** @param {string} cmd @param {any} [data] */
async function callContent(cmd, data) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { cmd, data });
}

/** @type {{ url: string, name: string, width: number, height: number }[]} */
let cachedMeta = [];

/** @param {HTMLElement} list @param {typeof cachedMeta} meta */
function renderList(list, meta) {
    if (!meta.length) {
        list.innerHTML = '';
        return;
    }
    list.innerHTML =
        `<div class="list-header">
            <input type="checkbox" id="chk-all" checked>
            <label for="chk-all">全选（共 ${meta.length} 张）</label>
        </div>` +
        meta.map((m, i) => {
            const dim = (m.width && m.height) ? `${m.width}×${m.height}` : '尺寸未知';
            return `<div class="img-item">
                <input type="checkbox" class="img-chk" data-i="${i}" checked>
                <span class="img-name" title="${m.url}">${m.name}</span>
                <span class="img-dim">${dim}</span>
            </div>`;
        }).join('');

    // 全选 checkbox
    const chkAll = /** @type {HTMLInputElement} */ (list.querySelector('#chk-all'));
    const chkAll_onChange = () => {
        list.querySelectorAll('.img-chk').forEach(c => {
            /** @type {HTMLInputElement} */ (c).checked = chkAll.checked;
        });
    };
    chkAll.addEventListener('change', chkAll_onChange);

    // 子项变化时同步全选状态
    list.querySelectorAll('.img-chk').forEach(c => {
        c.addEventListener('change', () => {
            const all  = list.querySelectorAll('.img-chk');
            const checked = list.querySelectorAll('.img-chk:checked');
            chkAll.indeterminate = checked.length > 0 && checked.length < all.length;
            chkAll.checked = checked.length === all.length;
        });
    });
}

/** @param {HTMLElement} list @returns {string[]} */
function getSelectedUrls(list) {
    return [...list.querySelectorAll('.img-chk:checked')]
        .map(c => cachedMeta[Number(/** @type {HTMLElement} */ (c).dataset.i)]?.url)
        .filter(Boolean);
}

document.addEventListener('DOMContentLoaded', async () => {
    const status         = /** @type {HTMLElement} */      (document.getElementById('status'));
    const slider         = /** @type {HTMLInputElement} */ (document.getElementById('min-size'));
    const sizeVal        = /** @type {HTMLElement} */      (document.getElementById('size-val'));
    const list           = /** @type {HTMLElement} */      (document.getElementById('img-list'));
    const includeUnknown = /** @type {HTMLInputElement} */ (document.getElementById('include-unknown'));

    // 读取并显示当前下载数量
    const stats = await callBg('GetStats');
    document.getElementById('count').textContent = stats?.data?.count ?? 0;

    async function refreshList() {
        const minSize = parseInt(slider.value, 10);
        const withUnknown = includeUnknown.checked;
        try {
            const res = await callContent('GetPageImagesMeta', { minSize, includeUnknown: withUnknown });
            cachedMeta = res?.data ?? [];
        } catch {
            cachedMeta = [];
        }
        renderList(list, cachedMeta);
    }

    // 初始加载列表
    await refreshList();

    // 滑块变化：更新数值显示 + 防抖刷新列表
    let debounceTimer = 0;
    function scheduleRefresh() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(refreshList, 200);
    }
    slider.addEventListener('input', () => { sizeVal.textContent = slider.value; scheduleRefresh(); });
    includeUnknown.addEventListener('change', scheduleRefresh);

    document.getElementById('btn-all').addEventListener('click', async () => {
        const urls = getSelectedUrls(list);
        if (!urls.length) {
            status.textContent = cachedMeta.length ? '请至少勾选一张图片' : '未找到任何图片';
            return;
        }

        status.textContent = `正在下载 ${urls.length} 张…`;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await callBg('DownloadAll', { urls, tabId: tab?.id ?? null });
        status.textContent = `✓ 已发起 ${urls.length} 张下载任务`;

        const updated = await callBg('GetStats');
        document.getElementById('count').textContent = updated?.data?.count ?? 0;
    });
});
