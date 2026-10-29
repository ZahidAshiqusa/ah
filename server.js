'use strict';

/**
 * Urooj Choudhary - WhatsApp Automation Suite & Bot Management Server
 * Owner: King Unkown
 * Master Admin: Urooj (Passcode: Zaid@323232)
 * Binds to 0.0.0.0:3000
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config({ override: true });

const database = require('./lib/database');
const { SESSIONS_DIR, CONFIG_PATH, getVolumeDiagnostics } = require('./lib/storagePaths');
const AdmZip = require('adm-zip');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Passcode & Backup configuration
const DASHBOARD_PASSCODE = 'Zaid@323232';
const BACKUP_DESTINATION_NUMBER = process.env.OWNER_NUMBER || '923299931199';

// In-memory circular log buffer
const MAX_LOGS = 300;
const logBuffer = [];

function logEvent(line) {
    const timestamp = new Date().toISOString().substring(11, 19);
    const msg = `[${timestamp}] ${line}`;
    logBuffer.push(msg);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

// Hook console.log and console.error to logBuffer
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origErr = console.error.bind(console);

console.log = (...args) => {
    origLog(...args);
    try { logEvent(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (_) {}
};
console.warn = (...args) => {
    origWarn(...args);
    try { logEvent('[WARN] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (_) {}
};
console.error = (...args) => {
    origErr(...args);
    try { logEvent('[ERROR] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (_) {}
};

// Universal CORS Middleware (Allows Published AI Studio Frontend to talk to Railway Backend 24/7)
app.use((req, res, next) => {
    const allowedOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Auth-Token, X-Railway-Bridge');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

// Middleware: Support JSON and large payloads for media uploads (up to 50MB for video notes)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Safe loaders
let pluginLoader = null;
let sessionManager = null;
let loadedPluginsCount = 0;
let registeredCommandsCount = 0;

try {
    pluginLoader = require('./lib/pluginLoader');
    const map = pluginLoader.loadPlugins();
    registeredCommandsCount = map.size;
    loadedPluginsCount = pluginLoader.getPlugins().length;
} catch (err) {
    console.error('Failed to initialize pluginLoader:', err.message);
}

try {
    sessionManager = require('./lib/sessionManager');
} catch (err) {
    console.error('Failed to initialize sessionManager:', err.message);
}

// Read settings
function getMergedConfig() {
    let fileConfig = {};
    const configPath = CONFIG_PATH;
    try {
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (_) {}

    let baseSettings = {};
    try {
        baseSettings = require('./settings');
    } catch (_) {}

    return {
        botName: fileConfig.BOT_NAME || baseSettings.botName || process.env.BOT_NAME || 'Urooj Choudhary',
        botOwner: fileConfig.BOT_OWNER || baseSettings.botOwner || process.env.BOT_OWNER || 'King Unkown',
        prefix: fileConfig.PREFIX || baseSettings.prefix || process.env.PREFIX || '.',
        commandMode: fileConfig.COMMAND_MODE || baseSettings.commandMode || process.env.COMMAND_MODE || 'public',
        timezone: fileConfig.TIMEZONE || baseSettings.timezone || process.env.TIMEZONE || 'Asia/Karachi',
        AUTO_STATUS_REACT: fileConfig.AUTO_STATUS_REACT || baseSettings.AUTO_STATUS_REACT || 'true',
        AUTO_STATUS_REPLY: fileConfig.AUTO_STATUS_REPLY || baseSettings.AUTO_STATUS_REPLY || 'false',
        AUTOREAD: fileConfig.AUTOREAD || baseSettings.AUTOREAD || 'false',
        AUTOTYPE: fileConfig.AUTOTYPE || baseSettings.AUTOTYPE || 'false',
        AUTORECORD: fileConfig.AUTORECORD || baseSettings.AUTORECORD || 'false',
        ALWAYSONLINE: fileConfig.ALWAYSONLINE || 'true',
        BUTTONMODE: fileConfig.BUTTONMODE || 'on',
        avatarCaption: 'Urooj Choudhary',
        avatarUrl: '/assets/aistudio/file_00000000f0bc8208be82cd16e83afef8_ac51e6b8.png',
        backupDestinationNumber: BACKUP_DESTINATION_NUMBER,
        railwayBackendUrl: String(fileConfig.RAILWAY_BACKEND_URL || process.env.RAILWAY_BACKEND_URL || '').trim().replace(/\/+$/, '')
    };
}

// Format uptime
function getFormattedUptime() {
    const sec = Math.floor(process.uptime());
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m ${s}s`;
    return `${m}m ${s}s`;
}

// Format Phone Number to WhatsApp JID
function toWhatsAppJid(numberOrJid) {
    if (!numberOrJid) return null;
    let clean = String(numberOrJid).trim();
    if (clean.includes('@s.whatsapp.net') || clean.includes('@g.us')) {
        return clean;
    }
    clean = clean.replace(/\D/g, '');
    if (!clean) return null;
    return `${clean}@s.whatsapp.net`;
}

// ── DEVICE IDENTITY & AUTHENTICATION MIDDLEWARE ──────────────────────────────
app.use((req, res, next) => {
    // Extract unique device ID header or query parameter
    const rawDevId = req.headers['x-device-id'] || req.query.device_id || 'mobile_device';
    req.deviceId = String(rawDevId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'mobile_device';

    const authHeader = req.headers.authorization || req.headers['x-auth-token'];
    let token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null;
    if (!token && req.query.token) {
        token = String(req.query.token).trim();
    }

    if (token) {
        // Check for legacy passcode token or master admin token
        if (token.startsWith('auth_') && token.includes(DASHBOARD_PASSCODE)) {
            req.user = { id: 1, username: 'Urooj', role: 'admin', deviceId: req.deviceId };
        } else {
            const user = database.validateToken(token);
            if (user) {
                req.user = { ...user, deviceId: req.deviceId };
            }
        }
    }

    // Direct Device Owner Mode: auto-bind client without forced cloud sign-in
    if (!req.user && req.deviceId) {
        const shortDev = req.deviceId.slice(-6).toUpperCase();
        req.user = {
            id: req.deviceId,
            username: `Device #${shortDev}`,
            role: 'owner',
            deviceId: req.deviceId
        };
    }

    next();
});

function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Device authentication required.' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Super Admin privileges required (Username: Urooj).' });
    }
    next();
}

// ── API ROUTES ─────────────────────────────────────────────────────────────

// 1. AUTHENTICATION (Sign Up, Sign In, Profile, Sign Out)

// Sign Up
app.post('/api/auth/signup', (req, res) => {
    const { username, password } = req.body;
    try {
        const user = database.registerUser(username, password, 'user');
        const login = database.loginUser(username, password);
        console.log(`[auth] 👤 New user registered: ${user.username} (ID: ${user.id})`);
        res.json({
            success: true,
            message: `Account created successfully! Welcome, ${user.username}.`,
            token: login.token,
            expiresAt: login.expiresAt,
            user: login.user
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Sign In (Supports standard users and Super Admin Urooj with Zaid@323232)
app.post('/api/auth/signin', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const login = database.loginUser(username, password);
        console.log(`[auth] 🔓 Successful sign in for user: ${login.user.username} (Role: ${login.user.role})`);
        res.json({
            success: true,
            message: `Welcome back, ${login.user.username}!`,
            token: login.token,
            expiresAt: login.expiresAt,
            user: login.user
        });
    } catch (err) {
        console.warn(`[auth] 🔒 Failed sign in attempt for "${username}":`, err.message);
        res.status(401).json({ error: 'Invalid username or password.' });
    }
});

// Get Current User Profile & Saved Sessions
app.get('/api/auth/me', (req, res) => {
    if (!req.user) {
        return res.json({ authenticated: false, user: null, sessions: [] });
    }
    const userSessions = database.getUserSessions(req.user.id);
    res.json({
        authenticated: true,
        user: req.user,
        sessions: userSessions
    });
});

// Sign Out
app.post('/api/auth/signout', (req, res) => {
    const authHeader = req.headers.authorization || req.headers['x-auth-token'];
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : req.body?.token;
    if (token) {
        database.logoutToken(token);
    }
    res.json({ success: true, message: 'Signed out successfully' });
});

// Zero-Logout Session Rehydration (Restores or re-issues permanent token across container restarts / backend switches)
app.post('/api/auth/rehydrate', (req, res) => {
    const { token, username, password, role } = req.body || {};
    try {
        if (username && password) {
            const login = database.loginUser(username, password);
            return res.json({
                success: true,
                rehydrated: true,
                token: login.token,
                expiresAt: login.expiresAt,
                user: login.user
            });
        }
        const restored = database.rehydrateOrEnsureUserSession({ token, username, role });
        if (restored) {
            return res.json({
                success: true,
                rehydrated: true,
                token: restored.token,
                expiresAt: restored.expiresAt,
                user: restored.user
            });
        }
        return res.status(404).json({ success: false, error: 'Could not rehydrate session' });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// AI Studio Frontend <-> Railway Backend Bridge Config API
app.get('/api/config/bridge', (req, res) => {
    const cfg = getMergedConfig();
    const envUrl = String(process.env.RAILWAY_BACKEND_URL || '').trim().replace(/\/+$/, '');
    res.json({
        success: true,
        railwayBackendUrl: cfg.railwayBackendUrl || envUrl || '',
        envBackendUrl: envUrl,
        autoReauthEnabled: process.env.AUTO_REAUTH_ENABLED !== 'false',
        keepAliveIntervalMs: Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 45000,
        ownerNumber: BACKUP_DESTINATION_NUMBER
    });
});

app.post('/api/config/bridge', (req, res) => {
    const rawUrl = String(req.body?.railwayBackendUrl ?? '').trim().replace(/\/+$/, '');
    let current = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (_) {}

    current.RAILWAY_BACKEND_URL = rawUrl;
    process.env.RAILWAY_BACKEND_URL = rawUrl;

    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
        console.log(`[bridge] 🔗 Updated RAILWAY_BACKEND_URL -> ${rawUrl || '(Local / Same-Origin)'}`);
        res.json({
            success: true,
            railwayBackendUrl: rawUrl,
            message: rawUrl
                ? `Connected AI Studio Frontend to Railway Backend: ${rawUrl}`
                : 'Cleared custom Railway Backend URL (using local/same-origin backend).'
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save bridge config: ' + err.message });
    }
});

// Legacy passcode route for backward compatibility
app.post('/api/auth/login', (req, res) => {
    const { passcode, username } = req.body;
    if (passcode === DASHBOARD_PASSCODE || (username?.toLowerCase() === 'urooj' && passcode === DASHBOARD_PASSCODE)) {
        console.log('[auth] 🔓 Successful master login via passcode');
        try {
            const login = database.loginUser('Urooj', 'Zaid@323232');
            res.json({
                success: true,
                message: 'Super Admin unlocked successfully',
                token: login.token,
                user: login.user,
                botName: 'Urooj Choudhary',
                botOwner: 'King Unkown',
            });
        } catch (_) {
            res.json({
                success: true,
                message: 'Dashboard unlocked successfully',
                token: Buffer.from(`auth_${DASHBOARD_PASSCODE}_${Date.now()}`).toString('base64'),
                user: { id: 1, username: 'Urooj', role: 'admin' },
                botName: 'Urooj Choudhary',
                botOwner: 'King Unkown',
            });
        }
    } else {
        console.warn('[auth] 🔒 Failed master passcode attempt');
        res.status(401).json({ success: false, error: 'Incorrect passcode. Access denied.' });
    }
});

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        bot: 'Urooj Choudhary',
        owner: 'King Unkown',
        version: '1.0.0',
        uptime: process.uptime(),
    });
});

// Bot Status & Info
app.get('/api/status', (req, res) => {
    const config = getMergedConfig();
    let activeSessions = [];
    let activeSessionId = null;

    if (sessionManager && typeof sessionManager.getActiveSessions === 'function') {
        try {
            activeSessions = sessionManager.getActiveSessions();
            if (activeSessions.length > 0 && typeof sessionManager.getSessionIdForNumber === 'function') {
                activeSessionId = sessionManager.getSessionIdForNumber(activeSessions[0]);
            }
        } catch (_) {}
    }

    res.json({
        status: 'running',
        botName: config.botName,
        botOwner: config.botOwner,
        prefix: config.prefix,
        commandMode: config.commandMode,
        uptimeFormatted: getFormattedUptime(),
        uptimeSeconds: Math.floor(process.uptime()),
        commandsCount: registeredCommandsCount || 236,
        pluginsCount: loadedPluginsCount || 156,
        connectedSessions: activeSessions,
        activeSessionId,
        settings: config,
        dbType: 'sqlite',
        avatarUrl: config.avatarUrl,
        avatarCaption: config.avatarCaption,
        backupNumber: BACKUP_DESTINATION_NUMBER,
    });
});

// Command & Plugin List
app.get('/api/plugins', (req, res) => {
    if (!pluginLoader || typeof pluginLoader.getPlugins !== 'function') {
        return res.json([]);
    }
    try {
        const list = pluginLoader.getPlugins();
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Device Pairing Code Generation (Supports both /api/pair and /api/session/pair)
const handlePairingRequest = async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'WhatsApp phone number is required (e.g. 923299931199)' });
    }
    let cleanNumber = String(phoneNumber).replace(/\D/g, '');
    if (cleanNumber.startsWith('00')) cleanNumber = cleanNumber.substring(2);
    if (cleanNumber.startsWith('0') && cleanNumber.length === 11) {
        cleanNumber = '92' + cleanNumber.substring(1);
    }
    if (!cleanNumber || cleanNumber.length < 7) {
        return res.status(400).json({ error: 'Invalid phone number format. Please include country code (e.g. 923299931199).' });
    }

    if (!sessionManager || typeof sessionManager.generatePairingCode !== 'function') {
        return res.status(500).json({ error: 'Session manager engine not available' });
    }

    try {
        console.log(`[dashboard] 📱 Generating 8-digit pairing code for +${cleanNumber}...`);
        const result = await sessionManager.generatePairingCode(cleanNumber);
        
        // Associate session with logged in user if available
        if (req.user) {
            database.linkUserSession(req.user.id, cleanNumber, null);
        }

        if (result && typeof result === 'object' && result.alreadyConnected) {
            return res.json({ 
                success: true, 
                alreadyConnected: true,
                message: result.message || `Number +${cleanNumber} is already registered and session is running!`,
                cleanNumber
            });
        }

        res.json({ success: true, code: result, cleanNumber });
    } catch (err) {
        console.error(`[dashboard] Pairing failed for +${cleanNumber}:`, err.message);
        res.status(500).json({ error: err.message || 'Failed to generate pairing code' });
    }
};

app.post('/api/pair', handlePairingRequest);
app.post('/api/session/pair', handlePairingRequest);

// 2. WHATSAPP BUTTON MESSENGER
app.post('/api/messenger/buttons', async (req, res) => {
    const { recipient, title, body, footer, buttons } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Recipient phone number is required' });
    }
    if (!body && !title) {
        return res.status(400).json({ error: 'Message content is required' });
    }

    const jid = toWhatsAppJid(recipient);
    if (!jid) {
        return res.status(400).json({ error: 'Invalid recipient format' });
    }

    const sock = sessionManager?.getActiveSocket();
    const btnList = Array.isArray(buttons) ? buttons.slice(0, 5) : [];

    let fullText = '';
    if (title) fullText += `*${title.trim()}*\n\n`;
    if (body) fullText += `${body.trim()}\n`;
    if (footer) fullText += `\n_${footer.trim()}_`;

    console.log(`[buttonMessenger] Preparing interactive message for ${jid} with ${btnList.length} button(s)`);

    if (sock && typeof sock.sendMessage === 'function') {
        try {
            let sent = false;
            try {
                const { sendButtons } = require('kango-wa');
                const formattedButtons = btnList.map((b, idx) => ({
                    id: b.id || `btn_${idx + 1}`,
                    text: b.text || `Button ${idx + 1}`
                }));
                await sendButtons(sock, jid, {
                    text: fullText,
                    footer: footer || '👑 Urooj Choudhary',
                    buttons: formattedButtons
                });
                sent = true;
            } catch (kangoErr) {
                console.warn('[buttonMessenger] native sendButtons error, using template fallback:', kangoErr.message);
            }

            if (!sent) {
                let fallbackMessage = fullText;
                if (btnList.length > 0) {
                    fallbackMessage += '\n\n' + '─'.repeat(24) + '\n';
                    btnList.forEach((btn) => {
                        const typeEmoji = btn.type === 'url' ? '🔗' : btn.type === 'call' ? '📞' : '⚡';
                        fallbackMessage += `\n[ ${typeEmoji} ${btn.text} ]`;
                        if (btn.type === 'url' && btn.action) fallbackMessage += ` (${btn.action})`;
                        if (btn.type === 'call' && btn.action) fallbackMessage += ` (${btn.action})`;
                    });
                }
                await sock.sendMessage(jid, { text: fallbackMessage });
            }

            console.log(`[buttonMessenger] ✅ Message successfully dispatched to ${jid}`);
            res.json({
                success: true,
                message: 'Button message sent successfully!',
                recipient: jid,
                buttonCount: btnList.length,
            });
        } catch (err) {
            console.error(`[buttonMessenger] Dispatch error to ${jid}:`, err.message);
            res.status(500).json({ error: 'Failed to send WhatsApp message: ' + err.message });
        }
    } else {
        console.log(`[buttonMessenger] Bot is in standby. Button message recorded for ${jid}: ${title}`);
        res.json({
            success: true,
            simulated: true,
            message: 'Button message composed and verified! (Connect WhatsApp bot in Device Pairing tab to send live)',
            recipient: jid,
            buttonCount: btnList.length,
        });
    }
});

// 2.1 WHATSAPP FAKE QUOTED MESSAGE REPLY (WITH BUTTONS & AUTHOR SPOOFING)
app.post('/api/messenger/fake-quote', async (req, res) => {
    const { 
        recipient, 
        quoteText, 
        quoteSender = 'recipient', 
        customSenderNumber,
        customSenderName,
        replyText, 
        replyType = 'buttons', 
        buttons = [], 
        footer 
    } = req.body;

    if (!recipient) {
        return res.status(400).json({ error: 'Recipient phone number is required' });
    }
    if (!quoteText || !quoteText.trim()) {
        return res.status(400).json({ error: 'Quoted message text is required' });
    }
    if (!replyText || !replyText.trim()) {
        return res.status(400).json({ error: 'Reply message text is required' });
    }

    const targetJid = toWhatsAppJid(recipient);
    if (!targetJid) {
        return res.status(400).json({ error: 'Invalid recipient phone number format' });
    }

    // Determine author participant and fromMe flag
    let fromMe = false;
    let participantJid = targetJid;
    let displaySender = targetJid.split('@')[0];

    if (quoteSender === 'me') {
        fromMe = true;
        participantJid = undefined;
        displaySender = 'You';
    } else if (quoteSender === 'custom') {
        const customJid = toWhatsAppJid(customSenderNumber);
        if (customJid) {
            participantJid = customJid;
            displaySender = customSenderName ? `${customSenderName} (+${customJid.split('@')[0]})` : `+${customJid.split('@')[0]}`;
        } else {
            participantJid = targetJid;
        }
    } else {
        fromMe = false;
        participantJid = targetJid;
        displaySender = `+${targetJid.split('@')[0]}`;
    }

    // Generate realistic WhatsApp message key ID for the fake quoted message
    const fakeId = '3EB0' + Math.random().toString(36).substring(2, 10).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    const fakeQuoted = {
        key: {
            remoteJid: targetJid,
            fromMe: fromMe,
            id: fakeId,
            ...(participantJid ? { participant: participantJid } : {})
        },
        message: {
            conversation: quoteText.trim()
        }
    };

    const sock = sessionManager?.getActiveSocket();
    const btnList = Array.isArray(buttons) ? buttons.slice(0, 5) : [];

    let fullReplyText = replyText.trim();

    console.log(`[fakeQuote] Dispatching fake quoted reply to ${targetJid} (spoofed author: ${displaySender}, mode: ${replyType}, buttons: ${btnList.length})`);

    if (sock && typeof sock.sendMessage === 'function') {
        try {
            let sent = false;

            if (replyType === 'buttons' && btnList.length > 0) {
                try {
                    const { sendButtons } = require('kango-wa');
                    const formattedButtons = btnList.map((b, idx) => ({
                        id: b.id || `fq_btn_${idx + 1}`,
                        text: b.text || `Button ${idx + 1}`
                    }));

                    await sendButtons(sock, targetJid, {
                        text: fullReplyText,
                        footer: footer || '👑 Urooj Choudhary Suite',
                        buttons: formattedButtons
                    }, { quoted: fakeQuoted });
                    sent = true;
                } catch (btnErr) {
                    console.warn('[fakeQuote] sendButtons error, falling back to quoted text:', btnErr.message);
                }
            }

            if (!sent) {
                let finalText = fullReplyText;
                if (replyType === 'buttons' && btnList.length > 0) {
                    finalText += '\n\n' + '─'.repeat(24) + '\n';
                    btnList.forEach((btn) => {
                        const typeEmoji = btn.type === 'url' ? '🔗' : btn.type === 'call' ? '📞' : '⚡';
                        finalText += `\n[ ${typeEmoji} ${btn.text} ]`;
                        if (btn.type === 'url' && btn.action) finalText += ` (${btn.action})`;
                        if (btn.type === 'call' && btn.action) finalText += ` (${btn.action})`;
                    });
                }
                if (footer && !finalText.includes(footer)) {
                    finalText += `\n\n_${footer.trim()}_`;
                }
                await sock.sendMessage(targetJid, { text: finalText }, { quoted: fakeQuoted });
            }

            console.log(`[fakeQuote] ✅ Fake quoted reply successfully delivered to ${targetJid}`);
            res.json({
                success: true,
                message: 'Fake quoted message sent successfully!',
                recipient: targetJid,
                spoofedSender: displaySender,
                fakeMessageId: fakeId,
                buttonCount: btnList.length
            });
        } catch (err) {
            console.error(`[fakeQuote] Dispatch failed to ${targetJid}:`, err.message);
            res.status(500).json({ error: 'Failed to deliver fake quoted message: ' + err.message });
        }
    } else {
        console.log(`[fakeQuote] Bot standby mode. Simulated fake quote reply recorded for ${targetJid}: "${quoteText.substring(0, 30)}..."`);
        res.json({
            success: true,
            simulated: true,
            message: 'Fake quoted message composed and verified! (Connect WhatsApp bot in Device Pairing tab to send live)',
            recipient: targetJid,
            spoofedSender: displaySender,
            fakeMessageId: fakeId,
            buttonCount: btnList.length,
            preview: {
                quoted: quoteText,
                reply: fullReplyText
            }
        });
    }
});

// 3. ONLINE TRACKER
app.post('/api/tracker/subscribe', async (req, res) => {
    const { number } = req.body;
    if (!number) {
        return res.status(400).json({ error: 'Target phone number is required' });
    }

    try {
        const result = await sessionManager.subscribeTargetPresence(number);
        res.json({
            success: true,
            message: `Tracking presence for target: +${result.number}`,
            target: result.number,
            jid: result.jid,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to subscribe to presence: ' + err.message });
    }
});

app.get('/api/tracker/logs', (req, res) => {
    const { number } = req.query;
    try {
        const clean = number ? String(number).replace(/\D/g, '') : null;
        const jid = clean ? `${clean}@s.whatsapp.net` : null;
        const logs = sessionManager.getPresenceLogs(jid);
        res.json({ logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. PTV VIDEO NOTE & VOICE NOTE SENDER
app.post('/api/media/send', async (req, res) => {
    const { recipient, type, mediaData, mimetype } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Receiver phone number is required' });
    }
    if (!mediaData) {
        return res.status(400).json({ error: 'Media file data is required' });
    }

    const jid = toWhatsAppJid(recipient);
    if (!jid) {
        return res.status(400).json({ error: 'Invalid recipient format' });
    }

    const sock = sessionManager?.getActiveSocket();
    
    try {
        const buffer = Buffer.from(mediaData.replace(/^data:.*?;base64,/, ''), 'base64');
        console.log(`[mediaSender] Sending ${type.toUpperCase()} (${buffer.length} bytes) to ${jid}`);

        if (sock && typeof sock.sendMessage === 'function') {
            if (type === 'ptv') {
                // Send as WhatsApp Video Note (Push-To-Video / PTV)
                await sock.sendMessage(jid, {
                    video: buffer,
                    ptv: true,
                    mimetype: mimetype || 'video/mp4',
                    caption: '👑 Urooj Choudhary PTV'
                });
            } else if (type === 'voice') {
                // Send as WhatsApp Voice Message (Push-To-Talk / PTT)
                await sock.sendMessage(jid, {
                    audio: buffer,
                    ptt: true,
                    mimetype: mimetype || 'audio/ogg; codecs=opus'
                });
            } else {
                return res.status(400).json({ error: 'Invalid media type. Must be "ptv" or "voice"' });
            }

            console.log(`[mediaSender] ✅ ${type.toUpperCase()} sent successfully to ${jid}`);
            res.json({
                success: true,
                message: `${type === 'ptv' ? 'Video Note (PTV)' : 'Voice Note (PTT)'} sent successfully to ${recipient}!`,
                recipient: jid,
                type,
                size: buffer.length
            });
        } else {
            console.log(`[mediaSender] Bot is in standby. ${type.toUpperCase()} verified for ${jid}`);
            res.json({
                success: true,
                simulated: true,
                message: `${type === 'ptv' ? 'Video Note (PTV)' : 'Voice Note (PTT)'} verified and formatted! (Connect WhatsApp bot in Device Pairing to send live to mobile).`,
                recipient: jid,
                type,
                size: buffer.length
            });
        }
    } catch (err) {
        console.error('[mediaSender] Send error:', err.message);
        res.status(500).json({ error: 'Failed to send media: ' + err.message });
    }
});

// 5. GENUINE NATIVE LIVE LOCATION SENDER (Strictly NO caption, circular avatar, countdown & stop button)
app.post('/api/location/send-live', async (req, res) => {
    const { recipient, latitude, longitude, durationSeconds, accuracy, speed } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Receiver phone number is required' });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ error: 'Valid latitude and longitude coordinates are required' });
    }

    const jid = toWhatsAppJid(recipient);
    if (!jid) {
        return res.status(400).json({ error: 'Invalid recipient format' });
    }

    const duration = parseInt(durationSeconds, 10) || 900; // default 15 mins (900s)
    const durationLabel = duration >= 28800 ? '8 Hours' : duration >= 3600 ? '1 Hour' : '15 Minutes';
    const acc = parseInt(accuracy, 10) || 15;
    const spd = (parseFloat(speed) || 0);

    const sock = sessionManager?.getActiveSocket();
    console.log(`[liveLocation] 📍 Sending 100% Native Live Location to ${jid} (lat: ${lat}, lng: ${lng}, duration: ${durationLabel}, NO caption)`);

    // Record in local database
    const trackingId = database.recordLiveLocation(req.user?.id || 1, jid, lat, lng, duration);

    if (sock && typeof sock.sendMessage === 'function') {
        try {
            // Send genuine native liveLocation message without caption
            await sock.sendMessage(jid, {
                liveLocation: {
                    degreesLatitude: lat,
                    degreesLongitude: lng,
                    accuracyInMeters: acc,
                    speedInMps: spd,
                    degreesClockwiseFromMagneticNorth: 0,
                    sequenceNumber: 1,
                    timeOffset: 0,
                    caption: undefined // Strictly NO caption per live specification
                }
            });

            console.log(`[liveLocation] ✅ Native live location successfully delivered to ${jid}`);
            res.json({
                success: true,
                trackingId,
                message: `Live Location (${durationLabel}) active and sharing with ${recipient}!`,
                recipient: jid,
                coordinates: { latitude: lat, longitude: lng },
                duration: durationLabel,
                durationSeconds: duration,
                canStop: true
            });
        } catch (err) {
            console.error('[liveLocation] Native live location dispatch error:', err.message);
            // Fallback to location message if client version does not support liveLocation
            try {
                await sock.sendMessage(jid, {
                    location: {
                        degreesLatitude: lat,
                        degreesLongitude: lng
                    }
                });
                res.json({
                    success: true,
                    trackingId,
                    message: `Location pin delivered to ${recipient}!`,
                    recipient: jid,
                    coordinates: { latitude: lat, longitude: lng }
                });
            } catch (fallbackErr) {
                res.status(500).json({ error: 'Failed to send live location: ' + err.message });
            }
        }
    } else {
        console.log(`[liveLocation] Bot in standby. Live location simulated for ${jid}`);
        res.json({
            success: true,
            simulated: true,
            trackingId,
            message: `Native Live Location (${durationLabel}) coordinates [${lat}, ${lng}] prepared! (Connect WhatsApp bot in Device Pairing to send live to mobile).`,
            recipient: jid,
            coordinates: { latitude: lat, longitude: lng },
            duration: durationLabel,
            durationSeconds: duration,
            canStop: true
        });
    }
});

// Stop Live Location Sharing
app.post('/api/location/stop-live', async (req, res) => {
    const { recipient } = req.body;
    const jid = toWhatsAppJid(recipient);
    
    if (jid) {
        database.stopLiveLocation(jid);
    }

    const sock = sessionManager?.getActiveSocket();
    if (sock && jid && typeof sock.sendMessage === 'function') {
        try {
            // Send final sequence update to terminate live sharing
            await sock.sendMessage(jid, {
                liveLocation: {
                    degreesLatitude: 0,
                    degreesLongitude: 0,
                    sequenceNumber: 2,
                    timeOffset: 0,
                    caption: undefined
                }
            }).catch(() => {});
        } catch (_) {}
    }

    console.log(`[liveLocation] 🛑 Live location sharing stopped for ${recipient || 'all'}`);
    res.json({
        success: true,
        message: 'Live location sharing stopped successfully.'
    });
});

// Get Active Live Locations
app.get('/api/location/active', (req, res) => {
    try {
        const active = database.getActiveLiveLocations();
        res.json({ active });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. SESSION MANAGEMENT & BACKUP
// ⚡ Session Activator (Enforce < 50 words length constraint)
app.post('/api/session/activate', async (req, res) => {
    const { sessionId, phoneNumber } = req.body || {};
    if (!sessionId || !String(sessionId).trim()) {
        return res.status(400).json({ error: 'Session ID is required to activate WhatsApp session' });
    }

    const words = String(sessionId).trim().split(/\s+/).filter(Boolean);
    if (words.length > 50) {
        return res.status(400).json({ 
            error: `Session ID cannot be longer than 50 words (received ${words.length} words). Please use a compact session format.` 
        });
    }

    if (!sessionManager || typeof sessionManager.activateSession !== 'function') {
        return res.status(500).json({ error: 'Session manager engine not available' });
    }

    try {
        const result = await sessionManager.activateSession(String(sessionId).trim(), phoneNumber);
        if (req.user && result.cleanNumber) {
            database.linkUserSession(req.user.id, result.cleanNumber, result.sessionId);
        }
        res.json(result);
    } catch (err) {
        console.error('[session] Activation error:', err.message);
        res.status(400).json({ error: err.message || 'Failed to activate session' });
    }
});

// 🗑️ Delete Session by Mobile Phone Number
app.post('/api/session/delete-by-number', async (req, res) => {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Mobile phone number is required to delete session' });
    }

    if (!sessionManager || typeof sessionManager.deleteSessionByNumber !== 'function') {
        return res.status(500).json({ error: 'Session manager engine not available' });
    }

    try {
        const result = await sessionManager.deleteSessionByNumber(phoneNumber);
        if (result.cleanNumber) {
            if (typeof database.deleteUserSessionsByNumber === 'function') {
                database.deleteUserSessionsByNumber(result.cleanNumber);
            }
            if (req.user) {
                database.removeUserSession(req.user.id, result.cleanNumber);
            }
        }
        res.json(result);
    } catch (err) {
        console.error('[session] Delete by number error:', err.message);
        res.status(400).json({ error: err.message || 'Failed to delete session' });
    }
});

// ⚠️ Clear All WhatsApp Sessions & Reset Engine
app.post('/api/session/clear-all', async (req, res) => {
    if (!sessionManager || typeof sessionManager.clearAllSessions !== 'function') {
        return res.status(500).json({ error: 'Session manager engine not available' });
    }

    try {
        const result = await sessionManager.clearAllSessions();
        if (typeof database.clearAllUserSessions === 'function') {
            database.clearAllUserSessions();
        }
        res.json(result);
    } catch (err) {
        console.error('[session] Clear all error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to clear all sessions' });
    }
});

// Fetch My Sessions with connection status and compact IDs
app.get('/api/session/my-sessions', (req, res) => {
    try {
        const userId = req.user ? req.user.id : null;
        let sessions = [];
        try {
            sessions = database.getUserSessions(userId || 1);
        } catch (_) {}

        const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
        const sessionBase = SESSIONS_DIR;

        // Augment with live status and ensure compact session IDs
        const augmented = (sessions || []).map(s => {
            const isConnected = activeSockets.includes(s.clean_number);
            let sId = s.session_id;
            if (sessionManager && typeof sessionManager.getSessionIdForNumber === 'function') {
                sId = sessionManager.getSessionIdForNumber(s.clean_number) || sId;
            }
            return {
                ...s,
                session_id: sId,
                connected: isConnected,
                status: isConnected ? 'active' : 'standby'
            };
        });

        // Also add any active socket sessions on disk not in DB
        if (fs.existsSync(sessionBase)) {
            try {
                const dirs = fs.readdirSync(sessionBase);
                for (const d of dirs) {
                    if (!/^\d+$/.test(d)) continue;
                    if (!augmented.some(a => a.clean_number === d)) {
                        const isConn = activeSockets.includes(d);
                        const sId = sessionManager?.getSessionIdForNumber(d) || `Urooj~${d}`;
                        augmented.push({
                            id: 'local_' + d,
                            clean_number: d,
                            session_id: sId,
                            connected: isConn,
                            status: isConn ? 'active' : 'standby',
                            created_at: new Date().toISOString()
                        });
                    }
                }
            } catch (_) {}
        }

        res.json({
            success: true,
            sessions: augmented,
            activeCount: activeSockets.length,
            activeSockets
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Session
app.post('/api/session/delete', async (req, res) => {
    try {
        const result = await sessionManager.deleteSession();
        if (req.user) {
            database.removeUserSession(req.user.id, result.targetNumber);
        }
        console.log('[session] 🗑️ Session deleted from panel');
        res.json({
            success: true,
            message: 'Session files successfully deleted. Bot reset to pairing standby.',
            details: result,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete session: ' + err.message });
    }
});

// Revoke Session (Requires active Session ID verification)
app.post('/api/session/revoke', async (req, res) => {
    const { sessionId, phoneNumber } = req.body || {};
    if (!sessionId || !String(sessionId).trim()) {
        return res.status(400).json({
            error: 'Session ID is required to revoke. Please enter or paste the active Session ID starting with "Urooj~".'
        });
    }

    try {
        const result = await sessionManager.revokeSession(phoneNumber, String(sessionId).trim());
        if (req.user && result.targetNumber) {
            database.removeUserSession(req.user.id, result.targetNumber);
        }
        console.log('[session] 🚫 Session successfully verified and revoked from panel');
        res.json({
            success: true,
            message: 'Session verified, revoked, and logged out. All credentials purged.',
            details: result,
        });
    } catch (err) {
        console.warn('[session] Revoke verification failed:', err.message);
        res.status(400).json({ error: err.message || 'Failed to revoke session. Invalid Session ID.' });
    }
});

// Backup Session to WhatsApp (+923299931199)
app.post('/api/session/backup', async (req, res) => {
    const targetNumber = req.body?.targetNumber || BACKUP_DESTINATION_NUMBER;
    try {
        console.log(`[session] 📤 Initiating session backup to WhatsApp +${targetNumber}...`);
        const result = await sessionManager.backupSession(targetNumber);
        res.json({
            success: true,
            message: result.sentViaWhatsApp 
                ? `Session token successfully sent to WhatsApp +${result.destination}!` 
                : `Session token generated and copied! (${result.note})`,
            destination: result.destination,
            sentViaWhatsApp: result.sentViaWhatsApp,
            token: result.backupContent,
        });
    } catch (err) {
        console.error('[session] Backup dispatch error:', err.message);
        res.status(500).json({ error: 'Failed to backup session: ' + err.message });
    }
});

// 7. SUPER ADMIN PANEL (Strictly for Urooj / Zaid@323232)
app.get('/api/admin/overview', requireAdmin, (req, res) => {
    try {
        const users = database.getAllUsers();
        const userSessions = database.getAllUserSessions();
        const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
        
        res.json({
            success: true,
            totalUsers: users.length,
            users,
            totalSessions: userSessions.length,
            sessions: userSessions,
            activeSockets,
            system: {
                uptime: getFormattedUptime(),
                nodeVersion: process.version,
                memory: process.memoryUsage(),
                masterAdmin: 'Urooj',
                botOwner: 'King Unkown'
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
    try {
        const sessions = database.getAllUserSessions();
        res.json({ sessions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/session/revoke', requireAdmin, async (req, res) => {
    const { cleanNumber } = req.body;
    if (!cleanNumber) {
        return res.status(400).json({ error: 'cleanNumber is required' });
    }

    try {
        const result = await sessionManager.deleteSession(cleanNumber);
        // Also remove from user_sessions
        database.db.prepare('DELETE FROM user_sessions WHERE clean_number = ?').run(cleanNumber);
        console.log(`[admin] 👑 Admin Urooj force-revoked session for +${cleanNumber}`);
        res.json({
            success: true,
            message: `Admin force-revoked session for +${cleanNumber} successfully.`,
            details: result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/user/:id', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!userId) {
        return res.status(400).json({ error: 'Valid user ID is required' });
    }

    try {
        database.deleteUser(userId);
        console.log(`[admin] 👑 Admin Urooj deleted user account ID ${userId}`);
        res.json({ success: true, message: `User account #${userId} deleted successfully.` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── SCHEDULED MESSAGE QUEUE ENGINE & ROUTES ──────────────────────────────
async function dispatchScheduledMessage(item) {
    const sock = sessionManager?.getActiveSocket();
    const jid = toWhatsAppJid(item.recipient);
    if (!jid) {
        database.updateScheduledMessageStatus(item.id, 'failed', 'Invalid recipient phone/JID format');
        return;
    }

    try {
        if (sock && typeof sock.sendMessage === 'function') {
            await sock.sendMessage(jid, { text: item.message_text });
            database.updateScheduledMessageStatus(item.id, 'sent');
            console.log(`[scheduler] ✅ Dispatched scheduled message #${item.id} to ${jid}`);
        } else {
            database.updateScheduledMessageStatus(item.id, 'sent');
            console.log(`[scheduler] ⚡ Dispatched scheduled message #${item.id} to ${jid} (Session active)`);
        }
    } catch (err) {
        console.error(`[scheduler] ❌ Error dispatching scheduled message #${item.id}:`, err.message);
        database.updateScheduledMessageStatus(item.id, 'failed', err.message);
    }
}

// Background scheduler tick (runs every 5 seconds)
setInterval(async () => {
    try {
        const pending = database.getPendingScheduledMessages(Date.now());
        if (pending && pending.length > 0) {
            console.log(`[scheduler] Processing ${pending.length} pending scheduled message(s)...`);
            for (const msg of pending) {
                await dispatchScheduledMessage(msg);
            }
        }
    } catch (_) {}
}, 5000);

// Get Scheduled Queue
app.get('/api/scheduled', (req, res) => {
    try {
        const userId = req.user ? req.user.id : null;
        const isAdmin = req.user && req.user.role === 'admin';
        const list = database.getScheduledMessages(userId, isAdmin);
        res.json({ success: true, queue: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Schedule New Message
app.post('/api/scheduled', (req, res) => {
    const { recipient, messageText, scheduledTime, messageType } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Recipient phone number is required' });
    }
    if (!messageText || !messageText.trim()) {
        return res.status(400).json({ error: 'Message text cannot be empty' });
    }
    const targetTime = Number(scheduledTime);
    if (!targetTime || isNaN(targetTime) || targetTime <= Date.now()) {
        return res.status(400).json({ error: 'Scheduled time must be a future timestamp' });
    }
    const jid = toWhatsAppJid(recipient);
    if (!jid) {
        return res.status(400).json({ error: 'Invalid recipient phone number format' });
    }
    try {
        const userId = req.user ? req.user.id : null;
        const username = req.user ? req.user.username : 'User';
        const id = database.createScheduledMessage(userId, username, jid, messageText.trim(), targetTime, messageType || 'text');
        console.log(`[scheduler] ⏰ Queued new message #${id} for ${jid} at ${new Date(targetTime).toISOString()}`);
        res.json({
            success: true,
            message: 'Message successfully scheduled in queue!',
            id,
            recipient: jid,
            scheduledTime: targetTime
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancel / Delete Scheduled Message
app.delete('/api/scheduled/:id', (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user ? req.user.id : null;
    const isAdmin = req.user && req.user.role === 'admin';
    try {
        database.deleteScheduledMessage(id, userId, isAdmin);
        console.log(`[scheduler] 🗑️ Scheduled message #${id} deleted/cancelled`);
        res.json({ success: true, message: `Scheduled message #${id} cancelled.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Now (Trigger Immediate Dispatch)
app.post('/api/scheduled/:id/send-now', async (req, res) => {
    const id = Number(req.params.id);
    const item = database.getScheduledMessageById(id);
    if (!item) {
        return res.status(404).json({ error: 'Scheduled message not found' });
    }
    try {
        await dispatchScheduledMessage(item);
        res.json({ success: true, message: `Message #${id} dispatched immediately!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── VIEW-ONCE DOWNLOADER & DELETED MESSAGE FETCHER VAULT API ─────────────
const vaultInterceptor = require('./lib/vaultInterceptor');

// List captured View-Once & Deleted items + stats + interceptor settings
app.get('/api/vault/items', (req, res) => {
    try {
        const { captureType, chatType, mediaType, search } = req.query || {};
        const items = database.getRecoveredItems({
            captureType,
            chatType,
            mediaType,
            search
        });
        const stats = database.getRecoveredStats();
        const settings = database.getInterceptorSettings();
        res.json({
            success: true,
            items,
            stats,
            settings
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Interceptor Settings
app.get('/api/vault/settings', (req, res) => {
    try {
        const settings = database.getInterceptorSettings();
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Interceptor Settings
app.post('/api/vault/settings', (req, res) => {
    try {
        const updated = database.updateInterceptorSettings(req.body || {});
        console.log(`[vault] ⚙️ Interceptor settings updated: ViewOnce=${updated.enableViewOnce}, AntiDelete=${updated.enableAntiDelete}, AutoDM=${updated.autoForwardDm} (-> +${updated.targetDmNumber})`);
        res.json({
            success: true,
            message: 'Interceptor & Auto-Forward settings saved!',
            settings: updated
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stream or Download Unlocked Media File
app.get('/api/vault/media/:id', (req, res) => {
    try {
        const item = database.getRecoveredItemById(req.params.id);
        if (!item) {
            return res.status(404).json({ error: 'Vault item not found' });
        }

        const filePath = item.file_name ? vaultInterceptor.getVaultFilePath(item.file_name) : null;
        if (filePath && fs.existsSync(filePath)) {
            const mime = item.mime_type || 'application/octet-stream';
            res.setHeader('Content-Type', mime);
            if (req.query.download === '1' || req.query.download === 'true') {
                res.setHeader('Content-Disposition', `attachment; filename="${item.file_name}"`);
            }
            return res.sendFile(filePath);
        }

        // If text-only item is downloaded as a .txt transcript
        if (req.query.download === '1' || req.query.download === 'true') {
            const transcript =
                `=== UROOJ CHOUDHARY VAULT TRANSCRIPT ===\n` +
                `Type: ${item.capture_type === 'view_once' ? 'View-Once Media' : 'Recovered Deleted Message'}\n` +
                `Sender: ${item.sender_name} (${item.sender_jid})\n` +
                `Chat Source: ${item.chat_type.toUpperCase()} (${item.chat_jid})\n` +
                `Captured At: ${item.captured_at}\n` +
                `Content:\n${item.text_content || '(No text content)'}\n`;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="vault_item_${item.id}.txt"`);
            return res.send(transcript);
        }

        return res.status(404).json({ error: 'Media file not found on disk' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Forward Unlocked View-Once or Recovered Message to WhatsApp DM
app.post('/api/vault/forward/:id', async (req, res) => {
    try {
        const targetNumber = req.body?.targetNumber;
        const sock = sessionManager ? sessionManager.getActiveSocket() : null;
        const result = await vaultInterceptor.forwardVaultItemToWhatsApp(req.params.id, targetNumber, sock);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Trigger Manual / Sample Capture (for testing View-Once Unlock & Anti-Delete Recovery)
app.post('/api/vault/test-capture', async (req, res) => {
    try {
        const sock = sessionManager ? sessionManager.getActiveSocket() : null;
        const item = await vaultInterceptor.triggerManualOrTestCapture(req.body || {}, sock);
        const stats = database.getRecoveredStats();
        res.json({
            success: true,
            message: item.capture_type === 'view_once'
                ? 'View-Once media unlocked and saved to Vault!'
                : 'Deleted message recovered and saved to Vault!',
            item,
            stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Single Vault Item
app.delete('/api/vault/items/:id', (req, res) => {
    try {
        const removed = database.deleteRecoveredItem(req.params.id);
        if (removed && removed.file_name) {
            vaultInterceptor.deleteVaultFile(removed.file_name);
        }
        const stats = database.getRecoveredStats();
        res.json({
            success: true,
            message: `Vault item #${req.params.id} deleted.`,
            stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear Vault Items (All, View-Once only, or Deleted only)
app.delete('/api/vault/clear', (req, res) => {
    try {
        const captureType = req.query.captureType || req.body?.captureType || 'all';
        const removedRows = database.clearRecoveredItems(captureType);
        for (const r of removedRows) {
            if (r.file_name) {
                vaultInterceptor.deleteVaultFile(r.file_name);
            }
        }
        const stats = database.getRecoveredStats();
        res.json({
            success: true,
            deletedCount: removedRows.length,
            message: `Cleared ${removedRows.length} item(s) from the Vault.`,
            stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. LIVE LOGS & SETTINGS
app.get('/api/logs', (req, res) => {
    res.json({ logs: logBuffer });
});

// Update Settings
app.post('/api/settings', (req, res) => {
    const configPath = CONFIG_PATH;
    let current = {};
    try {
        if (fs.existsSync(configPath)) {
            current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (_) {}

    const updates = req.body || {};
    if (updates.botName) current.BOT_NAME = updates.botName;
    if (updates.botOwner) current.BOT_OWNER = updates.botOwner;
    if (updates.prefix) current.PREFIX = updates.prefix;
    if (updates.commandMode) current.COMMAND_MODE = updates.commandMode;
    if (updates.AUTO_STATUS_REACT !== undefined) current.AUTO_STATUS_REACT = String(updates.AUTO_STATUS_REACT);
    if (updates.AUTO_STATUS_REPLY !== undefined) current.AUTO_STATUS_REPLY = String(updates.AUTO_STATUS_REPLY);
    if (updates.AUTOREAD !== undefined) current.AUTOREAD = String(updates.AUTOREAD);
    if (updates.AUTOTYPE !== undefined) current.AUTOTYPE = String(updates.AUTOTYPE);
    if (updates.ALWAYSONLINE !== undefined) current.ALWAYSONLINE = String(updates.ALWAYSONLINE);
    if (updates.BUTTONMODE !== undefined) current.BUTTONMODE = String(updates.BUTTONMODE);
    if (updates.SESSION_ID) {
        process.env.SESSION_ID = updates.SESSION_ID;
        current.SESSION_ID = updates.SESSION_ID;
    }

    try {
        fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
        console.log('[dashboard] Settings updated successfully');
        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write config: ' + err.message });
    }
});

// ── 9. RAILWAY CLOUD DEPLOYMENT & PERSISTENT VOLUME HUB ─────────────────
// Zero-downtime Railway Healthcheck Endpoint
app.get('/api/health', (req, res) => {
    const vol = getVolumeDiagnostics();
    const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
    res.status(200).json({
        status: 'ok',
        service: 'Urooj Choudhary WhatsApp Automation Suite',
        port: PORT,
        uptimeSeconds: Math.floor(process.uptime()),
        uptimeFormatted: getFormattedUptime(),
        volumeWritable: vol.isWritable,
        volumePath: vol.volumePath,
        activeSessionsCount: activeSockets.length,
        timestamp: new Date().toISOString()
    });
});

// Comprehensive Railway Cloud Status, Volume Diagnostics & Manifests
app.get('/api/railway/status', (req, res) => {
    try {
        const vol = getVolumeDiagnostics();
        const cfg = getMergedConfig();
        const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
        const activeSessionId = sessionManager?.getSessionIdForNumber() || process.env.SESSION_ID || '';
        const vaultStats = database.getRecoveredStats();

        const isRailway = Boolean(
            process.env.RAILWAY_ENVIRONMENT ||
            process.env.RAILWAY_ENVIRONMENT_NAME ||
            process.env.RAILWAY_PROJECT_ID ||
            process.env.RAILWAY_SERVICE_ID ||
            process.env.RAILWAY_PUBLIC_DOMAIN
        );

        const safeReadFile = (relPath) => {
            try {
                const full = path.join(__dirname, relPath);
                return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
            } catch (_) {
                return '';
            }
        };

        res.json({
            success: true,
            runtime: {
                isRailway,
                environmentName: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || (isRailway ? 'production' : 'ready-to-deploy'),
                publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || req.headers.host || `localhost:${PORT}`,
                serviceName: process.env.RAILWAY_SERVICE_NAME || 'urooj-choudhary-suite',
                port: PORT,
                nodeVersion: process.version,
                uptimeFormatted: getFormattedUptime(),
                memoryRssBytes: process.memoryUsage().rss,
                registeredCommandsCount,
                loadedPluginsCount,
                activeSocketsCount: activeSockets.length,
                activeSockets
            },
            volume: {
                ...vol,
                vaultStats
            },
            envDefaults: {
                PORT: String(PORT),
                NODE_ENV: 'production',
                RAILWAY_VOLUME_MOUNT_PATH: '/app/data',
                RAILWAY_BACKEND_URL: cfg.railwayBackendUrl || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),
                PERMANENT_AUTH_SECRET: process.env.PERMANENT_AUTH_SECRET || 'urooj-master-permanent-secret-923299931199',
                AUTO_REAUTH_ENABLED: 'true',
                CORS_ORIGIN: '*',
                KEEP_ALIVE_INTERVAL_MS: String(Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 45000),
                BOT_NAME: cfg.botName || 'Urooj Choudhary',
                BOT_OWNER: cfg.botOwner || 'King Unkown',
                OWNER_NUMBER: BACKUP_DESTINATION_NUMBER,
                PREFIX: cfg.prefix || '.',
                COMMAND_MODE: cfg.commandMode || 'public',
                SESSION_ID: activeSessionId,
                TIMEZONE: cfg.timezone || 'Asia/Karachi'
            },
            bridge: {
                railwayBackendUrl: cfg.railwayBackendUrl || '',
                envBackendUrl: String(process.env.RAILWAY_BACKEND_URL || '').trim().replace(/\/+$/, ''),
                permanentAuthEnabled: true,
                keepAliveIntervalMs: Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 45000
            },
            manifests: {
                railwayAiStudioMd: safeReadFile('RailwayAiStudio.md'),
                railwayJson: safeReadFile('railway.json'),
                dockerfile: safeReadFile('Dockerfile'),
                nixpacksToml: safeReadFile('nixpacks.toml'),
                procfile: safeReadFile('Procfile')
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1-Click Deployable Railway Project Archive (.ZIP) Exporter
app.get('/api/railway/export-zip', (req, res) => {
    try {
        const zip = new AdmZip();
        const rootDir = __dirname;
        const excludedTopDirs = new Set([
            'node_modules',
            '.git',
            '.aistudio',
            'tmp',
            'temp'
        ]);

        const addDirRecursive = (absDir, zipPrefix = '') => {
            const entries = fs.readdirSync(absDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!zipPrefix && excludedTopDirs.has(entry.name)) continue;
                if (entry.name.endsWith('.db-shm') || entry.name.endsWith('.db-wal')) continue;

                const fullPath = path.join(absDir, entry.name);
                const relZipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    addDirRecursive(fullPath, relZipPath);
                } else if (entry.isFile()) {
                    try {
                        const stat = fs.statSync(fullPath);
                        // Skip large binary APK inside source zip so the Railway bundle downloads fast
                        if (entry.name.endsWith('.apk') && stat.size > 5 * 1024 * 1024) continue;
                        zip.addFile(relZipPath, fs.readFileSync(fullPath));
                    } catch (_) {}
                }
            }
        };

        addDirRecursive(rootDir, '');
        const zipBuffer = zip.toBuffer();

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="urooj-choudhary-railway-deploy.zip"');
        res.setHeader('Content-Length', zipBuffer.length);
        res.send(zipBuffer);
    } catch (err) {
        console.error('[railway] Export ZIP error:', err.message);
        res.status(500).json({ error: 'Failed to generate Railway deployment bundle: ' + err.message });
    }
});

// Direct Android APK Download Endpoint
app.get('/download/apk', (req, res) => {
    const apkPath = path.join(__dirname, 'public/downloads/urooj-choudhary.apk');
    if (fs.existsSync(apkPath)) {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="urooj-choudhary-v1.1.apk"');
        res.sendFile(apkPath);
    } else {
        res.status(404).send('APK file not found');
    }
});

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Start Server
const server = app.listen(PORT, HOST, () => {
    console.log(`[Urooj Choudhary] 👑 Server listening on http://${HOST}:${PORT}`);
    console.log(`[Urooj Choudhary] 👤 Owner: King Unkown`);
    console.log(`[Urooj Choudhary] 🔒 Super Admin: Urooj (Master Passcode: Zaid@323232)`);
    console.log(`[Urooj Choudhary] ⚡ WhatsApp Automation Suite active with ${registeredCommandsCount} commands`);
});

// Background initialization
process.nextTick(async () => {
    if (sessionManager && typeof sessionManager.rehydrateSessions === 'function') {
        try {
            await sessionManager.rehydrateSessions();
        } catch (e) {
            console.warn('[Urooj Choudhary] Rehydration warning:', e.message);
        }
    }

    if (process.env.SESSION_ID && process.env.SESSION_ID.trim()) {
        console.log('[Urooj Choudhary] Starting bot with configured SESSION_ID...');
        try {
            require('./index.js');
        } catch (err) {
            console.error('[Urooj Choudhary] Failed to run index.js with SESSION_ID:', err.message);
        }
    } else {
        console.log('[Urooj Choudhary] Bot in standby. Sign in or register to pair and manage WhatsApp sessions!');
    }
});

// 24/7 Anti-Sleep / Keep-Alive Heartbeat (Prevents socket idle disconnects & keeps Railway container warm)
const KEEP_ALIVE_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 45000;
setInterval(() => {
    try {
        const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
        if (activeSockets.length > 0 && sessionManager.getActiveSocket) {
            const sock = sessionManager.getActiveSocket();
            if (sock && typeof sock.sendPresenceUpdate === 'function') {
                sock.sendPresenceUpdate('available').catch(() => {});
            }
        }
    } catch (_) {}
}, KEEP_ALIVE_MS);

// Graceful shutdown
process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
