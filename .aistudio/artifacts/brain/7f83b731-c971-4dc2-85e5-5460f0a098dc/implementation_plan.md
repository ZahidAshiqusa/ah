# Hybrid Railway Backend + AI Studio Frontend Deployment Plan (`RailwayAiStudio.md` & Zero-Logout Architecture)

## Overview
We will configure the **Urooj Choudhary WhatsApp Automation Suite** so you can publish the **Web UI in Google AI Studio** while running the **24/7 Stateful WhatsApp Engine on Railway**—ensuring **zero logouts**, **no container-idle restarts**, and **instant live statistics** from your Railway Volume (`/app/data`).

---

## 1. Documentation Deliverable (`/RailwayAiStudio.md`)
Create `/RailwayAiStudio.md` in the project root (and expose a live viewer + 1-click copy inside the Dashboard's **🚂 Railway Cloud Hub**) containing:
- **Architecture Overview**: How the Published AI Studio Frontend (`https://ais-pre-...run.app`) communicates with the 24/7 Railway Backend (`https://<your-app>.up.railway.app`) via both direct CORS API routing and server-side proxy fallback.
- **Complete `.env` Section**:
  - **1A. Railway Backend `.env` Variables**: `NODE_ENV`, `RAILWAY_VOLUME_MOUNT_PATH=/app/data`, `OWNER_NUMBER=923299931199`, `OWNER_NAME=King Unkown`, `SESSION_ID=AUTO`, `MODE=public`, `PREFIX=.`, `PERMANENT_AUTH_SECRET`, `CORS_ORIGIN=*`, `KEEP_ALIVE_INTERVAL_MS=45000`.
  - **1B. AI Studio Frontend `.env` Variables**: `RAILWAY_BACKEND_URL=https://your-project.up.railway.app`, `PERMANENT_AUTH_SECRET`, `AUTO_REAUTH_ENABLED=true`.
- **Necessary Files Checklist**:
  - Detailed table explaining every required file for Railway (`Dockerfile`, `railway.json`, `nixpacks.toml`, `Procfile`, `server.js`, `lib/storagePaths.js`, `lib/database.js`, `lib/sessionManager.js`, `lib/vaultInterceptor.js`) and AI Studio (`server.js`, `public/index.html`, `.env.example`, `metadata.json`).
- **Step-by-Step Setup & Publishing Instructions**:
  1. Deploying the backend to Railway + attaching the `/app/data` Persistent Volume.
  2. Copying your public Railway domain (`https://xxxx.up.railway.app`).
  3. Linking AI Studio to Railway (via `RAILWAY_BACKEND_URL` in AI Studio environment variables **or** pasting the URL directly in the Dashboard's **Railway Cloud Hub**).
  4. Publishing the web app in AI Studio and verifying 24/7 static uptime with zero logouts and zero socket restarts.

---

## 2. Backend & Bridge Enhancements (`/server.js`, `/lib/database.js`, `/.env.example`)
- **Cross-Origin Resource Sharing (CORS) & Preflight Support (`/server.js`)**:
  - Add universal CORS headers (`Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization, X-Railway-Bridge`) so the published AI Studio browser client can directly query and stream from the Railway backend URL without CORS blocks.
- **Dual-Mode Railway Bridge & Proxy (`/server.js`)**:
  - Add `GET /api/config/bridge` and `POST /api/config/bridge` endpoints that read/save `RAILWAY_BACKEND_URL` (supporting both `.env` `process.env.RAILWAY_BACKEND_URL` and persistent `config.json` storage) and expose `/api/railway/guide` to serve `RailwayAiStudio.md` directly inside the dashboard.
  - Add a keep-alive self-ping / heartbeat monitor in `server.js` so active WhatsApp sockets never sleep and automatically maintain connection health.
- **Permanent Login Token & Self-Healing Auto-Reauth (`/lib/database.js` & `/server.js`)**:
  - Upgrade session tokens in `lib/database.js` to **permanent expiration (`10 years`)** paired with a deterministic HMAC/signed token fallback (`u_perm_<base64_payload>_<sig>`).
  - Add `POST /api/auth/rehydrate` and enhance `validateSession()` so if an ephemeral container restarts or the user switches between local and Railway backends, the server automatically re-validates or re-creates the user's session without ever logging them out.

---

## 3. Frontend Bridge, Zero-Logout & Live Statics (`/public/index.html`)
- **Smart `window.fetch` Railway Bridge Interceptor**:
  - Automatically intercept `/api/*` and `/download/*` calls in `public/index.html`. When a `RAILWAY_BACKEND_URL` is configured (either fetched from `/api/config/bridge` env var or saved via the live Dashboard URL input), transparently route API requests and media download links to the Railway backend while keeping UI navigation static and instant on AI Studio.
- **Permanent Auto-Reauth Client Logic**:
  - Persist the user's login token, profile snapshot, and encrypted re-auth credentials in `localStorage` (`urooj_auth_token`, `urooj_user_snapshot`, `urooj_reauth_payload`).
  - Update `checkAuthSession()` so that:
    1. If a cached user snapshot exists, the dashboard renders immediately (`static` feel, zero login screen flash).
    2. If a container or network blip occurs, the client silently calls `/api/auth/rehydrate` or re-authenticates in the background instead of clearing `authToken` or kicking the user back to the login screen. Only an explicit click on the **Logout** button clears the session.
- **Railway ↔ AI Studio Bridge Control Panel in `#tab-railway`**:
  - Add an interactive **"🔗 AI Studio Frontend ↔ Railway Backend Bridge"** card at the top of the **🚂 Railway Cloud** tab where you can:
    - Paste/test your `https://xxxx.up.railway.app` backend URL live in the UI (or see the active `RAILWAY_BACKEND_URL` loaded from `.env`).
    - View real-time connection latency, remote socket count, and zero-logout token status.
    - View and copy the full `RailwayAiStudio.md` guide and both `.env` blocks (Railway Backend `.env` & AI Studio `.env`) with 1 click.
