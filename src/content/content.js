(function () {
  if (window.__quickshotLoaded) return;
  window.__quickshotLoaded = true;

  const MAX_HEIGHT = 15000;
  const DPR = window.devicePixelRatio || 1;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_FULL_CAPTURE') {
      captureFullPage()
        .then(dataUrl => sendResponse({ dataUrl }))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }
    if (msg.type === 'OPEN_ANNOTATION') {
      showAnnotationEditor(msg.dataUrl);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'START_AREA_CAPTURE') {
      const port = chrome.runtime.connect({ name: 'quickshot-area' });
      captureArea(port, msg.options)
        .then(dataUrl => {
          if (dataUrl === '__handled__') return;
          port.postMessage(dataUrl
            ? { type: 'AREA_RESULT', dataUrl, ...msg.options }
            : { type: 'AREA_CANCELLED' }
          );
          port.disconnect();
        })
        .catch(() => { port.postMessage({ type: 'AREA_CANCELLED' }); port.disconnect(); });
    }
  });

  // ─ Area selection with Lightshot-style toolbar ─────────────────────────────

  function captureArea(port, options) {
    return new Promise((resolve) => {
      if (document.getElementById('__quickshot-overlay')) { resolve(null); return; }

      const overlay = document.createElement('div');
      overlay.id = '__quickshot-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';

      const maskTop = makeMask();
      const maskBottom = makeMask();
      const maskLeft = makeMask();
      const maskRight = makeMask();
      [maskTop, maskBottom, maskLeft, maskRight].forEach(m => overlay.appendChild(m));

      // Selection box
      const sel = document.createElement('div');
      sel.id = '__quickshot-sel';
      sel.style.cssText = 'position:fixed;border:2px dashed #fff;box-sizing:border-box;display:none;';
      overlay.appendChild(sel);

      // Size label
      const sizeLabel = document.createElement('div');
      sizeLabel.id = '__quickshot-size';
      sizeLabel.style.cssText = 'position:absolute;background:rgba(0,0,0,0.7);color:#fff;font:12px/1.4 -apple-system,sans-serif;padding:2px 6px;border-radius:3px;pointer-events:none;display:none;top:-24px;left:0;white-space:nowrap;';
      sel.appendChild(sizeLabel);

      // Resize handles
      const handles = {};
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(dir => {
        const h = document.createElement('div');
        h.className = '__qs-handle';
        h.dataset.dir = dir;
        const isCorner = ['nw', 'ne', 'se', 'sw'].includes(dir);
        h.style.cssText = `position:absolute;width:${isCorner ? 10 : 6}px;height:${isCorner ? 10 : 6}px;background:#fff;border:1px solid #333;${getHandlePos(dir)};display:none;`;
        sel.appendChild(h);
        handles[dir] = h;
      });

      // Move handle (grip icon inside selection)
      const moveHandle = document.createElement('div');
      moveHandle.id = '__quickshot-move';
      moveHandle.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:28px;height:28px;display:none;cursor:grab;opacity:0.7;z-index:5;';
      moveHandle.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="9" cy="6" r="1.5" fill="#fff"/><circle cx="15" cy="6" r="1.5" fill="#fff"/><circle cx="9" cy="12" r="1.5" fill="#fff"/><circle cx="15" cy="12" r="1.5" fill="#fff"/><circle cx="9" cy="18" r="1.5" fill="#fff"/><circle cx="15" cy="18" r="1.5" fill="#fff"/></svg>';
      sel.appendChild(moveHandle);

      // Drawing canvas (inside selection)
      const drawCanvas = document.createElement('canvas');
      drawCanvas.id = '__quickshot-draw';
      drawCanvas.style.cssText = 'position:absolute;top:0;left:0;';
      sel.appendChild(drawCanvas);

      // Vertical toolbar (right side)
      const vToolbar = document.createElement('div');
      vToolbar.id = '__quickshot-vtoolbar';
      vToolbar.style.cssText = 'position:absolute;right:-36px;top:0;display:none;flex-direction:column;gap:1px;padding:3px;background:linear-gradient(to right,#fafbfb,#cbcec0);border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
      sel.appendChild(vToolbar);

      // Horizontal toolbar (bottom)
      const hToolbar = document.createElement('div');
      hToolbar.id = '__quickshot-htoolbar';
      hToolbar.style.cssText = 'position:absolute;bottom:-36px;left:0;display:none;flex-direction:row;gap:1px;padding:3px;background:linear-gradient(to bottom,#fafbfb,#cbcec0);border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:nowrap;';
      sel.appendChild(hToolbar);

      document.documentElement.appendChild(overlay);

      let startX = 0, startY = 0, endX = 0, endY = 0, dragging = false;
      let rect = { x: 0, y: 0, w: 0, h: 0 };
      let resizing = false, resizeDir = '', resizeStart = {}, resizeRect = {};
      let selectionComplete = false;

      // Drawing state
      let currentTool = 'pencil';
      let currentColor = '#ff0000';
      let brushSize = 4;
      let drawings = [];
      let currentDrawing = null;
      let isDrawing = false;
      let drawStart = { x: 0, y: 0 };

      function getHandlePos(dir) {
        const pos = {
          nw: 'top:-5px;left:-5px;cursor:nwse-resize;',
          n: 'top:-3px;left:50%;transform:translateX(-50%);cursor:ns-resize;',
          ne: 'top:-5px;right:-5px;cursor:nesw-resize;',
          e: 'top:50%;right:-3px;transform:translateY(-50%);cursor:ew-resize;',
          se: 'bottom:-5px;right:-5px;cursor:nwse-resize;',
          s: 'bottom:-3px;left:50%;transform:translateX(-50%);cursor:ns-resize;',
          sw: 'bottom:-5px;left:-5px;cursor:nesw-resize;',
          w: 'top:50%;left:-3px;transform:translateY(-50%);cursor:ew-resize;',
        };
        return pos[dir];
      }

      function setMask(el, l, t, w, h) {
        el.style.left = l + 'px'; el.style.top = t + 'px';
        el.style.width = w + 'px'; el.style.height = h + 'px';
      }

      function updateSelection() {
        const vw = window.innerWidth, vh = window.innerHeight;
        const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
        const w = Math.min(rect.w, vw - x), h = Math.min(rect.h, vh - y);
        rect = { x, y, w, h };

        setMask(maskTop, 0, 0, vw, y);
        setMask(maskBottom, 0, y + h, vw, vh - y - h);
        setMask(maskLeft, 0, y, x, h);
        setMask(maskRight, x + w, y, vw - x - w, h);

        sel.style.left = x + 'px'; sel.style.top = y + 'px';
        sel.style.width = w + 'px'; sel.style.height = h + 'px';
        sel.style.display = 'block';

        sizeLabel.textContent = `${Math.round(w)}×${Math.round(h)}`;
        sizeLabel.style.display = 'block';

        Object.values(handles).forEach(h => h.style.display = 'block');

        // Show move handle only when selection is finalized
        moveHandle.style.display = selectionComplete ? 'block' : 'none';

        // Position toolbars
        vToolbar.style.display = 'flex';
        hToolbar.style.display = 'flex';

        // Update draw canvas
        drawCanvas.width = w * DPR;
        drawCanvas.height = h * DPR;
        drawCanvas.style.width = w + 'px';
        drawCanvas.style.height = h + 'px';
        redrawDrawings();
      }

      function showToolbars() {
        buildVToolbar();
        buildHToolbar();
      }

      function buildVToolbar() {
        vToolbar.innerHTML = '';
        const tools = [
          { id: 'pencil', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>' },
          { id: 'line', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/></svg>' },
          { id: 'arrow', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/></svg>' },
          { id: 'rect', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>' },
          { id: 'circle', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>' },
          { id: 'marker', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>' },
          { id: 'text', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>' },
        ];

        tools.forEach(t => {
          const btn = document.createElement('button');
          btn.style.cssText = `width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid ${t.id === currentTool ? '#2196f3' : 'transparent'};border-radius:3px;cursor:pointer;`;
          btn.innerHTML = t.icon;
          btn.addEventListener('click', () => {
            currentTool = currentTool === t.id ? 'pencil' : t.id;
            buildVToolbar();
          });
          vToolbar.appendChild(btn);
        });

        const sep = document.createElement('div');
        sep.style.cssText = 'height:0;width:20px;border-bottom:1px solid #666;margin:2px 0;';
        vToolbar.appendChild(sep);

        const colorBtn = document.createElement('button');
        colorBtn.style.cssText = 'width:24px;height:24px;border:1px solid #999;border-radius:3px;cursor:pointer;';
        colorBtn.style.background = currentColor;
        colorBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showColorPicker(colorBtn);
        });
        vToolbar.appendChild(colorBtn);

        const sep2 = document.createElement('div');
        sep2.style.cssText = 'height:0;width:20px;border-bottom:1px solid #666;margin:2px 0;';
        vToolbar.appendChild(sep2);

        const undoBtn = document.createElement('button');
        undoBtn.style.cssText = 'width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:3px;cursor:pointer;';
        undoBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
        undoBtn.addEventListener('click', () => { drawings.pop(); redrawDrawings(); });
        vToolbar.appendChild(undoBtn);
      }

      function buildHToolbar() {
        hToolbar.innerHTML = '';
        const actions = [
          { id: 'copy', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>', label: 'Copy' },
          { id: 'save', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>', label: 'Save' },
          { id: 'close', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f44" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>', label: 'Close' },
        ];

        actions.forEach(a => {
          const btn = document.createElement('button');
          btn.style.cssText = 'height:26px;padding:0 8px;display:flex;align-items:center;gap:4px;background:transparent;border:1px solid transparent;border-radius:3px;cursor:pointer;font:11px -apple-system,sans-serif;color:#333;';
          btn.innerHTML = a.icon + '<span>' + a.label + '</span>';
          btn.addEventListener('click', () => handleAction(a.id));
          hToolbar.appendChild(btn);
        });
      }

      function showColorPicker(anchor) {
        const existing = document.getElementById('__qs-color-popup');
        if (existing) { existing.remove(); return; }

        const popup = document.createElement('div');
        popup.id = '__qs-color-popup';
        popup.style.cssText = 'position:absolute;background:rgba(0,0,0,0.9);border-radius:4px;padding:4px;display:flex;gap:3px;z-index:100;right:36px;top:0;';

        ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff', '#000000'].forEach(color => {
          const swatch = document.createElement('div');
          swatch.style.cssText = `width:20px;height:20px;border-radius:2px;cursor:pointer;border:2px solid ${color === currentColor ? '#fff' : 'transparent'};background:${color};`;
          swatch.addEventListener('click', () => {
            currentColor = color;
            popup.remove();
            buildVToolbar();
          });
          popup.appendChild(swatch);
        });

        vToolbar.appendChild(popup);
      }

      function handleAction(id) {
        if (id === 'close') { cleanup(); resolve(null); return; }

        const x = rect.x, y = rect.y, w = rect.w, h = rect.h;

        // Hide all overlay elements so captureVisibleTab doesn't include them
        sel.style.display = 'none';
        sizeLabel.style.display = 'none';
        Object.values(handles).forEach(h => h.style.display = 'none');
        vToolbar.style.display = 'none';
        hToolbar.style.display = 'none';
        moveHandle.style.display = 'none';

        // Wait for browser repaint then capture
        requestAnimationFrame(() => {
          setTimeout(() => {
            port.postMessage({ type: 'AREA_CAPTURE_STRIP' });
            const handler = m => {
              if (m.type === 'STRIP_RESULT') {
                port.onMessage.removeListener(handler);
                processCapture(m.dataUrl, x, y, w, h, id);
              }
            };
            port.onMessage.addListener(handler);
          }, 50);
        });
      }

      async function processCapture(stripDataUrl, x, y, w, h, action) {
        const img = await loadImage(stripDataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * DPR);
        canvas.height = Math.round(h * DPR);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, Math.round(x * DPR), Math.round(y * DPR), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);

        // Draw annotations
        drawings.forEach(d => drawOnCanvas(ctx, d, DPR));

        // Apply rounded corners if configured
        roundCorners(canvas, (options.radius || 0) * DPR);

        const dataUrl = canvas.toDataURL('image/png');

        // Save to storage for next time
        chrome.storage.local.set({ lastAreaSelection: { x, y, w, h } });

        if (action === 'save') {
          chrome.runtime.sendMessage({ type: 'DOWNLOAD', dataUrl });
        } else if (action === 'copy') {
          const blob = await (await fetch(dataUrl)).blob();
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }

        cleanup();
        resolve('__handled__');
      }

      // ── Drawing on canvas ──────────────────────────────────────────────────

      function roundCorners(canvas, radius) {
        if (!radius || radius <= 0) return canvas;
        const w = canvas.width, h = canvas.height;
        const r = Math.min(radius, w / 2, h / 2);
        const ctx = canvas.getContext('2d');

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = w;
        tempCanvas.height = h;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(canvas, 0, 0);

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

        ctx.imageSmoothingEnabled = true;
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.globalCompositeOperation = 'source-in';
        ctx.drawImage(tempCanvas, 0, 0);
        ctx.globalCompositeOperation = 'source-over';

        return canvas;
      }

      function getDrawPoint(e) {
        const r = drawCanvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * DPR, y: (e.clientY - r.top) * DPR };
      }

      drawCanvas.addEventListener('mousedown', e => {
        if (resizing || dragging) return;
        e.stopPropagation();
        e.preventDefault();
        const pt = getDrawPoint(e);
        isDrawing = true;
        drawStart = pt;
        currentDrawing = { tool: currentTool, color: currentColor, width: brushSize * DPR, points: [pt], start: pt, end: pt };
      });

      drawCanvas.addEventListener('mousemove', e => {
        if (isDrawing && currentDrawing) {
          const pt = getDrawPoint(e);
          if (currentDrawing.tool === 'pencil' || currentDrawing.tool === 'marker') {
            currentDrawing.points.push(pt);
          } else {
            currentDrawing.end = pt;
          }
          redrawDrawings();
        }
      });

      drawCanvas.addEventListener('mouseup', e => {
        if (isDrawing && currentDrawing) {
          if (currentDrawing.points.length > 1 || currentDrawing.start.x !== currentDrawing.end.x) {
            drawings.push(currentDrawing);
          }
          currentDrawing = null;
          isDrawing = false;
          redrawDrawings();
        }
      });

      drawCanvas.addEventListener('mouseleave', () => {
        if (isDrawing && currentDrawing) {
          if (currentDrawing.points.length > 1 || currentDrawing.start.x !== currentDrawing.end.x) {
            drawings.push(currentDrawing);
          }
          currentDrawing = null;
          isDrawing = false;
          redrawDrawings();
        }
      });

      function redrawDrawings() {
        const ctx = drawCanvas.getContext('2d');
        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        drawings.forEach(d => drawOnCanvas(ctx, d, 1));
        if (currentDrawing) drawOnCanvas(ctx, currentDrawing, 1);
      }

      function drawOnCanvas(ctx, d, scale) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const w = d.width * scale;

        if (d.tool === 'pencil' || d.tool === 'marker') {
          ctx.strokeStyle = d.color;
          ctx.lineWidth = w;
          if (d.tool === 'marker') ctx.globalAlpha = 0.5;
          if (d.points.length === 1) {
            ctx.fillStyle = d.color;
            ctx.beginPath();
            ctx.arc(d.points[0].x, d.points[0].y, w / 2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.moveTo(d.points[0].x, d.points[0].y);
            for (let i = 1; i < d.points.length; i++) ctx.lineTo(d.points[i].x, d.points[i].y);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        } else if (d.tool === 'line') {
          ctx.strokeStyle = d.color;
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(d.start.x, d.start.y);
          ctx.lineTo(d.end.x, d.end.y);
          ctx.stroke();
        } else if (d.tool === 'arrow') {
          ctx.strokeStyle = d.color;
          ctx.lineWidth = w;
          const headLen = 15 * scale;
          const angle = Math.atan2(d.end.y - d.start.y, d.end.x - d.start.x);
          ctx.beginPath();
          ctx.moveTo(d.start.x, d.start.y);
          ctx.lineTo(d.end.x, d.end.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(d.end.x, d.end.y);
          ctx.lineTo(d.end.x - headLen * Math.cos(angle - Math.PI / 6), d.end.y - headLen * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(d.end.x, d.end.y);
          ctx.lineTo(d.end.x - headLen * Math.cos(angle + Math.PI / 6), d.end.y - headLen * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        } else if (d.tool === 'rect') {
          ctx.strokeStyle = d.color;
          ctx.lineWidth = w;
          const rx = Math.min(d.start.x, d.end.x), ry = Math.min(d.start.y, d.end.y);
          const rw = Math.abs(d.end.x - d.start.x), rh = Math.abs(d.end.y - d.start.y);
          ctx.strokeRect(rx, ry, rw, rh);
        } else if (d.tool === 'circle') {
          ctx.strokeStyle = d.color;
          ctx.lineWidth = w;
          const cx = (d.start.x + d.end.x) / 2;
          const cy = (d.start.y + d.end.y) / 2;
          const rx = Math.abs(d.end.x - d.start.x) / 2;
          const ry = Math.abs(d.end.y - d.start.y) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // ── Resize handles ─────────────────────────────────────────────────────

      Object.values(handles).forEach(h => {
        h.addEventListener('mousedown', e => {
          e.stopPropagation();
          e.preventDefault();
          resizing = true;
          resizeDir = h.dataset.dir;
          resizeStart = { x: e.clientX, y: e.clientY };
          resizeRect = { ...rect };
          overlay.style.cursor = getComputedStyle(h).cursor;
        });
      });

      function handleResize(e) {
        const dx = e.clientX - resizeStart.x;
        const dy = e.clientY - resizeStart.y;
        const r = { ...resizeRect };

        if (resizeDir.includes('n')) { r.y += dy; r.h -= dy; }
        if (resizeDir.includes('s')) { r.h += dy; }
        if (resizeDir.includes('w')) { r.x += dx; r.w -= dx; }
        if (resizeDir.includes('e')) { r.w += dx; }

        if (r.w < 20) { if (resizeDir.includes('w')) r.x = resizeRect.x + resizeRect.w - 20; r.w = 20; }
        if (r.h < 20) { if (resizeDir.includes('n')) r.y = resizeRect.y + resizeRect.h - 20; r.h = 20; }

        rect = r;
        updateSelection();
      }

      // ── Selection move (via grip handle) ───────────────────────────────────

      moveHandle.addEventListener('mousedown', e => {
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        moveHandle.style.cursor = 'grabbing';
        resizeStart = { x: e.clientX - rect.x, y: e.clientY - rect.y };
      });

      moveHandle.addEventListener('mouseup', () => {
        moveHandle.style.cursor = 'grab';
      });

      // ── Unified overlay events ─────────────────────────────────────────────

      overlay.addEventListener('mousedown', e => {
        if (e.target.closest('#__quickshot-sel')) return;
        if (selectionComplete) return;
        startX = endX = e.clientX;
        startY = endY = e.clientY;
        dragging = false;
        resizing = false;
      });

      overlay.addEventListener('mousemove', e => {
        if (resizing) {
          handleResize(e);
          return;
        }
        if (dragging) {
          rect.x = e.clientX - resizeStart.x;
          rect.y = e.clientY - resizeStart.y;
          updateSelection();
          return;
        }
        if (selectionComplete) return;
        if (startX || startY) {
          endX = e.clientX;
          endY = e.clientY;
          rect = {
            x: Math.min(startX, endX),
            y: Math.min(startY, endY),
            w: Math.abs(endX - startX),
            h: Math.abs(endY - startY)
          };
          if (rect.w > 5 && rect.h > 5) {
            updateSelection();
            showToolbars();
          }
        }
      });

      overlay.addEventListener('mouseup', e => {
        if (resizing) {
          resizing = false;
          overlay.style.cursor = 'crosshair';
          return;
        }
        if (dragging) {
          dragging = false;
          return;
        }
        if (selectionComplete) return;
        if (rect.w > 5 && rect.h > 5) {
          selectionComplete = true;
          moveHandle.style.display = 'block';
        } else {
          rect = { x: 0, y: 0, w: 0, h: 0 };
          sel.style.display = 'none';
          sizeLabel.style.display = 'none';
          Object.values(handles).forEach(h => h.style.display = 'none');
          vToolbar.style.display = 'none';
          hToolbar.style.display = 'none';
          moveHandle.style.display = 'none';
        }
        startX = startY = endX = endY = 0;
      });

      // ── Load last saved selection (only if enabled) ────────────────────────

      chrome.storage.sync.get({ rememberLastArea: false }, ({ rememberLastArea }) => {
        if (!rememberLastArea) return;
        chrome.storage.local.get('lastAreaSelection', ({ lastAreaSelection }) => {
          if (lastAreaSelection) {
            const vw = window.innerWidth, vh = window.innerHeight;
            rect = {
              x: Math.min(lastAreaSelection.x, vw - 50),
              y: Math.min(lastAreaSelection.y, vh - 50),
              w: Math.min(lastAreaSelection.w, vw),
              h: Math.min(lastAreaSelection.h, vh)
            };
            if (rect.w > 10 && rect.h > 10) {
              selectionComplete = true;
              updateSelection();
              showToolbars();
            }
          }
        });
      });

      // Keyboard
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { cleanup(); resolve(null); }
      });

      function cleanup() {
        overlay.remove();
      }
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
    const totalWidth = document.documentElement.scrollWidth;
    const totalHeight = Math.min(document.documentElement.scrollHeight, MAX_HEIGHT);
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
      const remaining = totalHeight - capturedHeight;
      const stripHeight = Math.min(viewportHeight, remaining);
      strips.push({ dataUrl: result.dataUrl, y: capturedHeight, height: stripHeight });
      capturedHeight += viewportHeight;
      if (capturedHeight < totalHeight) window.scrollTo(0, capturedHeight);
    }

    window.scrollTo(originalX, originalY);

    const canvas = document.createElement('canvas');
    canvas.width = totalWidth * dpr;
    canvas.height = totalHeight * dpr;
    const ctx = canvas.getContext('2d');

    for (const strip of strips) {
      const img = await loadImage(strip.dataUrl);
      const srcY = strips.indexOf(strip) === 0 ? 0 : (img.height - strip.height * dpr);
      ctx.drawImage(img, 0, srcY, img.width, strip.height * dpr, 0, strip.y * dpr, canvas.width, strip.height * dpr);
    }

    return canvas.toDataURL('image/png');
  }

  // ── Annotation editor for visible/full page captures ──────────────────────

  function showAnnotationEditor(dataUrl) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#1a1a2e;display:flex;flex-direction:column;';

    // Bottom action bar
    const hBar = document.createElement('div');
    hBar.style.cssText = 'display:flex;align-items:center;gap:4px;padding:6px 12px;background:linear-gradient(to bottom,#fafbfb,#cbcec0);box-shadow:0 -2px 6px rgba(0,0,0,0.2);';

    const actions = [
      { id: 'save', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>', label: 'Save' },
      { id: 'copy', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>', label: 'Copy' },
      { id: 'close', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f44" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>', label: 'Close' },
    ];

    actions.forEach(a => {
      const btn = document.createElement('button');
      btn.style.cssText = 'height:28px;padding:0 10px;display:flex;align-items:center;gap:4px;background:transparent;border:1px solid transparent;border-radius:3px;cursor:pointer;font:12px -apple-system,sans-serif;color:#333;';
      btn.innerHTML = a.icon + '<span>' + a.label + '</span>';
      btn.addEventListener('click', () => {
        if (a.id === 'close') { overlay.remove(); return; }
        if (a.id === 'save') editorSave();
        if (a.id === 'copy') editorCopy();
      });
      hBar.appendChild(btn);
    });

    overlay.appendChild(hBar);

    // Canvas area
    const canvasArea = document.createElement('div');
    canvasArea.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:20px;position:relative;';

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'box-shadow:0 4px 24px rgba(0,0,0,0.5);cursor:crosshair;';
    canvasArea.appendChild(canvas);
    overlay.appendChild(canvasArea);
    document.body.appendChild(overlay);

    // Right-side toolbar (inside overlay, absolute position)
    const vBar = document.createElement('div');
    vBar.style.cssText = 'position:absolute;right:20px;top:20px;display:flex;flex-direction:column;gap:2px;padding:4px;background:linear-gradient(to right,#fafbfb,#cbcec0);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.3);z-index:10;';

    const eTools = [
      { id: 'pencil', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>' },
      { id: 'line', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/></svg>' },
      { id: 'arrow', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/></svg>' },
      { id: 'rect', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>' },
      { id: 'circle', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>' },
      { id: 'marker', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>' },
      { id: 'text', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>' },
    ];

    let editorTool = 'pencil';
    let editorColor = '#ff0000';
    let editorWidth = 4;
    let editorDrawings = [];
    let editorCurrent = null;
    let editorCtx = null;
    let imgW = 0, imgH = 0;
    let dispScale = 1;
    let eDrawing = false;
    let eTextInput = null;

    eTools.forEach(t => {
      const btn = document.createElement('button');
      btn.style.cssText = `width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid ${t.id === editorTool ? '#2196f3' : 'transparent'};border-radius:3px;cursor:pointer;`;
      btn.innerHTML = t.icon;
      btn.addEventListener('click', () => {
        if (eTextInput) finishEditorText();
        editorTool = editorTool === t.id ? 'pencil' : t.id;
        eTools.forEach((_, i) => {
          vBar.children[i].style.borderColor = eTools[i].id === editorTool ? '#2196f3' : 'transparent';
        });
      });
      vBar.appendChild(btn);
    });

    const sep = document.createElement('div');
    sep.style.cssText = 'height:0;width:20px;border-bottom:1px solid #666;margin:2px 0;';
    vBar.appendChild(sep);

    const colorBtn = document.createElement('div');
    colorBtn.style.cssText = `width:24px;height:24px;border:1px solid #999;border-radius:3px;cursor:pointer;background:${editorColor};`;
    colorBtn.addEventListener('click', e => {
      e.stopPropagation();
      const popup = document.createElement('div');
      popup.style.cssText = 'position:fixed;background:rgba(0,0,0,0.9);border-radius:4px;padding:4px;display:flex;gap:3px;z-index:100;';
      const rect = colorBtn.getBoundingClientRect();
      popup.style.left = (rect.left - 130) + 'px';
      popup.style.top = rect.top + 'px';
      ['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ffffff','#000000'].forEach(c => {
        const sw = document.createElement('div');
        sw.style.cssText = `width:20px;height:20px;border-radius:2px;cursor:pointer;border:2px solid ${c === editorColor ? '#fff' : 'transparent'};background:${c};`;
        sw.addEventListener('click', () => {
          editorColor = c;
          colorBtn.style.background = c;
          popup.remove();
        });
        popup.appendChild(sw);
      });
      document.body.appendChild(popup);
      setTimeout(() => document.addEventListener('click', function cp(e) { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', cp); } }), 0);
    });
    vBar.appendChild(colorBtn);

    const sep2 = document.createElement('div');
    sep2.style.cssText = 'height:0;width:20px;border-bottom:1px solid #666;margin:2px 0;';
    vBar.appendChild(sep2);

    const undoBtn = document.createElement('button');
    undoBtn.style.cssText = 'width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;border-radius:3px;cursor:pointer;';
    undoBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
    undoBtn.addEventListener('click', () => { editorDrawings.pop(); editorRedraw(); });
    vBar.appendChild(undoBtn);

    overlay.appendChild(vBar);

    // Load image
    const img = new Image();
    img.onload = () => {
      imgW = img.width;
      imgH = img.height;
      canvas.width = imgW;
      canvas.height = imgH;
      const maxW = window.innerWidth - 100;
      const maxH = window.innerHeight - 100;
      dispScale = Math.min(1, maxW / imgW, maxH / imgH);
      canvas.style.width = (imgW * dispScale) + 'px';
      canvas.style.height = (imgH * dispScale) + 'px';
      editorCtx = canvas.getContext('2d');
      editorCtx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;

    function getEPoint(e) {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / dispScale, y: (e.clientY - r.top) / dispScale };
    }

    canvas.addEventListener('mousedown', e => {
      if (editorTool === 'text') {
        const pt = getEPoint(e);
        eTextInput = document.createElement('textarea');
        eTextInput.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;font-size:${editorWidth * 3}px;color:${editorColor};background:transparent;border:1px dashed #333;outline:none;padding:2px;min-width:80px;min-height:24px;resize:none;z-index:100;font-family:sans-serif;`;
        eTextInput.placeholder = 'Type...';
        document.body.appendChild(eTextInput);
        eTextInput.focus();
        eTextInput._pt = pt;
        return;
      }
      const pt = getEPoint(e);
      eDrawing = true;
      editorCurrent = { tool: editorTool, color: editorColor, width: editorWidth, points: [pt], start: pt, end: pt };
    });

    canvas.addEventListener('mousemove', e => {
      if (!eDrawing || !editorCurrent) return;
      const pt = getEPoint(e);
      if (editorCurrent.tool === 'pencil' || editorCurrent.tool === 'marker') {
        editorCurrent.points.push(pt);
      } else {
        editorCurrent.end = pt;
      }
      editorRedraw();
    });

    canvas.addEventListener('mouseup', () => {
      if (eDrawing && editorCurrent) {
        if (editorCurrent.points.length > 1 || editorCurrent.start.x !== editorCurrent.end.x || editorCurrent.tool === 'text') {
          editorDrawings.push(editorCurrent);
        }
        editorCurrent = null;
        eDrawing = false;
        editorRedraw();
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (eDrawing && editorCurrent) {
        if (editorCurrent.points.length > 1 || editorCurrent.start.x !== editorCurrent.end.x) {
          editorDrawings.push(editorCurrent);
        }
        editorCurrent = null;
        eDrawing = false;
        editorRedraw();
      }
    });

    document.addEventListener('keydown', function editorKey(e) {
      if (eTextInput) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEditorText(); }
        if (e.key === 'Escape') { finishEditorText(); }
        return;
      }
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); editorDrawings.pop(); editorRedraw(); }
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', editorKey); }
    });

    function finishEditorText() {
      if (!eTextInput) return;
      const val = eTextInput.value.trim();
      if (val) {
        editorDrawings.push({ tool: 'text', color: editorColor, width: editorWidth, start: eTextInput._pt, text: val });
      }
      eTextInput.remove();
      eTextInput = null;
      editorRedraw();
    }

    function editorRedraw() {
      if (!editorCtx) return;
      const i = new Image();
      i.onload = () => {
        editorCtx.clearRect(0, 0, canvas.width, canvas.height);
        editorCtx.drawImage(i, 0, 0);
        editorDrawings.forEach(d => editorDrawObj(d));
        if (editorCurrent) editorDrawObj(editorCurrent);
      };
      i.src = dataUrl;
    }

    function editorDrawObj(d) {
      const ctx = editorCtx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const w = d.width;

      if (d.tool === 'pencil' || d.tool === 'marker') {
        ctx.strokeStyle = d.color;
        ctx.lineWidth = w;
        if (d.tool === 'marker') ctx.globalAlpha = 0.5;
        if (d.points.length === 1) {
          ctx.fillStyle = d.color;
          ctx.beginPath();
          ctx.arc(d.points[0].x, d.points[0].y, w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(d.points[0].x, d.points[0].y);
          for (let i = 1; i < d.points.length; i++) ctx.lineTo(d.points[i].x, d.points[i].y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (d.tool === 'line') {
        ctx.strokeStyle = d.color;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(d.start.x, d.start.y);
        ctx.lineTo(d.end.x, d.end.y);
        ctx.stroke();
      } else if (d.tool === 'arrow') {
        ctx.strokeStyle = d.color;
        ctx.lineWidth = w;
        const hl = 15, ang = Math.atan2(d.end.y - d.start.y, d.end.x - d.start.x);
        ctx.beginPath();
        ctx.moveTo(d.start.x, d.start.y);
        ctx.lineTo(d.end.x, d.end.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(d.end.x, d.end.y);
        ctx.lineTo(d.end.x - hl * Math.cos(ang - Math.PI/6), d.end.y - hl * Math.sin(ang - Math.PI/6));
        ctx.moveTo(d.end.x, d.end.y);
        ctx.lineTo(d.end.x - hl * Math.cos(ang + Math.PI/6), d.end.y - hl * Math.sin(ang + Math.PI/6));
        ctx.stroke();
      } else if (d.tool === 'rect') {
        ctx.strokeStyle = d.color;
        ctx.lineWidth = w;
        const rx = Math.min(d.start.x, d.end.x), ry = Math.min(d.start.y, d.end.y);
        const rw = Math.abs(d.end.x - d.start.x), rh = Math.abs(d.end.y - d.start.y);
        ctx.strokeRect(rx, ry, rw, rh);
      } else if (d.tool === 'circle') {
        ctx.strokeStyle = d.color;
        ctx.lineWidth = w;
        const cx = (d.start.x + d.end.x) / 2, cy = (d.start.y + d.end.y) / 2;
        const rx = Math.abs(d.end.x - d.start.x) / 2, ry = Math.abs(d.end.y - d.start.y) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (d.tool === 'text' && d.text) {
        ctx.font = `${d.width * 3}px sans-serif`;
        ctx.fillStyle = d.color;
        ctx.textBaseline = 'top';
        const lines = d.text.split('\n');
        lines.forEach((line, i) => ctx.fillText(line, d.start.x, d.start.y + i * d.width * 3));
      }
    }

    function editorSave() {
      const fc = document.createElement('canvas');
      fc.width = imgW;
      fc.height = imgH;
      const fctx = fc.getContext('2d');
      fctx.drawImage(canvas, 0, 0);
      chrome.runtime.sendMessage({ type: 'DOWNLOAD', dataUrl: fc.toDataURL('image/png') });
      overlay.remove();
    }

    function editorCopy() {
      canvas.toBlob(blob => {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      });
      overlay.remove();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function settle(ms) { return new Promise(r => setTimeout(r, ms)); }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

})();
