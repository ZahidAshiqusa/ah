# Urooj Choudhary Bot Commands & Global Owner Rebranding

Adds six specialized WhatsApp automation commands (`.button`, `.ptv`, `.voice`, `.😍`, `.qouted`, and `.online`) and updates the bot's identity across every menu, caption, and notification channel to **Urooj Choudhary** (`+254141693915`).

### User Review & Critical Decisions

> [!IMPORTANT]
> The following choices were confirmed from your answers and will govern how the new commands operate:

- **Confirmed Decision 1 (Target Number Requirement for `.button` & `.qouted`)**: Both `.button` and `.qouted` always require a target phone number (e.g., `+923...`) and will dispatch the interactive button message or fake-quoted message directly to that recipient's WhatsApp chat.
- **Confirmed Decision 2 (View-Once `.😍` Delivery Target)**: Replying to any View-Once photo, video, or voice note with `.😍` will decrypt the media and deliver the unlocked file exclusively to the Owner DM (`+254141693915`).
- **Confirmed Decision 3 (Global Owner Identity)**: Every bot menu, command response caption, status viewer message, session backup target, and dashboard badge will display **Urooj Choudhary** and route owner notifications to **`+254141693915`**.

---

### 1. Overview & Core Concept

- **What It Does**: Expands the WhatsApp bot with six high-utility messaging, media transformation, View-Once unlocking, and real-time online presence tracking commands while unifying the entire suite under the **Urooj Choudhary** brand and owner number **`+254141693915`**.
- **Target Audience / Persona**: Bot owner (**Urooj Choudhary**) and authorized paired sessions operating via WhatsApp and the Web Control Hub.
- **Key Value**: Enables one-command delivery of circular video notes (`.ptv`), voice notes (`.voice`), interactive buttons (`.button`), synthetic quoted replies (`.qouted`), instant View-Once extraction to the owner's private chat (`.😍`), and live online presence history tracking (`.online`).

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **`.button` Interactive Message Flow**: Send `.button/msg/buttonlimit/button1/button2 +923number` (or `.button/+923number/msg/buttonlimit/button1/button2`). The bot parses the target number, limits the rendered buttons to `buttonlimit`, and sends an interactive button card with the footer `© Urooj Choudhary` to the target number.
  2. **`.ptv` Circular Video Flow**: Reply to any video message with `.ptv +923number`. The bot downloads the video stream and dispatches it to `+923number` as a circular WhatsApp Video Note (`ptv: true`).
  3. **`.voice` Voice Note Flow**: Reply to any audio or video message with `.voice +923number`. The bot extracts the audio stream and sends it to `+923number` as a playable WhatsApp Voice Note (`ptt: true`).
  4. **`.😍` View-Once Unlocker Flow**: Reply to any View-Once photo, video, or audio with `.😍`. The bot unwraps the View-Once container, decrypts the media buffer, stores a backup in the persistent Vault, and sends the unlocked media file with caption `👑 Urooj Choudhary` directly to `+254141693915`.
  5. **`.qouted` Fake Quoted Reply Flow**: Send `.qouted msg1/replied +923number` (or `.qouted/+923number/msg1/replied`). The bot constructs a synthetic quoted message context where the recipient appears to have written `msg1`, and sends `replied` as a direct reply to that quoted bubble in the recipient's chat.
  6. **`.online` Presence History Tracker Flow**: Send `.online +9232number`. The bot subscribes to real-time WhatsApp presence updates for that number, logs every `online` (`available`), `typing` (`composing`), `recording`, and `offline` (`unavailable`) event with timestamps, and replies with the target's live status and timestamped online history.
- **Visual Identity & Theme**:
  - *Bot Menus & Captions*: Styled box-drawing command menus and media captions branded with `👑 Urooj Choudhary` and owner contact `+254141693915`.
  - *Dashboard Command Registry*: All six commands automatically populate in the Web Control Hub's command explorer with clear syntax examples and category tags.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Dual-Layer Command Routing (Pre-Processor + Plugin Registry)**
  - *Chosen Approach*: Register all 6 commands in the standard plugin registry so they appear in `.menu` / `.help` and the web dashboard, while also attaching a direct message pre-processor on the WhatsApp socket.
  - *Why*: Standard alphanumeric command parsers strip slashes and emojis, which would break `.button/msg/buttonlimit/button1/button2` and `.😍`. A direct pre-processor guarantees 100% reliable execution for slash-delimited and emoji commands.
  - *Alternatives Considered*: Modifying only the standard plugin loader, which would fail to match `.😍` or slash-separated arguments without spaces.
- **Decision 2: Persistent & Real-Time Presence Tracking for `.online`**
  - *Chosen Approach*: Maintain an active `presence.update` listener on each connected WhatsApp socket that records timestamped online/offline transitions per tracked JID, triggered automatically when `.online +number` is called.
  - *Why*: WhatsApp only streams presence updates after explicitly subscribing to a JID (`presenceSubscribe`). Recording transitions as they occur builds an accurate timeline of when the target number came online and went offline.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:
```
┌──────────────────────────────────────────────────────────────────────────┐
│                     WhatsApp Socket (Baileys Engine)                     │
└───────────────────┬──────────────────────────────────┬───────────────────┘
                    │ messages.upsert                  │ presence.update
                    ▼                                  ▼
┌───────────────────────────────────────┐  ┌───────────────────────────────┐
│   Custom Command Pre-Processor &      │  │   Online Presence Tracker     │
│           Plugin Registry             │  │  (JID Subscription & History) │
├───────────────────────────────────────┤  └───────────────┬───────────────┘
│ • .button/msg/limit/b1/b2 +number     │                  │
│ • .ptv +number (Circular Video Note)  │                  ▼
│ • .voice +number (PTT Voice Note)     │  ┌───────────────────────────────┐
│ • .😍 (View-Once -> +254141693915 DM) │  │   Timestamped Online Log      │
│ • .qouted msg1/replied +number        │  │  (Current State + History)    │
│ • .online +number                     │  └───────────────────────────────┘
└───────────────────┬───────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│          Global Identity & Branding Layer (Urooj Choudhary)              │
│   • Owner Number: +254141693915 (254141693915@s.whatsapp.net)            │
│   • Menus, Captions, Status Replies, Vault DM & Web Dashboard            │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Data Model & State**:
  - **Owner Identity Config**: `ownerNumber: "254141693915"`, `botOwner: "Urooj Choudhary"`, `botName: "Urooj Choudhary"`.
  - **Presence History Store**: Maps normalized JIDs (`<digits>@s.whatsapp.net`) to `{ currentStatus, lastSeen, history: [{ status, timestamp }] }` with automatic cap to prevent memory bloat.
- **Interactive Component & State Mapping**:
  - Phone numbers passed to `.button`, `.ptv`, `.voice`, `.qouted`, and `.online` are sanitized by stripping `+`, spaces, and dashes and appending `@s.whatsapp.net`.
  - `.😍` inspects both direct and nested `viewOnceMessage` / `viewOnceMessageV2` / `viewOnceMessageV2Extension` wrappers and forwards the unlocked media stream directly to `254141693915@s.whatsapp.net`.
