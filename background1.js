// @ts-check

const BgCmd = {
  DownloadImage: 'DownloadImage',
  DownloadAll:   'DownloadAll',
  GetStats:      'GetStats',
};

const ContentCmd = {
  GetPageImages: 'GetPageImages',
};

class MessageRouter {
  constructor() {
    /** @type {Map<string, (data: any, sender: chrome.runtime.MessageSender) => any>} */
    this.handlers = new Map();
  }

  /** @param {string} cmd @param {(data: any, sender: chrome.runtime.MessageSender) => any} handler */
  on(cmd, handler) {
    this.handlers.set(cmd, handler);
    return this;
  }

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

let downloadCount = 0;

const router = new MessageRouter();

router
  .on(BgCmd.DownloadImage, (/** @type {{url: string}} */ { url }) => downloadImage(url))
  .on(BgCmd.DownloadAll,   (/** @type {{urls: string[]}} */ { urls }) => Promise.all(urls.map(u => downloadImage(u))))
  .on(BgCmd.GetStats,      () => ({ count: downloadCount }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  router.handle(msg, sender).then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'download-one',
    title: '下载图片',
    contexts: ['image'],
  });
  chrome.contextMenus.create({
    id: 'download-all',
    title: '下载页面所有图片',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    console.log("chrome.contextMenus.onClicked.addListener");
    if (info.menuItemId === 'download-one') {
        await downloadImage(info.srcUrl);
    }
    if (info.menuItemId === 'download-all') {
        const res = await chrome.tabs.sendMessage(tab.id, { cmd: ContentCmd.GetPageImages });
        for(const url of res?.data ?? []){
            await downloadImage(url);
        }
    }

});

async function downloadImage(url) {
    const filename='images/' + getFilenameFromUrl(url);

    return new Promise((resolve, reject) => {
        chrome.downloads.download(
            {url, filename, conflictAction: 'uniquify'},
            //use downloadId to receive result
            (downloadId) => {
                if (chrome.runtime.lastError){
                    fetchAsDataUrl(url)
                        .then(dataurl => chrome.downloads.download(
                            {url: dataurl, filename, conflictAction: 'uniquify'},
                            resolve //inform chrome done
                        ))
                        .catch(reject);
                }
                else {
                    downloadCount++;
                    updateBadge();
                    resolve(downloadId);
                }
            }
        );

    });
}

//Read image to memeory
async function fetchAsDataUrl(url) {
    const res       = await fetch(url);
    const buffer    = await res.arrayBuffer();
    const type      = res.headers.get('content-type') || 'image/jpeg';
    const b64       = btoa(
        new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), '')
    );
    return `data:${type};base64,${b64}`;
}   

function getFilenameFromUrl(url) {
    try{
        const name = new URL(url).pathname.split('/').pop();
        return name?.includes('.') ? name: `img_${Date.now()}.jpg`;
    } catch{
        return `img_${Date.now()}.jpg`;
    }
}

function updateBadge() {
    chrome.action.setBadgeText({text: String(downloadCount)});
    chrome.action.setBadgeBackgroundColor(
        {color: "#2196F3"}
    );
}