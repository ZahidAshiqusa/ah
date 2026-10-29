# View-Once Downloader & Deleted Message Fetcher

A real-time WhatsApp media and message recovery suite that intercepts View-Once photos, videos, and voice notes alongside "Deleted for Everyone" messages across all private chats and groups, storing them in a searchable Web Dashboard Vault with one-click file downloads while automatically forwarding recovered content to your personal WhatsApp DM.

## User Review & Critical Decisions

> [!IMPORTANT]
> The architecture below incorporates your confirmed preferences from the clarification phase:
> - **Confirmed Delivery & Access Mode**: Dual delivery — all intercepted View-Once media and revoked messages are persisted in the **Web Dashboard Vault** (with inline preview and one-click download) AND **auto-forwarded to your WhatsApp DM**.
> - **Confirmed Capture Scope**: Full coverage across **both Private Chats and Group Chats** for all media types (photos, videos, voice notes/audio, documents) and text messages.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **View-Once Downloader**: Automatically detects incoming View-Once messages (`viewOnceMessage`, `viewOnceMessageV2`, `viewOnceMessageV2Extension`, and media with `viewOnce: true`), decrypts the media stream via Baileys before it expires, strips the single-view lock, saves the media file locally, and forwards an unlocked copy to your WhatsApp DM.
  2. **Deleted Message Fetcher (Anti-Delete)**: Caches incoming text and media messages across private and group conversations. The moment a sender triggers "Delete for Everyone" (`protocolMessage` REVOKE), the engine matches the revoked message ID, preserves the original text and decrypted media in the permanent recovery log, and sends a recovery alert to your WhatsApp DM.
- **Target Audience / Persona**: WhatsApp power users and device owners managing their linked WhatsApp session who need permanent archival and instant recovery of ephemeral or revoked communications.
- **Key Value**: Zero-loss visibility into ephemeral View-Once media and deleted messages without requiring manual intervention at the moment a message arrives, paired with a permanent browser-accessible media vault.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Launching the Service**: User opens the **All Services** drawer in the top navigation bar and selects **View-Once Downloader** or **Deleted Msg Fetcher** (accessible as a unified **Recovery & Vault Suite** with dedicated sub-views and direct service shortcuts).
  2. **Configuring Interceptor & DM Auto-Forwarding**: At the top of the workspace, a control bar lets the user toggle **Auto-Unlock View-Once**, **Auto-Capture Deleted Messages**, and **Auto-Forward to WhatsApp DM**, plus specify the target forwarding number (defaulting to the connected owner number).
  3. **Browsing & Downloading from the Web Vault**:
     - Users filter captured items by **View-Once Media** vs. **Deleted Messages**, **Chat Type** (All, Private Chats, Group Chats), **Content Type** (Photos, Videos, Voice/Audio, Text), or search by sender phone number, contact name, or message text.
     - Media items render with an inline preview player (image lightbox, HTML5 video player, or audio waveform/player) alongside unboxed metadata (`Sender · Chat Source · Timestamp · File Size`).
     - Each item provides a **Download File** button, a **Forward to WhatsApp** button, and a **Delete Record** button.
  4. **On-Demand / Manual Lookup & Test Capture**: Users can scan recent cached chat messages by phone number to manually unlock a View-Once item or trigger a test capture to verify vault and DM forwarding pipelines immediately.

- **Visual Identity & Theme**:
  - **Aesthetic Direction**: High-contrast dark SaaS telemetry & media vault workspace matching the existing slate-and-amber interface, adhering to single-elevation card depth and unboxed metadata discipline.
  - **Color Palette & Mood**:
    - `--background`: Deep Slate (`#020617` / `bg-slate-950`)
    - `--surface`: Elevated Slate (`#0f172a` / `bg-slate-900`) with hairline borders (`border-slate-800`)
    - `--primary`: Amber Gold (`#f59e0b`) for View-Once actions and primary CTAs
    - `--accent`: Cyan/Rose accents (`#06b6d4` / `#f43f5e`) for Deleted Message recovery indicators and semantic states
  - **Typography & Hierarchy**: Clean sans headings paired with `font-mono tabular-nums` for phone numbers, message IDs, file sizes, and capture timestamps.
  - **Interactive Feedback & Motion**: Instant segmented filter transitions ($\le 150\text{ms}$), inline skeleton states during vault refresh, and non-blocking toast/status feedback on media downloads and WhatsApp re-dispatches.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Eager Media Decryption for View-Once & Anti-Delete Cache**
  - *Chosen Approach*: Immediately download and decrypt View-Once media upon `messages.upsert` and maintain a rolling media/text cache for recent incoming messages so revoked media can still be recovered after deletion.
  - *Why*: WhatsApp CDN media keys and links can become inaccessible once a message is revoked or opened. Eager decryption guarantees 100% file availability in the Web Vault.
  - *Alternatives Considered*: Lazy decryption only when the user clicks download in the web UI (rejected because revoked messages or expired media URLs fail to decrypt later).

- **Decision 2: Persistent SQLite Index + Local Vault Storage**
  - *Chosen Approach*: Store structured metadata in SQLite (`recovered_messages` and `interceptor_settings` tables) and binary media files in a dedicated `/data/vault/` directory served via authenticated/streamed Express routes.
  - *Why*: Keeps the SQLite database fast and lightweight while allowing direct browser streaming and `Content-Disposition: attachment` downloads for large video and audio files.

---

## 4. Technical Architecture & Data Strategy

### Architecture & Component Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        BAILEYS SOCKET EVENT STREAM                         │
│         sock.ev.on('messages.upsert')  &  sock.ev.on('messages.update')    │
└───────────────────┬────────────────────────────────────┬───────────────────┘
                    │                                    │
                    ▼                                    ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────────┐
│     VIEW-ONCE INTERCEPTOR ENGINE     │  │   DELETED MSG FETCHER ENGINE     │
│ • Detects viewOnceMessage / V2 / Ext │  │ • Rolling cache of incoming msgs │
│ • Decrypts image/video/audio stream  │  │ • Detects protocolMessage REVOKE │
│ • Strips viewOnce flag               │  │ • Matches original msg by key.id │
└───────────────────┬──────────────────┘  └──────────────┬───────────────────┘
                    │                                    │
                    └─────────────────┬──────────────────┘
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                   PERSISTENCE & AUTO-FORWARD DISPATCHER                    │
│  1. Save media buffer to /data/vault/<id>.<ext>                            │
│  2. Insert record into SQLite (recovered_items & interceptor_config)       │
│  3. Auto-Forward unlocked media / recovered text to Owner WhatsApp DM      │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                      EXPRESS REST API (/api/vault/*)                       │
│  • GET    /api/vault/items          (List/filter View-Once & Deleted)      │
│  • GET    /api/vault/media/:id      (Stream/download decrypted file)       │
│  • POST   /api/vault/settings       (Toggle interceptors & DM target)      │
│  • POST   /api/vault/forward/:id    (Re-send item to any WhatsApp number)  │
│  • DELETE /api/vault/items/:id      (Delete item or clear vault)           │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     WEB DASHBOARD VAULT & RECOVERY UI                      │
│  ┌──────────────────────────┬──────────────────────────┬────────────────┐  │
│  │ Interceptor Settings Bar │ Segmented Filter & Search│ Media Lightbox │  │
│  │ (View-Once / Anti-Delete │ (All · View-Once ·       │ & One-Click    │  │
│  │  / DM Target Number)     │  Deleted · Group/Private)│ Download / Fwd │  │
│  └──────────────────────────┴──────────────────────────┴────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & State

1. **`recovered_items` (SQLite Table)**:
   - `id`: Primary key
   - `message_id`: Original WhatsApp stanza ID
   - `session_number`: Connected bot/owner phone number
   - `capture_type`: `'view_once'` | `'deleted'`
   - `chat_jid`: Remote JID (`...s.whatsapp.net` or `...g.us`)
   - `chat_type`: `'private'` | `'group'`
   - `sender_jid`: Participant/sender JID
   - `sender_name`: PushName or formatted number
   - `media_type`: `'text'` | `'image'` | `'video'` | `'audio'` | `'document'`
   - `text_content`: Message text or media caption
   - `file_name`: Stored filename in `/data/vault/`
   - `mime_type`: Media MIME type (`image/jpeg`, `video/mp4`, `audio/ogg`, etc.)
   - `file_size`: Size in bytes
   - `forwarded_to_dm`: Boolean flag (`0` or `1`)
   - `original_timestamp`: Epoch ms when originally sent
   - `captured_at`: ISO timestamp when unlocked or revoked

2. **`interceptor_settings` (Settings Store)**:
   - `enableViewOnce`: Boolean (default `true`)
   - `enableAntiDelete`: Boolean (default `true`)
   - `autoForwardDm`: Boolean (default `true`)
   - `targetDmNumber`: Target WhatsApp number for DM delivery

### Interactive Component & State Mapping

- **All Services Drawer Cards**: Two prominent service cards (**View-Once Downloader** and **Deleted Msg Fetcher**) open the Recovery Vault workspace pre-filtered to the selected mode.
- **Interceptor Config Controls**: Toggle switches and target DM number input immediately persist via `POST /api/vault/settings` and update the live interceptor state without restarting the socket.
- **Segmented Filter & Search Bar**: Client-side and API-backed filtering across Capture Type (`All`, `View-Once`, `Deleted`), Chat Source (`All`, `Private`, `Group`), Media Type (`All`, `Photo`, `Video`, `Audio`, `Text`), and keyword search.
- **Vault Item Actions**:
  - **Download**: Triggers native file download via `/api/vault/media/:id?download=1`.
  - **Forward to WhatsApp**: Sends the unlocked media or recovered text to any specified WhatsApp number via `/api/vault/forward/:id`.
  - **Delete / Clear All**: Removes individual records or wipes the vault with confirmation.
