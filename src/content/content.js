(function () {
if (window.__quickshotLoaded) return;
window.__quickshotLoaded = true;

  const MAX_HEIGHT = 15000;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_FULL_CAPTURE') {
      captureFullPage()
        .then(dataUrl => sendResponse({ dataUrl }))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }
    if (msg.type === 'START_AREA_CAPTURE') {
      const port = chrome.runtime.connect({ name: 'quickshot-area' });
      captureArea(port, msg.options)
        .then(dataUrl => {
          port.postMessage(dataUrl
            ? { type: 'AREA_RESULT', dataUrl, ...msg.options }
            : { type: 'AREA_CANCELLED' }
          );
          port.disconnect();
        })
        .catch(() => { port.postMessage({ type: 'AREA_CANCELLED' }); port.disconnect(); });
    }
  });

  // ── Area selection ──────────────────────────────────────────────────────────

  function captureArea(port, options) {
    return new Promise((resolve) => {
      if (document.getElementById('__quickshot-overlay')) { resolve(null); return; }

      const dpr = window.devicePixelRatio || 1;

      const overlay = document.createElement('div');
      overlay.id = '__quickshot-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';

      const maskTop    = makeMask();
      const maskBottom = makeMask();
      const maskLeft   = makeMask();
      const maskRight  = makeMask();
      [maskTop, maskBottom, maskLeft, maskRight].forEach(m => overlay.appendChild(m));

      const sel = document.createElement('div');
      sel.style.cssText = 'position:fixed;border:2px solid #7c6af7;box-sizing:border-box;display:none;pointer-events:none;';
      // Move handle — visible inside the selection when in savedRect mode
      const moveHandle = document.createElement('div');
      moveHandle.style.cssText = 'position:absolute;inset:0;cursor:move;display:none;';
      sel.appendChild(moveHandle);
      overlay.appendChild(sel);

      const tip = document.createElement('div');
      tip.style.cssText = 'position:fixed;background:#7c6af7;color:#fff;font:bold 11px/1.6 -apple-system,sans-serif;padding:1px 7px;border-radius:4px;pointer-events:none;display:none;';
      overlay.appendChild(tip);

      // Capture button shown inside the selection box when a saved selection exists
      const reuseBtn = document.createElement('div');
      reuseBtn.style.cssText = 'position:absolute;bottom:-30px;left:50%;transform:translateX(-50%);background:#7c6af7;color:#fff;font:bold 11px/1.6 -apple-system,sans-serif;padding:4px 14px;border-radius:0 0 6px 6px;pointer-events:auto;cursor:pointer;display:none;white-space:nowrap;z-index:1;';
      sel.appendChild(reuseBtn);

      const hint = document.createElement('div');
      hint.style.cssText = 'display:none;';
      overlay.appendChild(hint);

      document.documentElement.appendChild(overlay);

      let startX = 0, startY = 0, endX = 0, endY = 0, dragging = false;
      let savedRect = null;

      function getRect() {
        return { x: Math.min(startX, endX), y: Math.min(startY, endY), w: Math.abs(endX - startX), h: Math.abs(endY - startY) };
      }

      function setMask(el, l, t, w, h) {
        el.style.left = l + 'px'; el.style.top = t + 'px';
        el.style.width = w + 'px'; el.style.height = h + 'px';
      }

      function updateUI(rect) {
        const { x, y, w, h } = rect || getRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        setMask(maskTop,    0,     0,    vw,       y);
        setMask(maskBottom, 0,     y+h,  vw,       vh-y-h);
        setMask(maskLeft,   0,     y,    x,        h);
        setMask(maskRight,  x+w,   y,    vw-x-w,   h);
        sel.style.left = x+'px'; sel.style.top = y+'px';
        sel.style.width = w+'px'; sel.style.height = h+'px';
        sel.style.display = 'block';
        tip.textContent = `${Math.round(w)} × ${Math.round(h)}`;
        tip.style.left = (x+4)+'px';
        tip.style.top  = (y > 24 ? y-22 : y+h+4)+'px';
        tip.style.display = 'block';
      }

      function showSavedSelection(r) {
        // Clamp saved rect to current viewport
        const vw = window.innerWidth, vh = window.innerHeight;
        const x = Math.min(r.x, vw - 10);
        const y = Math.min(r.y, vh - 10);
        const w = Math.min(r.w, vw - x);
        const h = Math.min(r.h, vh - y);
        savedRect = { x, y, w, h };

        sel.style.border = '2px dashed #7c6af7';
        sel.style.background = 'rgba(124,106,247,0.08)';
        sel.style.pointerEvents = 'auto';
        moveHandle.style.display = 'block';
        updateUI(savedRect);

        reuseBtn.textContent = `↵ Capture (${Math.round(w)}×${Math.round(h)})`;
        reuseBtn.style.display = 'block';
        hint.textContent = 'Drag box to move — drag outside to draw new — ESC to cancel';
      }

      function clearSavedMode() {
        savedRect = null;
        sel.style.border = '2px solid #7c6af7';
        sel.style.background = '';
        sel.style.pointerEvents = 'none';
        moveHandle.style.display = 'none';
        reuseBtn.style.display = 'none';
        hint.textContent = 'Drag to select — ESC to cancel';
      }

      // Init masks to full-screen dark cover before first drag
      const vw0 = window.innerWidth, vh0 = window.innerHeight;
      setMask(maskTop,    0, 0,   vw0, vh0);
      setMask(maskBottom, 0, vh0, vw0, 0);
      setMask(maskLeft,   0, 0,   0,   0);
      setMask(maskRight,  0, 0,   0,   0);

      // Load last saved selection and pre-show it
      chrome.storage.local.get('lastAreaSelection', ({ lastAreaSelection }) => {
        if (lastAreaSelection) showSavedSelection(lastAreaSelection);
      });

      // ── Move logic for saved selection ──
      let moving = false, moveOffX = 0, moveOffY = 0;

      moveHandle.addEventListener('mousedown', e => {
        if (!savedRect) return;
        e.preventDefault();
        e.stopPropagation();
        moving = true;
        moveOffX = e.clientX - savedRect.x;
        moveOffY = e.clientY - savedRect.y;
        overlay.style.cursor = 'grabbing';
      });

      overlay.addEventListener('mousemove', e => {
        if (moving && savedRect) {
          const vw = window.innerWidth, vh = window.innerHeight;
          savedRect = {
            x: Math.max(0, Math.min(vw - savedRect.w, e.clientX - moveOffX)),
            y: Math.max(0, Math.min(vh - savedRect.h, e.clientY - moveOffY)),
            w: savedRect.w, h: savedRect.h,
          };
          updateUI(savedRect);
          return;
        }
        if (!dragging) return;
        endX = e.clientX; endY = e.clientY; updateUI();
      });

      overlay.addEventListener('mousedown', e => {
        if (moving) return;
        e.preventDefault();
        startX = endX = e.clientX; startY = endY = e.clientY;
        dragging = true;
        hint.style.display = 'none';
        clearSavedMode();
      });

      async function captureRect(x, y, w, h) {
        cleanup();
        chrome.storage.local.set({ lastAreaSelection: { x, y, w, h } });

        const stripDataUrl = await new Promise((res, rej) => {
          const handler = m => {
            if (m.type === 'STRIP_RESULT') { port.onMessage.removeListener(handler); res(m.dataUrl); }
            if (m.type === 'STRIP_ERROR')  { port.onMessage.removeListener(handler); rej(new Error(m.error)); }
          };
          port.onMessage.addListener(handler);
          port.postMessage({ type: 'AREA_CAPTURE_STRIP' });
        });

        const img = await loadImage(stripDataUrl);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, Math.round(x*dpr), Math.round(y*dpr), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        roundCorners(canvas, (options.radius || 0) * dpr);
        resolve(canvas.toDataURL('image/png'));
      }

      overlay.addEventListener('mouseup', async e => {
        if (moving) {
          moving = false;
          overlay.style.cursor = 'crosshair';
          return;
        }
        if (!dragging) return;
        dragging = false; endX = e.clientX; endY = e.clientY;
        const { x, y, w, h } = getRect();
        if (w < 4 || h < 4) { resolve(null); cleanup(); return; }
        await captureRect(x, y, w, h);
      });

      reuseBtn.addEventListener('click', async () => {
        if (!savedRect) return;
        await captureRect(savedRect.x, savedRect.y, savedRect.w, savedRect.h);
      });

      function cleanup() { overlay.remove(); document.removeEventListener('keydown', onKey); }
      function onKey(e) {
        if (e.key === 'Escape') { cleanup(); resolve(null); }
        if (e.key === 'Enter' && savedRect && !dragging && !moving) {
          captureRect(savedRect.x, savedRect.y, savedRect.w, savedRect.h);
        }
      }
      document.addEventListener('keydown', onKey);
    });
  }

  function makeMask() {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;background:rgba(0,0,0,0.5);pointer-events:none;';
    return d;
  }

  // ── Full-page capture ───────────────────────────────────────────────────────

  async function captureFullPage() {
    const originalX = window.scrollX, originalY = window.scrollY;
    const totalWidth     = document.documentElement.scrollWidth;
    const totalHeight    = Math.min(document.documentElement.scrollHeight, MAX_HEIGHT);
    const viewportHeight = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    const strips = [];
    let capturedHeight = 0;
    window.scrollTo(0, 0);

    while (capturedHeight < totalHeight) {
      await settle(250);
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_STRIP' }, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(res);
        });
      });
      if (result.error) throw new Error(result.error);
      const remaining   = totalHeight - capturedHeight;
      const stripHeight = Math.min(viewportHeight, remaining);
      strips.push({ dataUrl: result.dataUrl, y: capturedHeight, height: stripHeight });
      capturedHeight += viewportHeight;
      if (capturedHeight < totalHeight) window.scrollTo(0, capturedHeight);
    }

    window.scrollTo(originalX, originalY);

    const canvas = document.createElement('canvas');
    canvas.width  = totalWidth * dpr;
    canvas.height = totalHeight * dpr;
    const ctx = canvas.getContext('2d');

    for (const strip of strips) {
      const img  = await loadImage(strip.dataUrl);
      const srcY = strips.indexOf(strip) === 0 ? 0 : (img.height - strip.height * dpr);
      ctx.drawImage(img, 0, srcY, img.width, strip.height * dpr, 0, strip.y * dpr, canvas.width, strip.height * dpr);
    }

    return canvas.toDataURL('image/png');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function roundCorners(canvas, radius) {
    if (!radius || radius <= 0) return canvas;
    const { width: w, height: h } = canvas;
    const r = Math.min(radius, w / 2, h / 2);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.clip();
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function settle(ms) { return new Promise(r => setTimeout(r, ms)); }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

})(); // end IIFE
