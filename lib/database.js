'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'urooj_suite.db');
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
`);

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

function loginUser(username, password) {
    const cleanUser = String(username || '').trim();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUser);
    if (!user) {
        throw new Error('User not found');
    }

    if (!verifyPassword(String(password), user.password_hash, user.salt)) {
        throw new Error('Invalid password');
    }

    // 30 days session token
    const token = 'urooj_tok_' + crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    db.prepare(`
        INSERT INTO user_tokens (user_id, token, expires_at, created_at)
        VALUES (?, ?, ?, ?)
    `).run(user.id, token, expiresAt, new Date().toISOString());

    return {
        token,
        expiresAt,
        user: {
            id: user.id,
            username: user.username,
            role: user.role,
            createdAt: user.created_at
        }
    };
}

function validateToken(token) {
    if (!token) return null;
    const cleanToken = String(token).replace(/^Bearer\s+/i, '').trim();
    const row = db.prepare(`
        SELECT t.id AS token_id, t.expires_at, u.id AS user_id, u.username, u.role, u.created_at
        FROM user_tokens t
        JOIN users u ON t.user_id = u.id
        WHERE t.token = ?
    `).get(cleanToken);

    if (!row) return null;
    if (row.expires_at < Date.now()) {
        // Expired
        db.prepare('DELETE FROM user_tokens WHERE token = ?').run(cleanToken);
        return null;
    }

    return {
        id: row.user_id,
        username: row.username,
        role: row.role,
        createdAt: row.created_at
    };
}

function logoutToken(token) {
    if (!token) return;
    const cleanToken = String(token).replace(/^Bearer\s+/i, '').trim();
    db.prepare('DELETE FROM user_tokens WHERE token = ?').run(cleanToken);
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
    const stmt = db.prepare(`
        INSERT INTO user_sessions (user_id, clean_number, session_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, clean_number) DO UPDATE SET
            session_id = excluded.session_id,
            created_at = excluded.created_at
    `);
    stmt.run(userId, clean, sessionId || null, new Date().toISOString());
}

function getUserSessions(userId) {
    return db.prepare('SELECT * FROM user_sessions WHERE user_id = ? ORDER BY id DESC').all(userId);
}

function removeUserSession(userId, cleanNumber) {
    const clean = String(cleanNumber).replace(/\D/g, '');
    db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND clean_number = ?').run(userId, clean);
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

module.exports = {
    db,
    registerUser,
    loginUser,
    validateToken,
    logoutToken,
    getUserById,
    linkUserSession,
    getUserSessions,
    removeUserSession,
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
    deleteScheduledMessage
};
