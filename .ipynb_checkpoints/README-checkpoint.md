# Sync Metronome (LAN, build-free, phone-first)

Minimal multi-user metronome that syncs over the same Wi‑Fi using WebRTC with PeerJS cloud signaling. No build tools or bundling required; static HTML/JS/CSS served directly from GitHub Pages or any static host. Phone-only use is supported; a laptop is optional.

## Requirements
- Same Wi‑Fi for all participants.
- Modern mobile browsers (iOS/Android) and laptops (optional).
- No static IP, no backend server needed; signaling uses PeerJS cloud.
- Remote Docker container is only for development; users are not on that network.

## Run from static files
- Files live at repo root (`index.html`, `style.css`, `client.js`). Deploy to any static host—GitHub Pages recommended.
- In the page: enter a room and Connect. First to connect claims the room hub; tap “Become leader” on any device to lead. Tap Start after the lead-in.

## Deploy to GitHub Pages (repo: kimguibo/met)
1. Ensure `index.html`, `style.css`, `client.js` are in the repo root (already done).
2. Push to `main`.
3. GitHub → Settings → Pages → Source: “Deploy from a branch”; Branch: `main`; Path: `/ (root)` → Save.
4. Visit `https://kimguibo.github.io/met/` on phones (same Wi‑Fi or Internet).

## Development (this container)
- You can still run `npm install` and `npm start` to serve the static files locally for testing; port-forward `3000` if needed.

## Files
- `index.html`, `style.css`, `client.js` – build-free client UI/logic; loads PeerJS from CDN.
- `server.js` – optional static file server for local dev only (not needed on GitHub Pages).
