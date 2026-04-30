chrome.runtime.onInstalled.addListener(() => {
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
          const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
          port.postMessage({ type: 'STRIP_RESULT', dataUrl });
        } catch (e) {
          port.postMessage({ type: 'STRIP_ERROR', error: e.message });
        }
      }
      if (msg.type === 'AREA_RESULT') {
        handleOutput(msg.dataUrl, { download: msg.download, clipboard: msg.clipboard }, port.sender.tab.id);
      }
    });
  }

  if (port.name === 'quickshot-frame') {
    port.onMessage.addListener(async msg => {
      if (msg.type === 'FRAME_CAPTURE_STRIP') {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
          port.postMessage({ type: 'STRIP_RESULT', dataUrl });
        } catch (e) {
          port.postMessage({ type: 'STRIP_ERROR', error: e.message });
        }
      }
      if (msg.type === 'FRAME_RESULT') {
        handleOutput(msg.dataUrl, { download: msg.download, clipboard: msg.clipboard }, port.sender.tab.id);
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
    captureVisible().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_STRIP') {
    captureVisible().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_FULL_PAGE') {
    captureFullPage(msg.tabId).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_AREA') {
    safeSendMessage(msg.tabId, { type: 'START_AREA_CAPTURE', options: { download: msg.download, clipboard: msg.clipboard } });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'PLACE_FRAME') {
    safeSendMessage(msg.tabId, { type: 'START_FRAME_CAPTURE', w: msg.w, h: msg.h, options: { download: msg.download, clipboard: msg.clipboard } });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download({
      url: msg.dataUrl,
      filename: `quickshot-${Date.now()}.png`,
      saveAs: false
    });
    sendResponse({ ok: true });
  }
});

async function captureVisible() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  return { dataUrl };
}

async function captureFullPage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'START_FULL_CAPTURE' }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve({ dataUrl: response.dataUrl });
    });
  });
}

function handleOutput(dataUrl, options, tabId) {
  if (options.download) {
    chrome.downloads.download({
      url: dataUrl,
      filename: `quickshot-${Date.now()}.png`,
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
      safeSendMessage(tabId, { type: 'START_AREA_CAPTURE', options });
    } else {
      const { dataUrl } = await captureVisible();
      handleOutput(dataUrl, options, tabId);
    }
  } catch (e) {
    console.error('QuickShot capture error:', e);
  }
}
