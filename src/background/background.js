chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'quickshot-visible',
      title: 'QuickShot: Capture Visible Area',
      contexts: ['page', 'image', 'link']
    });
    chrome.contextMenus.create({
      id: 'quickshot-fullpage',
      title: 'QuickShot: Capture Full Page',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'quickshot-area',
      title: 'QuickShot: Select Area',
      contexts: ['page']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const typeMap = {
    'quickshot-fullpage': 'CAPTURE_FULL_PAGE',
    'quickshot-area': 'CAPTURE_AREA',
  };
  const type = typeMap[info.menuItemId] || 'CAPTURE_VISIBLE';
  handleCapture(tab.id, type, { download: true, clipboard: false });
});

// Long-lived ports (survive popup close)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'quickshot-area') {
    port.onMessage.addListener(async msg => {
      if (msg.type === 'AREA_CAPTURE_STRIP') {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
          port.postMessage({ type: 'STRIP_RESULT', dataUrl });
        } catch (e) {
          port.postMessage({ type: 'STRIP_ERROR', error: e.message });
        }
      }
      if (msg.type === 'AREA_RESULT') {
        handleOutput(msg.dataUrl, { download: msg.download, clipboard: msg.clipboard, radius: msg.radius || 0 }, port.sender.tab.id);
      }
    });
  }
});

// Send to content script, silently ignoring connection errors
function safeSendMessage(tabId, msg) {
  chrome.tabs.get(tabId, tab => {
    if (chrome.runtime.lastError) return;
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:')) {
      console.warn('QuickShot: cannot run on', url);
      return;
    }
    chrome.tabs.sendMessage(tabId, msg, () => { chrome.runtime.lastError; /* suppress */ });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_VISIBLE') {
    captureVisible(msg.tabId).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_STRIP') {
    captureVisible(msg.tabId).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_FULL_PAGE') {
    captureFullPage(msg.tabId).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_AREA') {
    ensureContentScript(msg.tabId).then(() => {
      safeSendMessage(msg.tabId, { type: 'START_AREA_CAPTURE', options: { download: msg.download, clipboard: msg.clipboard, radius: msg.radius || 0, rememberLastArea: msg.rememberLastArea || false } });
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download({
      url: msg.dataUrl,
      filename: `quickshot/quickshot-${new Date().toISOString().slice(0,19).replace('T','-').replace(/:/g,'-')}.png`,
      saveAs: false
    });
    sendResponse({ ok: true });
  }
  if (msg.type === 'OPEN_ANNOTATION') {
    ensureContentScript(msg.tabId).then(() => {
      safeSendMessage(msg.tabId, { type: 'OPEN_ANNOTATION', dataUrl: msg.dataUrl });
    });
    sendResponse({ ok: true });
  }
});

async function captureVisible(tabId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  if (!tabId) return { dataUrl };

  // Crop out the scrollbar by using clientWidth/clientHeight (excludes scrollbars)
  const cropped = await chrome.scripting.executeScript({
    target: { tabId },
    func: (dataUrl) => new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(document.documentElement.clientWidth * dpr);
        const h = Math.round(document.documentElement.clientHeight * dpr);
        if (w >= img.width && h >= img.height) { resolve(dataUrl); return; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, w, h, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    }),
    args: [dataUrl]
  }).then(r => r[0].result).catch(() => dataUrl);

  return { dataUrl: cropped };
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js']
    });
  } catch (e) {
    if (!e.message?.includes('already been injected')) {
      console.warn('QuickShot: content script injection failed:', e.message);
    }
  }
}

async function captureFullPage(tabId) {
  await ensureContentScript(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'START_FULL_CAPTURE' }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve({ dataUrl: response.dataUrl });
    });
  });
}

function applyRoundedCornersInTab(tabId, dataUrl, radius) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (dataUrl, radius) => {
      return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width  = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          const r = Math.min(radius, img.width / 2, img.height / 2);
          ctx.beginPath();
          ctx.moveTo(r, 0);
          ctx.lineTo(img.width - r, 0);
          ctx.quadraticCurveTo(img.width, 0, img.width, r);
          ctx.lineTo(img.width, img.height - r);
          ctx.quadraticCurveTo(img.width, img.height, img.width - r, img.height);
          ctx.lineTo(r, img.height);
          ctx.quadraticCurveTo(0, img.height, 0, img.height - r);
          ctx.lineTo(0, r);
          ctx.quadraticCurveTo(0, 0, r, 0);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        };
        img.src = dataUrl;
      });
    },
    args: [dataUrl, radius]
  }).then(results => results[0].result);
}

async function handleOutput(dataUrl, options, tabId) {
  const radius = options.radius || 0;
  if (radius > 0) {
    try { dataUrl = await applyRoundedCornersInTab(tabId, dataUrl, radius); } catch (_) {}
  }
  if (options.download) {
    chrome.downloads.download({
      url: dataUrl,
      filename: `quickshot/quickshot-${new Date().toISOString().slice(0,19).replace('T','-').replace(/:/g,'-')}.png`,
      saveAs: false
    });
  }
  if (options.clipboard) {
    chrome.scripting.executeScript({
      target: { tabId },
      func: (dataUrl) => {
        fetch(dataUrl).then(r => r.blob()).then(blob => {
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        });
      },
      args: [dataUrl]
    });
  }
}

async function handleCapture(tabId, type, options) {
  try {
    if (type === 'CAPTURE_FULL_PAGE') {
      const { dataUrl } = await captureFullPage(tabId);
      handleOutput(dataUrl, options, tabId);
    } else if (type === 'CAPTURE_AREA') {
      await ensureContentScript(tabId);
      safeSendMessage(tabId, { type: 'START_AREA_CAPTURE', options });
    } else {
      const { dataUrl } = await captureVisible(tabId);
      handleOutput(dataUrl, options, tabId);
    }
  } catch (e) {
    console.error('QuickShot capture error:', e);
  }
}
