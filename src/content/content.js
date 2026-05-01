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
    if (msg.type === 'START_FRAME_CAPTURE') {
      placeFrame(msg.w, msg.h, msg.options);
    }
  });

  // ── Frame Capture ───────────────────────────────────────────────────────────

  function placeFrame(fw, fh, options) {
    document.getElementById('__qs-frame')?.remove();

    const dpr     = window.devicePixelRatio || 1;
    const vw      = window.innerWidth;
    const vh      = window.innerHeight;
    const TOOLBAR = 30;

    let fx = Math.max(0, Math.round((vw - fw) / 2));
    let fy = Math.max(0, Math.round((vh - fh) / 2));

    const frame = document.createElement('div');
    frame.id = '__qs-frame';
    frame.style.cssText = `
      position:fixed; left:${fx}px; top:${fy}px;
      width:${fw}px; height:${fh}px;
      z-index:2147483647; box-sizing:border-box;
      border:2px solid #0e7490; background:rgba(14,116,144,0.06);
      cursor:move; font-family:-apple-system,sans-serif;
    `;

    const toolbar = document.createElement('div');
    toolbar.style.cssText = `
      position:absolute; top:0; left:0; right:0; height:${TOOLBAR}px;
      background:#0e7490; display:flex; align-items:center;
      justify-content:space-between; padding:0 8px;
      cursor:move; user-select:none; border-bottom:1px solid #0891b2;
    `;

    const dimLabel = document.createElement('span');
    dimLabel.style.cssText = 'color:#fff;font-size:11px;font-weight:600;letter-spacing:0.3px;';
    dimLabel.textContent = `${fw} × ${fh}`;

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:6px;align-items:center;';

    const btnCapture = document.createElement('button');
    btnCapture.textContent = '📷 Capture';
    btnCapture.style.cssText = `
      padding:3px 10px; background:#fff; color:#0e7490;
      border:none; border-radius:4px; font-size:11px; font-weight:700;
      cursor:pointer; line-height:1.4;
    `;

    const btnClose = document.createElement('button');
    btnClose.textContent = '✕';
    btnClose.style.cssText = `
      padding:2px 6px; background:transparent; color:rgba(255,255,255,0.8);
      border:1px solid rgba(255,255,255,0.4); border-radius:4px;
      font-size:11px; cursor:pointer; line-height:1.4;
    `;

    btnGroup.appendChild(btnCapture);
    btnGroup.appendChild(btnClose);
    toolbar.appendChild(dimLabel);
    toolbar.appendChild(btnGroup);
    frame.appendChild(toolbar);

    if (fw > vw || fh > vh) {
      const warn = document.createElement('div');
      warn.style.cssText = `
        position:absolute; bottom:6px; left:0; right:0;
        text-align:center; font-size:11px; color:#fbbf24; pointer-events:none;
      `;
      warn.textContent = '⚠ Frame exceeds viewport';
      frame.appendChild(warn);
    }

    const sizeTag = document.createElement('div');
    sizeTag.style.cssText = `
      position:absolute; bottom:4px; right:6px;
      font-size:10px; color:rgba(14,116,144,0.8);
      pointer-events:none; font-weight:600;
    `;
    sizeTag.textContent = `${fw}×${fh}px`;
    frame.appendChild(sizeTag);

    document.documentElement.appendChild(frame);

    // Drag
    let dragging = false, dragOffX = 0, dragOffY = 0;

    toolbar.addEventListener('mousedown', e => {
      if (e.target === btnCapture || e.target === btnClose) return;
      e.preventDefault();
      dragging = true;
      dragOffX = e.clientX - fx;
      dragOffY = e.clientY - fy;
      frame.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      fx = Math.max(0, Math.min(vw - fw, e.clientX - dragOffX));
      fy = Math.max(0, Math.min(vh - fh, e.clientY - dragOffY));
      frame.style.left = fx + 'px';
      frame.style.top  = fy + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      frame.style.cursor = 'move';
    });

    btnClose.addEventListener('click', () => frame.remove());

    btnCapture.addEventListener('click', async () => {
      const rect = frame.getBoundingClientRect();
      const x = rect.left, y = rect.top + TOOLBAR;
      const w = rect.width, h = rect.height - TOOLBAR;

      frame.style.visibility = 'hidden';
      await settle(80);

      const port = chrome.runtime.connect({ name: 'quickshot-frame' });

      const stripDataUrl = await new Promise((res, rej) => {
        const handler = m => {
          if (m.type === 'STRIP_RESULT') { port.onMessage.removeListener(handler); res(m.dataUrl); }
          if (m.type === 'STRIP_ERROR')  { port.onMessage.removeListener(handler); rej(new Error(m.error)); }
        };
        port.onMessage.addListener(handler);
        port.postMessage({ type: 'FRAME_CAPTURE_STRIP' });
      });

      frame.style.visibility = 'visible';

      const img = await loadImage(stripDataUrl);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img,
        Math.round(x * dpr), Math.round(y * dpr), canvas.width, canvas.height,
        0, 0, canvas.width, canvas.height
      );
      roundCorners(canvas, (options.radius || 0) * dpr);

      const dataUrl = canvas.toDataURL('image/png');
      port.postMessage({ type: 'FRAME_RESULT', dataUrl, ...options });
      port.disconnect();
      frame.remove();
    });
  }

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

      // "Press Enter to reuse" button shown when a saved selection exists
      const reuseBtn = document.createElement('div');
      reuseBtn.style.cssText = 'position:fixed;bottom:50px;left:50%;transform:translateX(-50%);background:#7c6af7;color:#fff;font:bold 11px/1.6 -apple-system,sans-serif;padding:4px 14px;border-radius:6px;pointer-events:auto;cursor:pointer;display:none;white-space:nowrap;';
      overlay.appendChild(reuseBtn);

      const hint = document.createElement('div');
      hint.textContent = 'Drag to select — ESC to cancel';
      hint.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:#fff;font:12px/1.6 -apple-system,sans-serif;padding:4px 12px;border-radius:6px;pointer-events:none;';
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

        reuseBtn.textContent = `↵ Capture (${Math.round(w)}×${Math.round(h)}) — drag box to reposition`;
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
