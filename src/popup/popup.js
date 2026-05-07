const btnVisible   = document.getElementById('btn-visible');
const btnFullpage  = document.getElementById('btn-fullpage');
const btnArea      = document.getElementById('btn-area');
const btnElement   = document.getElementById('btn-element');
const statusEl     = document.getElementById('status');
const enableAnnotate = document.getElementById('enable-annotate');
const rememberArea = document.getElementById('remember-area');

chrome.storage.sync.get({ enableAnnotate: false, rememberLastArea: false }, s => {
  enableAnnotate.checked = s.enableAnnotate;
  rememberArea.checked = s.rememberLastArea;
});
enableAnnotate.addEventListener('change', () => {
  chrome.storage.sync.set({ enableAnnotate: enableAnnotate.checked });
});
rememberArea.addEventListener('change', () => {
  chrome.storage.sync.set({ rememberLastArea: rememberArea.checked });
});

function setStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + type;
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

async function handleCapture(type) {
  const tab = await getCurrentTab();
  if (isRestrictedUrl(tab.url)) {
    setStatus('Cannot capture chrome:// pages.', 'error');
    return;
  }

  const annotate = enableAnnotate.checked;
  const tabId = await getCurrentTabId();
  const common = { type, tabId, annotate, download: true, clipboard: !annotate };

  if (type === 'CAPTURE_AREA') {
    chrome.runtime.sendMessage({ ...common, clipboard: false, rememberLastArea: rememberArea.checked });
  } else if (type === 'CAPTURE_ELEMENT') {
    chrome.runtime.sendMessage({ ...common, clipboard: false });
  } else {
    chrome.runtime.sendMessage(common);
  }
  window.close();
}

btnVisible.addEventListener('click',  () => handleCapture('CAPTURE_VISIBLE'));
btnFullpage.addEventListener('click', () => handleCapture('CAPTURE_FULL_PAGE'));
btnArea.addEventListener('click',     () => handleCapture('CAPTURE_AREA'));
btnElement.addEventListener('click',  () => handleCapture('CAPTURE_ELEMENT'));
