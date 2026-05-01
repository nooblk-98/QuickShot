# QuickShot Release Notes

---

## v1.0.4 — 2026-05-01

### Improvements
- **Higher screenshot quality** — Canvas crops now use pixel-perfect rendering (`imageSmoothingEnabled = false`) for sharper area and visible captures.
- **Organised download folder** — Screenshots are saved to `Downloads/quickshot/` instead of the root Downloads folder.

---

## v1.0.3

### Bug Fixes
- Fixed capture button position — now sticks below the selection box and remains clickable.
- Stopped event propagation on the capture button so the overlay no longer intercepts clicks.
- Removed hint bar from the area selection overlay for a cleaner UI.
- Attached capture button to the selection box instead of floating over page content.

---

## v1.0.2

### Improvements
- Added Ko-fi support link to the popup footer.
- Fixed duplicate context menu ID error on service worker restart.

### Other
- Added app screenshot to README.
- Clarified release notes with Chrome Web Store vs manual install sections.

---

## v1.0.1

Initial public release.
