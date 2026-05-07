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
        handleOutput(msg.dataUrl, { download: msg.download, clipboard: msg.clipboard }, port.sender.tab.id);
      }
    });
  }
});

function safeSendMessage(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg, () => { chrome.runtime.lastError; /* suppress */ });
}

function sendCaptureResult(tabId, dataUrl, msg) {
  if (msg.annotate) {
    safeSendMessage(tabId, { type: 'OPEN_ANNOTATION', dataUrl });
  } else {
    safeSendMessage(tabId, { type: 'PROCESS_CAPTURE', dataUrl, download: msg.download, clipboard: msg.clipboard });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_VISIBLE') {
    captureVisible(msg.tabId)
      .then(({ dataUrl }) => ensureContentScript(msg.tabId).then(() => sendCaptureResult(msg.tabId, dataUrl, msg)))
      .catch(err => console.error('QuickShot visible capture error:', err));
    return true;
  }
  if (msg.type === 'CAPTURE_STRIP') {
    captureVisible(msg.tabId).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CAPTURE_FULL_PAGE') {
    captureFullPage(msg.tabId)
      .then(({ dataUrl }) => sendCaptureResult(msg.tabId, dataUrl, msg))
      .catch(err => console.error('QuickShot full page capture error:', err));
    return true;
  }
  if (msg.type === 'CAPTURE_AREA') {
    ensureContentScript(msg.tabId).then(() => {
      safeSendMessage(msg.tabId, { type: 'START_AREA_CAPTURE', options: { download: msg.download, clipboard: msg.clipboard, rememberLastArea: msg.rememberLastArea || false } });
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
  if (msg.type === 'CAPTURE_ELEMENT') {
    ensureContentScript(msg.tabId).then(() => {
      safeSendMessage(msg.tabId, { type: 'START_ELEMENT_CAPTURE', options: { download: msg.download, clipboard: msg.clipboard } });
    });
    sendResponse({ ok: true });
    return true;
  }
});

async function captureVisible(tabId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  if (!tabId) return { dataUrl };

  // Get client dimensions (lightweight, no image data transferred)
  const dims = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const dpr = window.devicePixelRatio || 1;
      return { w: Math.round(document.documentElement.clientWidth * dpr), h: Math.round(document.documentElement.clientHeight * dpr) };
    }
  }).then(r => r[0].result).catch(() => null);

  if (!dims) return { dataUrl };

  // Get captured image dimensions to decide if cropping is needed
  const imgInfo = await getImageInfo(dataUrl);
  if (!imgInfo || (dims.w >= imgInfo.w && dims.h >= imgInfo.h)) return { dataUrl };

  // Crop scrollbar using OffscreenCanvas
  const cropped = await cropImage(dataUrl, dims.w, dims.h);
  return { dataUrl: cropped || dataUrl };
}

async function getImageInfo(dataUrl) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const info = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return info;
  } catch {
    return null;
  }
}

async function cropImage(dataUrl, w, h) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0, w, h, 0, 0, w, h);
    bitmap.close();
    const outBlob = await canvas.convertToBlob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(outBlob);
    });
  } catch {
    return null;
  }
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

async function handleOutput(dataUrl, options, tabId) {
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
