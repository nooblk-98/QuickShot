const btnVisible  = document.getElementById('btn-visible');
const btnFullpage = document.getElementById('btn-fullpage');
const btnArea     = document.getElementById('btn-area');
const btnFrame    = document.getElementById('btn-frame');
const dimPreset   = document.getElementById('dim-preset');
const customDims  = document.getElementById('custom-dims');
const customW     = document.getElementById('custom-w');
const customH     = document.getElementById('custom-h');
const optDownload = document.getElementById('opt-download');
const optClipboard= document.getElementById('opt-clipboard');
const statusEl    = document.getElementById('status');

function setStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + type;
}

function setLoading(loading) {
  btnVisible.disabled  = loading;
  btnFullpage.disabled = loading;
  btnArea.disabled     = loading;
  btnFrame.disabled    = loading;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getCurrentTabId() {
  const tab = await getCurrentTab();
  return tab.id;
}

function isRestrictedUrl(url = '') {
  return url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
         url.startsWith('edge://') || url.startsWith('about:');
}

// Show/hide custom dimension inputs
dimPreset.addEventListener('change', () => {
  customDims.classList.toggle('hidden', dimPreset.value !== 'custom');
});

// Place Frame button
btnFrame.addEventListener('click', async () => {
  const download  = optDownload.checked;
  const clipboard = optClipboard.checked;

  if (!download && !clipboard) {
    setStatus('Select at least one output option.', 'error');
    return;
  }

  const tab = await getCurrentTab();
  if (isRestrictedUrl(tab.url)) {
    setStatus('Cannot capture chrome:// pages.', 'error');
    return;
  }

  let w, h;
  if (dimPreset.value === 'custom') {
    w = parseInt(customW.value, 10);
    h = parseInt(customH.value, 10);
    if (!w || !h || w < 10 || h < 10) {
      setStatus('Enter valid width and height.', 'error');
      return;
    }
  } else {
    [w, h] = dimPreset.value.split('x').map(Number);
  }

  const tabId = await getCurrentTabId();
  chrome.runtime.sendMessage({ type: 'PLACE_FRAME', tabId, w, h, download, clipboard });
  window.close();
});

async function handleCapture(type) {
  const download  = optDownload.checked;
  const clipboard = optClipboard.checked;

  if (!download && !clipboard) {
    setStatus('Select at least one output option.', 'error');
    return;
  }

  const tab = await getCurrentTab();
  if (isRestrictedUrl(tab.url)) {
    setStatus('Cannot capture chrome:// pages.', 'error');
    return;
  }

  // Fire-and-forget — popup closes, background handles everything
  if (type === 'CAPTURE_AREA') {
    const tabId = await getCurrentTabId();
    chrome.runtime.sendMessage({ type: 'CAPTURE_AREA', tabId, download, clipboard });
    window.close();
    return;
  }

  setLoading(true);
  setStatus(type === 'CAPTURE_FULL_PAGE' ? 'Capturing full page…' : 'Capturing…', 'loading');

  try {
    const tabId  = await getCurrentTabId();
    const result = await chrome.runtime.sendMessage({ type, tabId });

    if (result?.error) throw new Error(result.error);

    const dataUrl = result.dataUrl;
    const actions = [];

    if (download) {
      await chrome.runtime.sendMessage({ type: 'DOWNLOAD', dataUrl });
      actions.push('Downloaded');
    }
    if (clipboard) {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      actions.push('Copied to clipboard');
    }

    setStatus(actions.join(' · '), 'success');
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  } finally {
    setLoading(false);
  }
}

btnVisible.addEventListener('click',  () => handleCapture('CAPTURE_VISIBLE'));
btnFullpage.addEventListener('click', () => handleCapture('CAPTURE_FULL_PAGE'));
btnArea.addEventListener('click',     () => handleCapture('CAPTURE_AREA'));
