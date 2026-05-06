const btnVisible   = document.getElementById('btn-visible');
const btnFullpage  = document.getElementById('btn-fullpage');
const btnArea      = document.getElementById('btn-area');
const btnElement   = document.getElementById('btn-element');
const statusEl     = document.getElementById('status');
const radiusSlider = document.getElementById('corner-radius');
const radiusValue  = document.getElementById('radius-value');
const enableAnnotate = document.getElementById('enable-annotate');
const rememberArea = document.getElementById('remember-area');

function syncSlider() {
  const pct = (radiusSlider.value / radiusSlider.max) * 100;
  radiusSlider.style.setProperty('--pct', pct + '%');
  radiusValue.textContent = radiusSlider.value;
}
chrome.storage.sync.get({ radius: 0, enableAnnotate: false, rememberLastArea: false }, s => {
  radiusSlider.value = s.radius;
  enableAnnotate.checked = s.enableAnnotate;
  rememberArea.checked = s.rememberLastArea;
  syncSlider();
});
radiusSlider.addEventListener('input', () => {
  syncSlider();
  chrome.storage.sync.set({ radius: parseInt(radiusSlider.value, 10) });
});
enableAnnotate.addEventListener('change', () => {
  chrome.storage.sync.set({ enableAnnotate: enableAnnotate.checked });
});
rememberArea.addEventListener('change', () => {
  chrome.storage.sync.set({ rememberLastArea: rememberArea.checked });
});

function applyRoundedCorners(dataUrl, radius) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      const r = Math.min(radius, img.width / 2, img.height / 2);
      ctx.beginPath();
      ctx.moveTo(r, 0); ctx.lineTo(img.width - r, 0);
      ctx.quadraticCurveTo(img.width, 0, img.width, r);
      ctx.lineTo(img.width, img.height - r);
      ctx.quadraticCurveTo(img.width, img.height, img.width - r, img.height);
      ctx.lineTo(r, img.height);
      ctx.quadraticCurveTo(0, img.height, 0, img.height - r);
      ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
      ctx.closePath(); ctx.clip();
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

function setStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + type;
}

function setLoading(loading) {
  btnVisible.disabled  = loading;
  btnFullpage.disabled = loading;
  btnArea.disabled     = loading;
  btnElement.disabled  = loading;
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

  const radius = parseInt(radiusSlider.value, 10);
  const annotate = enableAnnotate.checked;

  if (type === 'CAPTURE_AREA') {
    const tabId = await getCurrentTabId();
    chrome.runtime.sendMessage({ type: 'CAPTURE_AREA', tabId, download: true, clipboard: false, radius, rememberLastArea: rememberArea.checked });
    window.close();
    return;
  }

  if (type === 'CAPTURE_ELEMENT') {
    const tabId = await getCurrentTabId();
    chrome.runtime.sendMessage({ type: 'CAPTURE_ELEMENT', tabId, download: true, clipboard: false, radius });
    window.close();
    return;
  }

  setLoading(true);
  setStatus(type === 'CAPTURE_FULL_PAGE' ? 'Capturing full page…' : 'Capturing…', 'loading');

  try {
    const tabId  = await getCurrentTabId();
    const result = await chrome.runtime.sendMessage({ type, tabId });

    if (!result) throw new Error('No response from background. Try reloading the page.');
    if (result?.error) throw new Error(result.error);

    let dataUrl = radius > 0 ? await applyRoundedCorners(result.dataUrl, radius) : result.dataUrl;

    if (annotate) {
      await chrome.runtime.sendMessage({ type: 'OPEN_ANNOTATION', dataUrl, tabId });
      setStatus('Annotation editor opened', 'success');
    } else {
      await chrome.runtime.sendMessage({ type: 'DOWNLOAD', dataUrl });
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setStatus('Downloaded · Copied to clipboard', 'success');
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  } finally {
    setLoading(false);
  }
}

btnVisible.addEventListener('click',  () => handleCapture('CAPTURE_VISIBLE'));
btnFullpage.addEventListener('click', () => handleCapture('CAPTURE_FULL_PAGE'));
btnArea.addEventListener('click',     () => handleCapture('CAPTURE_AREA'));
btnElement.addEventListener('click',  () => handleCapture('CAPTURE_ELEMENT'));
