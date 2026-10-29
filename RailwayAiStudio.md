# Railway Backend + Google AI Studio Frontend Guide (`RailwayAiStudio.md`)

**Project:** Urooj Choudhary — WhatsApp Automation Suite  
**Owner:** Urooj Choudhary (`+254141693915`)  
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
BOT_OWNER=Urooj Choudhary
OWNER_NUMBER=254141693915
PREFIX=.
COMMAND_MODE=public
TIMEZONE=Asia/Karachi

# ── ZERO-LOGOUT PERMANENT AUTH & CORS BRIDGE ─────────────────
PERMANENT_AUTH_SECRET=urooj-master-permanent-secret-254141693915
AUTO_REAUTH_ENABLED=true
CORS_ORIGIN=*
KEEP_ALIVE_INTERVAL_MS=45000

# ── AUTOMATION & INTERCEPTOR DEFAULTS ────────────────────────
AUTO_STATUS_REACT=true
AUTO_STATUS_REPLY=false
AUTO_STATUS_MSG=Status Viewed by Urooj Choudhary
AUTOREAD=false
AUTOTYPE=false
AUTORECORD=false
ALWAYSONLINE=true
BUTTONMODE=on
PACK_AUTHOR=Urooj Choudhary
PACK_NAME=Urooj Choudhary

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
PERMANENT_AUTH_SECRET=urooj-master-permanent-secret-254141693915
AUTO_REAUTH_ENABLED=true
CORS_ORIGIN=*
BOT_NAME=Urooj Choudhary
BOT_OWNER=Urooj Choudhary
OWNER_NUMBER=254141693915
```

> **Note:** Replace `https://your-project-production.up.railway.app` with the actual public domain generated in Railway (`Settings → Networking → Generate Domain`). You can also paste or change this URL at any time inside the dashboard under **🚂 Railway Cloud → AI Studio ↔ Railway Backend Bridge**.

---

## 3. Custom Urooj Choudhary Bot Commands

| Command | Syntax | Description |
| :--- | :--- | :--- |
| **`.button`** | `.button/msg/buttonlimit/button1/button2 +923number` *(or `.button/+923number/msg/buttonlimit/button1/button2`)* | Sends an interactive button message with up to `buttonlimit` buttons and `👑 Urooj Choudhary` footer to the target number. |
| **`.ptv`** | Reply to video with `.ptv +923number` | Sends the replied video as a circular WhatsApp Video Note (`ptv: true`) to `+923number`. |
| **`.voice`** | Reply to audio/video with `.voice +923number` | Sends the replied audio/video as a playable WhatsApp Voice Note (`ptt: true`) to `+923number`. |
| **`.😍`** | Reply to View-Once with `.😍` | Unlocks any View-Once photo, video, or audio and sends the file directly to Owner DM (`+254141693915`). |
| **`.qouted`** | `.qouted msg1/replied +923number` *(or `.qouted/+923number/msg1/replied`)* | Sends `replied` as a fake-quoted reply to `msg1` on the target number. |
| **`.online`** | `.online +9232number` | Subscribes to real-time WhatsApp presence for `+9232number` and displays their live status & timestamped online history. |

---

## 4. Necessary Files Checklist

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
| `plugins/urooj_custom_commands.js` | Implements `.button`, `.ptv`, `.voice`, `.😍`, `.qouted`, and `.online` commands. |

---

## 5. Step-by-Step Instructions (Including Mobile Browser Volume Setup)

### Step 1: Deploy & Add a Persistent Volume on Railway (Mobile Browser Guide)
1. In Railway on your mobile browser, look at the **left-most vertical icon bar** (where you see the Architecture/Canvas icon at the top and the Gear `⚙️` icon at the bottom).
2. Tap the **top icon above the bar chart** (the **Architecture / Canvas** icon) to exit Project Settings and return to your project canvas.
3. On the project canvas:
   - Tap the **`+ Create` / `+ New`** button in the top-right corner, **OR** tap and hold on empty canvas space.
   - Select **Volume**.
   - Choose your deployed service to attach the Volume to.
   - Enter the **Mount Path** as:
     ```text
     /app/data
     ```
4. Next, tap on your **Service card** → **Variables** → **Raw Editor**, and paste the **2A. Railway Backend `.env` Variables** block above.
5. Tap **Settings** (inside your Service card, not Project Settings) → **Networking** → **Generate Domain** and copy your `https://...up.railway.app` URL.

### Step 2: Connect AI Studio Frontend to Your Railway Backend
- Open your AI Studio app → **🚂 Railway Cloud** tab → paste your Railway URL into **🔗 AI Studio Frontend ↔ Railway Backend Bridge** → click **Save & Connect Bridge**.
- Or set `RAILWAY_BACKEND_URL=https://your-project.up.railway.app` in `.env`.
