# Railway Backend + Google AI Studio Frontend Guide (`RailwayAiStudio.md`)

**Project:** Urooj Choudhary — WhatsApp Automation Suite  
**Owner:** King Unkown (`+923299931199`)  
**Master Admin:** `Urooj` (Passcode: `Zaid@323232`)

---

## 1. Architecture Overview (Why This Prevents Logouts & Restarts)

When you publish an app in **Google AI Studio**, the web container runs on serverless Cloud Run—which can scale to zero when no browser tab is open. By splitting the deployment into:

1. **Railway (24/7 Stateful Backend + Persistent Volume `/app/data`)**:
   - Runs `node server.js` continuously 24/7 without sleeping.
   - Keeps all **Baileys WhatsApp sockets**, **SQLite WAL database (`urooj_suite.db`)**, **Session folders (`/app/data/sessions`)**, and **Unlocked View-Once / Anti-Delete Vault files (`/app/data/vault`)** alive on a persistent disk volume.
2. **Google AI Studio (Published Static-Feel Web Frontend)**:
   - Serves the fast web dashboard (`public/index.html`) on your AI Studio Shared App URL (`https://ais-pre-...run.app`).
   - Connects directly to your Railway Backend URL via `RAILWAY_BACKEND_URL` (configured in `.env` **or** pasted live in the Dashboard's **🚂 Railway Cloud** tab).
   - Uses **Permanent HMAC Login Tokens (`urooj_perm_...`) + Auto-Rehydration** so you are **never logged out** when refreshing, reopening the app days later, or switching devices.

```
┌──────────────────────────────────────────────┐        CORS / HTTPS Bridge        ┌─────────────────────────────────────────────────┐
│  Google AI Studio (Published Web Frontend)   │ ────────────────────────────────► │  Railway Cloud (24/7 Persistent Backend)        │
│  • Instant Static Dashboard UI               │ ◄──────────────────────────────── │  • Always-On Baileys WhatsApp Sockets           │
│  • Permanent Login Token (Zero Logout)       │    Live Statics, Vault & Sockets  │  • Persistent Volume mounted at /app/data       │
│  • Auto-Routes /api/* to RAILWAY_BACKEND_URL │                                   │  • SQLite DB + Sessions + View-Once Media Vault │
└──────────────────────────────────────────────┘                                   └─────────────────────────────────────────────────┘
```

---

## 2. Environment Variables (`.env`) Section

### 2A. Railway Backend `.env` Variables
Copy and paste these into **Railway Dashboard → Your Service → Variables → Raw Editor**:

```env
# ── CORE RUNTIME & PERSISTENT VOLUME ─────────────────────────
NODE_ENV=production
PORT=3000
RAILWAY_VOLUME_MOUNT_PATH=/app/data
SQLITE_PATH=/app/data/urooj_suite.db
DB_TYPE=sqlite

# ── BOT IDENTITY & OWNER CONFIG ──────────────────────────────
BOT_NAME=Urooj Choudhary
BOT_OWNER=King Unkown
OWNER_NUMBER=923299931199
PREFIX=.
COMMAND_MODE=public
TIMEZONE=Asia/Karachi

# ── ZERO-LOGOUT PERMANENT AUTH & CORS BRIDGE ─────────────────
PERMANENT_AUTH_SECRET=urooj-master-permanent-secret-923299931199
AUTO_REAUTH_ENABLED=true
CORS_ORIGIN=*
KEEP_ALIVE_INTERVAL_MS=45000

# ── AUTOMATION & INTERCEPTOR DEFAULTS ────────────────────────
AUTO_STATUS_REACT=true
AUTO_STATUS_REPLY=false
AUTOREAD=false
AUTOTYPE=false
AUTORECORD=false
ALWAYSONLINE=true
BUTTONMODE=on

# ── OPTIONAL FALLBACK SESSION ID ─────────────────────────────
SESSION_ID=
```

---

### 2B. Google AI Studio Frontend `.env` Variables
Set these in **AI Studio** (or inside `.env` / the live Dashboard Bridge input) so your published AI Studio web app routes all live data, WhatsApp pairing, and Vault media to your Railway backend:

```env
# ── AI STUDIO FRONTEND -> RAILWAY BACKEND BRIDGE ─────────────
PORT=3000
NODE_ENV=production
RAILWAY_BACKEND_URL=https://your-project-production.up.railway.app
PERMANENT_AUTH_SECRET=urooj-master-permanent-secret-923299931199
AUTO_REAUTH_ENABLED=true
CORS_ORIGIN=*
OWNER_NUMBER=923299931199
```

> **Note:** Replace `https://your-project-production.up.railway.app` with the actual public domain generated in Railway (`Settings → Networking → Generate Domain`). You can also paste or change this URL at any time inside the dashboard under **🚂 Railway Cloud → AI Studio ↔ Railway Backend Bridge**.

---

## 3. Necessary Files Checklist

Make sure the following files are present in your project (all of them are automatically included when you click **⬇ Download Railway Project (.ZIP)** in the dashboard):

### Required Files for Railway (24/7 Backend)
| File Path | Purpose |
| :--- | :--- |
| `server.js` | Express server, CORS bridge headers, permanent auth verification, anti-sleep heartbeat, Vault API, and `/api/health` endpoint. |
| `Dockerfile` | Production `node:22-bookworm-slim` container image with `ffmpeg` and native `node:sqlite` support. |
| `railway.json` | Configures Railway healthcheck (`/api/health`), `ON_FAILURE` restart policy, and `node server.js` start command. |
| `nixpacks.toml` | Nixpacks fallback manifest specifying Node.js 22 and `ffmpeg`. |
| `Procfile` | Process declaration (`web: node server.js`). |
| `package.json` | Dependencies (`@whiskeysockets/baileys`, `express`, `adm-zip`, `pino`, etc.) and `"start": "node server.js"`. |
| `lib/storagePaths.js` | Unified persistent storage resolver that maps sessions, SQLite DB, and Vault media into `/app/data`. |
| `lib/database.js` | SQLite WAL database engine + permanent HMAC session tokens (`10-year` expiry + stateless auto-rehydration). |
| `lib/sessionManager.js` | Multi-device WhatsApp Baileys socket manager with automatic session rehydration on boot. |
| `lib/vaultInterceptor.js` | Real-time View-Once media decryptor and Deleted Message ("Delete for Everyone") recovery engine. |
| `lib/pluginLoader.js` & `plugins/*` | Loads all 156 plugins / 236 WhatsApp bot commands. |

### Required Files for Google AI Studio (Published Web Frontend)
| File Path | Purpose |
| :--- | :--- |
| `public/index.html` | Single-page application dashboard with smart `window.fetch` Railway Bridge interceptor, permanent login storage, and live telemetry. |
| `server.js` | Serves `public/index.html` on Port `3000` in AI Studio and provides `/api/config/bridge` + `/api/auth/rehydrate`. |
| `.env.example` | Documents `RAILWAY_BACKEND_URL`, `PERMANENT_AUTH_SECRET`, and all runtime variables. |
| `RailwayAiStudio.md` | This deployment and configuration reference guide (served via `/api/railway/status` and viewable in the UI). |
| `metadata.json` | AI Studio application metadata and permissions manifest. |

---

## 4. Step-by-Step Instructions: Deploy Backend on Railway & Publish Frontend in AI Studio

### Step 1: Deploy Backend on Railway
1. Open the dashboard and go to the **🚂 Railway Cloud** tab.
2. Click **⬇ Download Railway Project (.ZIP)** (or push this repository to GitHub).
3. Go to [Railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** (or run `railway up` using the Railway CLI).
4. **Attach a Persistent Volume** (Critical for zero session loss):
   - In the Railway project canvas, right-click (or press `⌘K` / `Ctrl+K`) → **Add Volume**.
   - Attach the Volume to your service and set the **Mount Path** to:
     ```text
     /app/data
     ```
5. Open **Variables → Raw Editor** in Railway and paste the **2A. Railway Backend `.env` Variables** block above.
6. Go to **Settings → Networking → Public Networking** and click **Generate Domain**. Copy your new HTTPS URL (e.g. `https://urooj-suite-production.up.railway.app`).

### Step 2: Connect AI Studio Frontend to Your Railway Backend
You have **two ways** to link your AI Studio Frontend to Railway (both work together):

- **Method A (Live in the Web Dashboard — Instant, No Rebuild Needed):**
  1. Open your AI Studio app and go to **🚂 Railway Cloud**.
  2. In the **🔗 AI Studio Frontend ↔ Railway Backend Bridge** card at the top, paste your Railway URL (`https://your-project.up.railway.app`) and click **Save & Connect Bridge**.
  3. The browser immediately routes all `/api/*` and media requests directly to your 24/7 Railway backend and saves the URL to both `localStorage` and the server bridge config.

- **Method B (Environment Variable in AI Studio):**
  1. Set `RAILWAY_BACKEND_URL=https://your-project.up.railway.app` and `PERMANENT_AUTH_SECRET=urooj-master-permanent-secret-923299931199` in your AI Studio environment settings.
  2. Every visitor who opens your published AI Studio link will automatically connect to your Railway backend without needing to type the URL.

### Step 3: Publish in AI Studio with Zero Logout & No Restarting
1. Sign in once as Super Admin (`Urooj` / `Zaid@323232`) or your user account.
2. Pair your WhatsApp number in the **📱 Device Pairing** tab. Your session credentials are written directly to Railway's `/app/data/sessions` volume.
3. Click **Publish / Share** in Google AI Studio.
4. Whenever you open your published AI Studio URL:
   - **No Log Out:** Your permanent HMAC token (`urooj_perm_...`) and cached user snapshot restore your session immediately without showing a login screen.
   - **No Restarting:** Because your WhatsApp sockets and SQLite database run 24/7 on Railway, closing your browser or letting the AI Studio frontend idle never disconnects or restarts your WhatsApp bot.
   - **Live Statics:** All command counts, uptime, active sockets, and unlocked View-Once / Deleted messages stream live from your Railway backend.
