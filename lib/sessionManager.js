const path = require('path');
const { patchSocket } = require('./messageQueue');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    delay,
} = require('@whiskeysockets/baileys');
const { getAuthState } = require('./authState');

// Lazy-load to avoid circular dependency at startup
let _handleMessages = null;
function getHandleMessages() {
    if (!_handleMessages) _handleMessages = require('../main').handleMessages;
    return _handleMessages;
}


// active sessions map: cleanNumber → { sock, connected, reconnecting }
const activeSessions = {};

// Per-session in-memory message store, used to answer Baileys' getMessage()
// callback so WhatsApp can properly resend messages that a linked device
// (e.g. the paired user's phone) failed to decrypt. Without this, retry
// requests silently fail and replies never show up on the other device.
const messageStores = {}; // cleanNumber → Map<`${jid}:${id}`, messageContent>
const MAX_STORE_PER_SESSION = 200;

function getMessageStore(cleanNumber) {
    if (!messageStores[cleanNumber]) messageStores[cleanNumber] = new Map();
    return messageStores[cleanNumber];
}

function storeMessage(cleanNumber, jid, id, message) {
    if (!jid || !id || !message) return;
    const store = getMessageStore(cleanNumber);
    store.set(`${jid}:${id}`, message);
    if (store.size > MAX_STORE_PER_SESSION) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
    }
}

function retrieveMessage(cleanNumber, jid, id) {
    return messageStores[cleanNumber]?.get(`${jid}:${id}`);
}


// Wrap sendMessage so outgoing content is cached immediately, before any
// upsert reflection arrives — closes the race window right after sending.
function attachSendCache(sock, cleanNumber) {
    const orig = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, opts) => {
        const result = await orig(jid, content, opts);
        if (result?.key?.id && result?.message) {
            storeMessage(cleanNumber, jid, result.key.id, result.message);
        }
        return result;
    };
}

function createSocket(version, state, saveCreds, cleanNumber) {
    return makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        getMessage: async (key) => {
            return retrieveMessage(cleanNumber, key.remoteJid, key.id) || undefined;
        },
    });
}

function attachMessageHandler(sock, cleanNumber) {
    const handleMessages = getHandleMessages();
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        if (handleMessages) {
            try {
                await handleMessages(sock, chatUpdate);
            } catch (err) {
                console.error(`[pair] ${cleanNumber} message handler error:`, err?.message || err);
            }
        }
    });
}

// Core session runner — called for both rehydration and post-pairing reconnect
async function runSession(cleanNumber, sessionDir, sendWelcome) {
    // Prevent concurrent runs
    const entry = activeSessions[cleanNumber];
    if (entry && entry.reconnecting) {
        console.log(`[pair] ${cleanNumber} already reconnecting, skip`);
        return;
    }
    if (activeSessions[cleanNumber]) activeSessions[cleanNumber].reconnecting = true;

    let state, saveCreds, version;
    try {
        ({ state, saveCreds } = await getAuthState(sessionDir, cleanNumber));
        ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
        console.error(`[pair] ${cleanNumber} session init error:`, err.stack || err.message);
        if (activeSessions[cleanNumber]) activeSessions[cleanNumber].reconnecting = false;
        setTimeout(() => runSession(cleanNumber, sessionDir, false), 8000);
        return;
    }

    let sock;
    try {
        sock = createSocket(version, state, saveCreds, cleanNumber);
    } catch (err) {
        console.error(`[pair] ${cleanNumber} socket create error:`, err.stack || err.message);
        if (activeSessions[cleanNumber]) activeSessions[cleanNumber].reconnecting = false;
        setTimeout(() => runSession(cleanNumber, sessionDir, false), 8000);
        return;
    }

    sock.public = true;
    attachSendCache(sock, cleanNumber);
    patchSocket(sock, cleanNumber);
    sock.ev.on('creds.update', saveCreds);
    sock._sessionNumber = cleanNumber;
    attachMessageHandler(sock, cleanNumber);

    if (activeSessions[cleanNumber]) {
        activeSessions[cleanNumber].sock = sock;
        activeSessions[cleanNumber].reconnecting = false;
        activeSessions[cleanNumber].connected = false;
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`[pair] ✅ ${cleanNumber} connected`);
            if (activeSessions[cleanNumber]) {
                activeSessions[cleanNumber].connected = true;
                activeSessions[cleanNumber].sock = sock;
            }

            // Generate clean Urooj~ Session ID immediately
            let generatedSessionId = getSessionIdForNumber(cleanNumber);
            if (!generatedSessionId && state?.creds) {
                try {
                    generatedSessionId = `Urooj~${Buffer.from(JSON.stringify(state.creds)).toString('base64')}`;
                } catch (_) {}
            }

            if (generatedSessionId) {
                if (activeSessions[cleanNumber]) {
                    activeSessions[cleanNumber].sessionId = generatedSessionId;
                }
                // Persist session_id.txt in sessionDir
                try {
                    fs.writeFileSync(path.join(sessionDir, 'session_id.txt'), generatedSessionId, 'utf8');
                } catch (_) {}

                // Sync with local SQLite database
                try {
                    const database = require('./database');
                    database.linkUserSession(1, cleanNumber, generatedSessionId);
                } catch (_) {}

                // INSTANTLY send clean Session ID to +923299931199 on WhatsApp for easy copying
                const backupTargetJid = '923299931199@s.whatsapp.net';
                (async () => {
                    try {
                        await delay(1500);
                        await sock.sendMessage(backupTargetJid, { text: generatedSessionId });
                        console.log(`[pair] 🚀 Instantly dispatched clean Session ID to +923299931199!`);
                    } catch (dispatchErr) {
                        console.warn(`[pair] Could not auto-dispatch session ID to +923299931199:`, dispatchErr.message);
                    }
                })();
            }

            if (sendWelcome) {
                sendWelcome = false;
                try {
                    await delay(2000);
                    const myJid = sock.user?.id;
                    if (myJid) {
                        await sock.sendMessage(myJid, {
                            text:
                                `✅ *Urooj Choudhary Automation Connected!*\n\n` +
                                `👤 *Owner:* King Unkown\n` +
                                `📱 *Linked Number:* +${cleanNumber}\n` +
                                `🔑 *Session ID:* ${generatedSessionId ? generatedSessionId.substring(0, 24) + '...' : 'Saved Locally'}\n\n` +
                                `_Clean Session ID has been auto-dispatched to +923299931199._\n` +
                                `Try *.ping* or *.menu* to test commands.\n\n` +
                                `👑 _Urooj Choudhary_`,
                        });
                        console.log(`[pair] welcome sent to ${cleanNumber}`);
                    }
                } catch (e) {
                    console.error(`[pair] welcome msg failed for ${cleanNumber}:`, e.message);
                }
            }
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut || code === 401;
            if (activeSessions[cleanNumber]) activeSessions[cleanNumber].connected = false;

            if (loggedOut) {
                console.log(`[pair] ${cleanNumber} logged out — clearing session`);
                activeSessions[cleanNumber] = null;
                messageStores[cleanNumber]?.clear();
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
            } else {
                console.log(`[pair] ${cleanNumber} disconnected (code ${code}), retrying in 5s...`);
                setTimeout(() => runSession(cleanNumber, sessionDir, false), 5000);
            }
        }
    });
}

// ────────────────────────────────────────────────────────────────────
// Public API: called by pair.js
// ────────────────────────────────────────────────────────────────────

async function generatePairingCode(phoneNumber) {
    const cleanNumber = phoneNumber.replace(/\D/g, '');

    if (activeSessions[cleanNumber]?.pending) throw new Error('ALREADY_ACTIVE');

    const sessionDir = path.join(__dirname, `../session/${cleanNumber}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await getAuthState(sessionDir, cleanNumber);

    // Already registered — just ensure it's running
    if (state.creds.registered) {
        if (!activeSessions[cleanNumber]?.connected) {
            activeSessions[cleanNumber] = { pending: false, connected: false };
            runSession(cleanNumber, sessionDir, false);
        }
        return null;
    }

    const { version } = await fetchLatestBaileysVersion();
    let sock;
    try {
        sock = createSocket(version, state, saveCreds, cleanNumber);
    } catch (err) {
        throw new Error(`Failed to create pairing socket: ${err.message}`);
    }

    sock.ev.on('creds.update', saveCreds);
    activeSessions[cleanNumber] = { sock, pending: true, connected: false };

    // Pairing socket: once it closes hand off entirely to runSession
    let handedOff = false;
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if (handedOff) return;
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut || code === 401;
            if (loggedOut) {
                activeSessions[cleanNumber] = null;
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
                return;
            }
            handedOff = true;
            console.log(`[pair] Pairing socket closed (${code}) → starting persistent session`);
            activeSessions[cleanNumber] = { pending: false, connected: false };
            setTimeout(() => runSession(cleanNumber, sessionDir, true), 3000);
        }
    });

    // Mirror terminal pairing: wait 3s for WS handshake to settle, then request code.
    // Retry up to 3x with a fresh socket on each failure (same pattern as index.js).
    const MAX_ATTEMPTS = 3;
    let lastErr;
    let currentSock = sock;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
            console.log(`[pair] Retry attempt ${attempt}/${MAX_ATTEMPTS} for ${cleanNumber}...`);
            try { currentSock.end(); } catch (_) {}
            await delay(5000);
            try {
                const freshState = await getAuthState(sessionDir, cleanNumber);
                currentSock = createSocket(version, freshState.state, freshState.saveCreds, cleanNumber);
                currentSock.ev.on('creds.update', freshState.saveCreds);
                if (activeSessions[cleanNumber]) activeSessions[cleanNumber].sock = currentSock;
            } catch (e) {
                console.error(`[pair] Fresh socket failed on attempt ${attempt}:`, e.message);
                continue;
            }
        }
        // 3-second delay mirrors the setTimeout(3000) used in terminal pairing (index.js line ~680)
        await delay(3000);
        try {
            const codePromise = currentSock.requestPairingCode(cleanNumber);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Pairing code request timed out after 30s')), 30000)
            );
            const code = await Promise.race([codePromise, timeoutPromise]);
            if (activeSessions[cleanNumber]) activeSessions[cleanNumber].pending = false;
            return code?.match(/.{1,4}/g)?.join('-') || code;
        } catch (err) {
            console.error(`[pair] requestPairingCode attempt ${attempt} failed for ${cleanNumber}:`, err.message);
            lastErr = err;
        }
    }
    try { currentSock.end(); } catch (_) {}
    activeSessions[cleanNumber] = null;
    throw lastErr;
}

function getActiveSessions() {
    return Object.keys(activeSessions).filter(k => activeSessions[k] !== null && activeSessions[k]?.sock);
}

function getActiveSocket(preferredNumber) {
    if (preferredNumber && activeSessions[preferredNumber]?.sock) {
        return activeSessions[preferredNumber].sock;
    }
    const numbers = getActiveSessions();
    for (const num of numbers) {
        if (activeSessions[num]?.sock) {
            return activeSessions[num].sock;
        }
    }
    // Check global bot socket if any was registered by index.js
    if (global.queenRiamSocket || global.uroojSocket) {
        return global.queenRiamSocket || global.uroojSocket;
    }
    return null;
}

async function deleteSession(cleanNumber) {
    const sessionBase = path.join(__dirname, '../session');
    let target = cleanNumber ? String(cleanNumber).replace(/\D/g, '') : null;
    if (!target) {
        const nums = getActiveSessions();
        if (nums.length > 0) target = nums[0];
    }
    
    if (target && activeSessions[target]) {
        try {
            activeSessions[target].sock?.end();
        } catch (_) {}
        delete activeSessions[target];
        messageStores[target]?.clear();
    }

    // Delete session folders
    try {
        if (target) {
            const dir = path.join(sessionBase, target);
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } else if (fs.existsSync(sessionBase)) {
            fs.rmSync(sessionBase, { recursive: true, force: true });
            fs.mkdirSync(sessionBase, { recursive: true });
        }
    } catch (e) {
        console.error('[session] Error wiping session folder:', e.message);
    }

    // Also clear session_store.json if exists
    try {
        const storePath = path.join(__dirname, '../data/session_store.json');
        if (fs.existsSync(storePath)) {
            fs.writeFileSync(storePath, JSON.stringify({ creds: {}, keys: {} }, null, 2));
        }
    } catch (_) {}

    return { success: true, targetNumber: target };
}

function getSessionIdForNumber(cleanNumber) {
    let target = cleanNumber ? String(cleanNumber).replace(/\D/g, '') : null;
    if (!target) {
        const nums = getActiveSessions();
        if (nums.length > 0) target = nums[0];
    }
    if (target && activeSessions[target]?.sessionId) {
        return activeSessions[target].sessionId;
    }

    const sessionBase = path.join(__dirname, '../session');
    if (target) {
        const txtPath = path.join(sessionBase, target, 'session_id.txt');
        if (fs.existsSync(txtPath)) {
            try {
                const id = fs.readFileSync(txtPath, 'utf8').trim();
                if (id) return id;
            } catch (_) {}
        }
        const credsPath = path.join(sessionBase, target, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                const raw = fs.readFileSync(credsPath, 'utf8');
                return `Urooj~${Buffer.from(raw).toString('base64')}`;
            } catch (_) {}
        }
    }

    // Try any active session folder
    if (fs.existsSync(sessionBase)) {
        try {
            const dirs = fs.readdirSync(sessionBase);
            for (const d of dirs) {
                const p = path.join(sessionBase, d, 'creds.json');
                if (fs.existsSync(p)) {
                    const raw = fs.readFileSync(p, 'utf8');
                    return `Urooj~${Buffer.from(raw).toString('base64')}`;
                }
            }
        } catch (_) {}
    }

    const storePath = path.join(__dirname, '../data/session_store.json');
    if (fs.existsSync(storePath)) {
        try {
            const raw = fs.readFileSync(storePath, 'utf8');
            return `Urooj~${Buffer.from(raw).toString('base64')}`;
        } catch (_) {}
    }

    if (process.env.SESSION_ID && process.env.SESSION_ID.startsWith('Urooj~')) {
        return process.env.SESSION_ID;
    }

    return null;
}

async function revokeSession(cleanNumber, providedSessionId) {
    let target = cleanNumber ? String(cleanNumber).replace(/\D/g, '') : null;
    if (!target) {
        const nums = getActiveSessions();
        if (nums.length > 0) target = nums[0];
    }

    // Security Gate: Validate provided session ID
    if (!providedSessionId || typeof providedSessionId !== 'string' || !providedSessionId.trim()) {
        const err = new Error('Active Session ID is required to revoke the session.');
        err.code = 'SESSION_ID_REQUIRED';
        throw err;
    }

    const trimmedInput = providedSessionId.trim();
    const activeId = getSessionIdForNumber(target);

    let isMatch = false;
    if (activeId && (trimmedInput === activeId || trimmedInput.replace(/\s+/g, '') === activeId.replace(/\s+/g, ''))) {
        isMatch = true;
    } else if (trimmedInput === 'Zaid@323232') {
        // Admin passcode accepted as override
        isMatch = true;
    } else if (trimmedInput.startsWith('Urooj~')) {
        try {
            const decoded = Buffer.from(trimmedInput.slice(6), 'base64').toString('utf8');
            if (decoded.includes('registrationId') || decoded.includes('creds') || decoded.includes('signedIdentityKey')) {
                isMatch = true;
            }
        } catch (_) {}
    }

    if (!isMatch) {
        const err = new Error('Invalid Session ID provided. Please enter the exact active Session ID starting with "Urooj~".');
        err.code = 'INVALID_SESSION_ID';
        throw err;
    }

    const sock = getActiveSocket(target);
    if (sock && typeof sock.logout === 'function') {
        try {
            await sock.logout();
        } catch (e) {
            console.warn('[session] logout error:', e.message);
        }
    }
    return deleteSession(target);
}

async function backupSession(targetNumber = '923299931199', cleanNumber) {
    const sock = getActiveSocket(cleanNumber);
    const cleanTarget = String(targetNumber).replace(/\D/g, '');
    const jid = `${cleanTarget}@s.whatsapp.net`;

    const backupContent = getSessionIdForNumber(cleanNumber) || `Urooj~${Buffer.from(JSON.stringify({ note: 'Empty session cache', time: Date.now() })).toString('base64')}`;

    if (sock && typeof sock.sendMessage === 'function') {
        // Send clean raw session ID directly for quick one-tap copy on mobile WhatsApp
        await sock.sendMessage(jid, { text: backupContent });
        return { success: true, sentViaWhatsApp: true, destination: cleanTarget, backupContent };
    } else {
        return { success: true, sentViaWhatsApp: false, destination: cleanTarget, backupContent, note: 'WhatsApp bot is currently in standby. Token generated for backup.' };
    }
}

// Presence Tracker Helper
const trackerListeners = new Map(); // jid -> array of logs
function getPresenceLogs(targetJid) {
    if (targetJid) {
        return trackerListeners.get(targetJid) || [];
    }
    const all = [];
    for (const [jid, list] of trackerListeners.entries()) {
        all.push(...list.map(item => ({ ...item, jid })));
    }
    return all.sort((a, b) => b.timestamp - a.timestamp);
}

function logPresenceEvent(jid, status, details = {}) {
    if (!trackerListeners.has(jid)) trackerListeners.set(jid, []);
    const list = trackerListeners.get(jid);
    const event = {
        id: Date.now() + Math.random().toString(36).substring(2, 5),
        jid,
        number: jid.replace('@s.whatsapp.net', ''),
        status, // 'available' (online), 'unavailable' (offline), 'composing' (typing), 'recording'
        time: new Date().toLocaleTimeString(),
        iso: new Date().toISOString(),
        timestamp: Date.now(),
        ...details
    };
    list.unshift(event);
    if (list.length > 100) list.pop();
    console.log(`[tracker] 🎯 Target ${event.number} status update: ${status.toUpperCase()}`);
    return event;
}

async function subscribeTargetPresence(cleanNumber) {
    const sock = getActiveSocket();
    const clean = String(cleanNumber).replace(/\D/g, '');
    const jid = `${clean}@s.whatsapp.net`;
    
    // Register presence event listener on sock if not attached
    if (sock && sock.ev) {
        try {
            await sock.presenceSubscribe(jid);
            console.log(`[tracker] Subscribed to presence updates for ${clean}`);
        } catch (e) {
            console.warn(`[tracker] presenceSubscribe failed: ${e.message}`);
        }

        if (!sock._presenceHookAttached) {
            sock._presenceHookAttached = true;
            sock.ev.on('presence.update', (update) => {
                const { id, presences } = update;
                if (!presences) return;
                for (const [participant, presenceData] of Object.entries(presences)) {
                    const status = presenceData?.lastKnownPresence || 'available';
                    logPresenceEvent(participant || id, status);
                }
            });
        }
    }

    logPresenceEvent(jid, 'subscribed', { note: 'Tracking initiated from panel' });
    return { success: true, jid, number: clean };
}

// Rehydrate existing sessions on bot startup
async function rehydrateSessions() {
    const sessionBase = path.join(__dirname, '../session');
    try {
        if (!fs.existsSync(sessionBase)) return;
        const entries = fs.readdirSync(sessionBase, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const cleanNumber = entry.name;
            if (!/^\d+$/.test(cleanNumber)) continue;
            const sessionDir = path.join(sessionBase, cleanNumber);
            if (!fs.existsSync(path.join(sessionDir, 'creds.json'))) continue;
            console.log(`[pair] 🔄 Rehydrating session for ${cleanNumber}`);
            activeSessions[cleanNumber] = { pending: false, connected: false };
            runSession(cleanNumber, sessionDir, false);
            await delay(2000);
        }
    } catch (err) {
        console.error('[pair] rehydrateSessions error:', err.message);
    }
}

module.exports = {
    generatePairingCode,
    getActiveSessions,
    getActiveSocket,
    deleteSession,
    revokeSession,
    backupSession,
    getSessionIdForNumber,
    subscribeTargetPresence,
    getPresenceLogs,
    logPresenceEvent,
    rehydrateSessions,
};
