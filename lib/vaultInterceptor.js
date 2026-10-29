'use strict';

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const database = require('./database');

const { VAULT_DIR } = require('./storagePaths');

// Rolling cache of recent messages per session or global message ID
// Key: messageId -> { msg, cleanNumber, chatJid, chatType, senderJid, senderName, mediaType, textContent, mediaNode, baileyType, mimeType, timestamp }
const incomingMessageCache = new Map();
const MAX_CACHE_ENTRIES = 600;
const processedRevokeIds = new Set();
const processedViewOnceIds = new Set();

function rememberMessage(entry) {
    if (!entry || !entry.messageId) return;
    incomingMessageCache.set(entry.messageId, entry);
    if (incomingMessageCache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = incomingMessageCache.keys().next().value;
        incomingMessageCache.delete(oldestKey);
    }
}

function getExtensionFromMime(mimeType, fallbackType) {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('pdf')) return 'pdf';
    if (fallbackType === 'image') return 'jpg';
    if (fallbackType === 'video') return 'mp4';
    if (fallbackType === 'audio') return 'ogg';
    return 'bin';
}

async function downloadMediaBuffer(mediaNode, baileyType) {
    if (!mediaNode || !baileyType) return null;
    try {
        const stream = await downloadContentFromMessage(mediaNode, baileyType);
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    } catch (err) {
        console.warn(`[vault] downloadContentFromMessage (${baileyType}) warning:`, err.message);
        return null;
    }
}

function extractMessageDetails(msg) {
    if (!msg || !msg.message) return null;

    let m = msg.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    // 1. Check for Protocol Revoke (Delete for Everyone)
    if (m.protocolMessage) {
        const pType = m.protocolMessage.type;
        const isRevoke = pType === 0 || pType === 'REVOKE' || m.protocolMessage.key?.id;
        if (isRevoke && m.protocolMessage.key?.id) {
            return {
                isRevoke: true,
                targetMessageId: m.protocolMessage.key.id,
                targetRemoteJid: m.protocolMessage.key.remoteJid || msg.key?.remoteJid
            };
        }
    }

    // 2. Check for View-Once wrapper or flag
    let isViewOnce = false;
    let content = m;

    if (m.viewOnceMessage?.message) {
        isViewOnce = true;
        content = m.viewOnceMessage.message;
    } else if (m.viewOnceMessageV2?.message) {
        isViewOnce = true;
        content = m.viewOnceMessageV2.message;
    } else if (m.viewOnceMessageV2Extension?.message) {
        isViewOnce = true;
        content = m.viewOnceMessageV2Extension.message;
    }

    if (
        content.imageMessage?.viewOnce ||
        content.videoMessage?.viewOnce ||
        content.audioMessage?.viewOnce
    ) {
        isViewOnce = true;
    }

    // Determine media or text payload
    let mediaType = 'text';
    let baileyType = null;
    let mediaNode = null;
    let mimeType = null;
    let textContent = '';

    if (content.imageMessage) {
        mediaType = 'image';
        baileyType = 'image';
        mediaNode = content.imageMessage;
        mimeType = content.imageMessage.mimetype || 'image/jpeg';
        textContent = content.imageMessage.caption || '';
    } else if (content.videoMessage) {
        mediaType = 'video';
        baileyType = 'video';
        mediaNode = content.videoMessage;
        mimeType = content.videoMessage.mimetype || 'video/mp4';
        textContent = content.videoMessage.caption || '';
    } else if (content.audioMessage) {
        mediaType = 'audio';
        baileyType = 'audio';
        mediaNode = content.audioMessage;
        mimeType = content.audioMessage.mimetype || 'audio/ogg; codecs=opus';
        textContent = content.audioMessage.ptt ? 'Voice Note (PTT)' : 'Audio Recording';
    } else if (content.documentMessage) {
        mediaType = 'document';
        baileyType = 'document';
        mediaNode = content.documentMessage;
        mimeType = content.documentMessage.mimetype || 'application/octet-stream';
        textContent = content.documentMessage.caption || content.documentMessage.fileName || 'Document Attachment';
    } else if (content.stickerMessage) {
        mediaType = 'image';
        baileyType = 'sticker';
        mediaNode = content.stickerMessage;
        mimeType = content.stickerMessage.mimetype || 'image/webp';
        textContent = 'Sticker';
    } else if (typeof content.conversation === 'string' && content.conversation) {
        mediaType = 'text';
        textContent = content.conversation;
    } else if (content.extendedTextMessage?.text) {
        mediaType = 'text';
        textContent = content.extendedTextMessage.text;
    } else {
        return null;
    }

    return {
        isRevoke: false,
        isViewOnce,
        mediaType,
        baileyType,
        mediaNode,
        mimeType,
        textContent
    };
}

function formatCleanJid(jid) {
    if (!jid) return 'Unknown';
    return String(jid)
        .replace('@s.whatsapp.net', '')
        .replace('@g.us', '')
        .replace(/:\d+/, '');
}

async function autoForwardItemToDm(sock, savedItem, buffer = null) {
    if (!sock || typeof sock.sendMessage !== 'function') return false;
    const settings = database.getInterceptorSettings();
    let targetNumber = String(settings.targetDmNumber || '254141693915').replace(/\D/g, '');
    if (!targetNumber && sock.user?.id) {
        targetNumber = formatCleanJid(sock.user.id);
    }
    if (!targetNumber) targetNumber = '254141693915';

    const targetJid = `${targetNumber}@s.whatsapp.net`;
    const isViewOnce = savedItem.capture_type === 'view_once';
    const headerTitle = isViewOnce
        ? '🔓 *VIEW-ONCE MEDIA UNLOCKED*'
        : '🗑️ *DELETED MESSAGE RECOVERED*';

    const senderPhone = formatCleanJid(savedItem.sender_jid);
    const chatLabel = savedItem.chat_type === 'group'
        ? `Group (${formatCleanJid(savedItem.chat_jid)})`
        : `Private DM (+${senderPhone})`;

    const timeStr = new Date(savedItem.original_timestamp || Date.now()).toLocaleTimeString();

    const metaCaption =
        `${headerTitle}\n\n` +
        `👤 *Sender:* ${savedItem.sender_name || '+' + senderPhone} (+${senderPhone})\n` +
        `💬 *Source:* ${chatLabel}\n` +
        `🕒 *Timestamp:* ${timeStr}\n` +
        (savedItem.text_content ? `📝 *Message/Caption:* ${savedItem.text_content}\n` : '') +
        `\n👑 _Urooj Choudhary Interceptor Vault_`;

    try {
        if (buffer && savedItem.media_type === 'image') {
            await sock.sendMessage(targetJid, {
                image: buffer,
                caption: metaCaption
            });
        } else if (buffer && savedItem.media_type === 'video') {
            await sock.sendMessage(targetJid, {
                video: buffer,
                caption: metaCaption
            });
        } else if (buffer && savedItem.media_type === 'audio') {
            await sock.sendMessage(targetJid, {
                audio: buffer,
                mimetype: savedItem.mime_type || 'audio/ogg; codecs=opus',
                ptt: false
            });
            await sock.sendMessage(targetJid, { text: metaCaption });
        } else if (buffer && savedItem.media_type === 'document') {
            await sock.sendMessage(targetJid, {
                document: buffer,
                mimetype: savedItem.mime_type || 'application/octet-stream',
                fileName: savedItem.file_name || 'recovered_attachment.bin',
                caption: metaCaption
            });
        } else {
            await sock.sendMessage(targetJid, { text: metaCaption });
        }

        database.markItemForwarded(savedItem.id);
        console.log(`[vault] 📤 Auto-forwarded ${savedItem.capture_type} #${savedItem.id} to WhatsApp DM +${targetNumber}`);
        return true;
    } catch (err) {
        console.warn(`[vault] Auto-forward to +${targetNumber} failed:`, err.message);
        return false;
    }
}

async function handleViewOnceCapture(sock, cleanNumber, entry) {
    if (!entry || !entry.messageId) return null;
    if (processedViewOnceIds.has(entry.messageId)) return null;
    processedViewOnceIds.add(entry.messageId);

    const settings = database.getInterceptorSettings();
    if (!settings.enableViewOnce) return null;

    let buffer = entry.cachedBuffer || null;
    if (!buffer && entry.mediaNode && entry.baileyType) {
        buffer = await downloadMediaBuffer(entry.mediaNode, entry.baileyType);
    }

    let fileName = null;
    let fileSize = 0;
    if (buffer && buffer.length > 0) {
        const ext = getExtensionFromMime(entry.mimeType, entry.mediaType);
        fileName = `vo_${Date.now()}_${entry.messageId.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}.${ext}`;
        const filePath = path.join(VAULT_DIR, fileName);
        fs.writeFileSync(filePath, buffer);
        fileSize = buffer.length;
    }

    const saved = database.insertRecoveredItem({
        messageId: entry.messageId,
        sessionNumber: cleanNumber,
        captureType: 'view_once',
        chatJid: entry.chatJid,
        chatType: entry.chatType,
        chatName: entry.chatName,
        senderJid: entry.senderJid,
        senderName: entry.senderName,
        mediaType: entry.mediaType,
        textContent: entry.textContent || 'View-Once Media Unlocked',
        fileName,
        mimeType: entry.mimeType,
        fileSize,
        forwardedToDm: false,
        originalTimestamp: entry.timestamp
    });

    console.log(`[vault] 🔓 Captured View-Once ${entry.mediaType} from ${entry.senderName} (${entry.chatType})`);

    if (settings.autoForwardDm && saved) {
        await autoForwardItemToDm(sock, saved, buffer);
    }

    return saved;
}

async function handleDeletedMessageCapture(sock, cleanNumber, targetMessageId) {
    if (!targetMessageId) return null;
    if (processedRevokeIds.has(targetMessageId)) return null;

    const cached = incomingMessageCache.get(targetMessageId);
    if (!cached) return null;

    processedRevokeIds.add(targetMessageId);

    const settings = database.getInterceptorSettings();
    if (!settings.enableAntiDelete) return null;

    let buffer = cached.cachedBuffer || null;
    if (!buffer && cached.mediaNode && cached.baileyType) {
        buffer = await downloadMediaBuffer(cached.mediaNode, cached.baileyType);
    }

    let fileName = null;
    let fileSize = 0;
    if (buffer && buffer.length > 0) {
        const ext = getExtensionFromMime(cached.mimeType, cached.mediaType);
        fileName = `del_${Date.now()}_${targetMessageId.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}.${ext}`;
        const filePath = path.join(VAULT_DIR, fileName);
        fs.writeFileSync(filePath, buffer);
        fileSize = buffer.length;
    }

    const saved = database.insertRecoveredItem({
        messageId: targetMessageId,
        sessionNumber: cleanNumber || cached.cleanNumber,
        captureType: 'deleted',
        chatJid: cached.chatJid,
        chatType: cached.chatType,
        chatName: cached.chatName,
        senderJid: cached.senderJid,
        senderName: cached.senderName,
        mediaType: cached.mediaType,
        textContent: cached.textContent || '(Media attachment deleted by sender)',
        fileName,
        mimeType: cached.mimeType,
        fileSize,
        forwardedToDm: false,
        originalTimestamp: cached.timestamp
    });

    console.log(`[vault] 🗑️ Recovered deleted ${cached.mediaType} message from ${cached.senderName} (${cached.chatType})`);

    if (settings.autoForwardDm && saved) {
        await autoForwardItemToDm(sock, saved, buffer);
    }

    return saved;
}

function attachVaultInterceptor(sock, cleanNumber) {
    if (!sock || !sock.ev || sock._vaultInterceptorAttached) return;
    sock._vaultInterceptorAttached = true;

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const messages = chatUpdate?.messages || [];
            for (const msg of messages) {
                if (!msg || !msg.key) continue;
                const remoteJid = msg.key.remoteJid || '';
                if (!remoteJid || remoteJid === 'status@broadcast') continue;

                const details = extractMessageDetails(msg);
                if (!details) continue;

                // If this is a protocol revoke event ("Delete for Everyone")
                if (details.isRevoke && details.targetMessageId) {
                    await handleDeletedMessageCapture(sock, cleanNumber, details.targetMessageId);
                    continue;
                }

                const messageId = msg.key.id;
                const isGroup = remoteJid.endsWith('@g.us');
                const chatType = isGroup ? 'group' : 'private';
                const senderJid = isGroup
                    ? (msg.key.participant || msg.participant || remoteJid)
                    : (msg.key.fromMe ? (sock.user?.id || `${cleanNumber}@s.whatsapp.net`) : remoteJid);
                const senderName = msg.pushName || (msg.key.fromMe ? 'Me' : `+${formatCleanJid(senderJid)}`);
                const msgTimestamp = msg.messageTimestamp
                    ? (Number(msg.messageTimestamp) < 1e12 ? Number(msg.messageTimestamp) * 1000 : Number(msg.messageTimestamp))
                    : Date.now();

                const cacheEntry = {
                    messageId,
                    cleanNumber,
                    chatJid: remoteJid,
                    chatType,
                    chatName: isGroup ? `Group ${formatCleanJid(remoteJid)}` : senderName,
                    senderJid,
                    senderName,
                    isViewOnce: details.isViewOnce,
                    mediaType: details.mediaType,
                    baileyType: details.baileyType,
                    mediaNode: details.mediaNode,
                    mimeType: details.mimeType,
                    textContent: details.textContent,
                    cachedBuffer: null,
                    timestamp: msgTimestamp
                };

                // Pre-cache small/medium media buffers so if the sender deletes the media later, we still have the raw bytes
                if (details.mediaNode && details.baileyType && !details.isViewOnce) {
                    const fileLen = Number(details.mediaNode.fileLength || 0);
                    if (fileLen <= 15 * 1024 * 1024) {
                        downloadMediaBuffer(details.mediaNode, details.baileyType)
                            .then((buf) => {
                                if (buf) cacheEntry.cachedBuffer = buf;
                            })
                            .catch(() => {});
                    }
                }

                rememberMessage(cacheEntry);

                // If View-Once message, immediately unlock & capture
                if (details.isViewOnce) {
                    await handleViewOnceCapture(sock, cleanNumber, cacheEntry);
                }
            }
        } catch (err) {
            console.error(`[vault] messages.upsert interceptor error:`, err.message);
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        try {
            if (!Array.isArray(updates)) return;
            for (const item of updates) {
                const key = item?.key;
                const update = item?.update;
                if (!key?.id || !update) continue;

                const isRevoked =
                    update.messageStubType === 1 ||
                    update.message === null ||
                    update.message?.protocolMessage?.type === 0 ||
                    update.message?.protocolMessage?.type === 'REVOKE';

                if (isRevoked) {
                    await handleDeletedMessageCapture(sock, cleanNumber, key.id);
                }
            }
        } catch (err) {
            console.error(`[vault] messages.update interceptor error:`, err.message);
        }
    });
}

// Forward an existing Vault Item to any WhatsApp number on demand
async function forwardVaultItemToWhatsApp(id, targetRecipient, sock) {
    const item = database.getRecoveredItemById(id);
    if (!item) {
        throw new Error('Vault item not found');
    }

    const settings = database.getInterceptorSettings();
    let cleanTarget = String(targetRecipient || settings.targetDmNumber || '254141693915').replace(/\D/g, '');
    if (cleanTarget.startsWith('00')) cleanTarget = cleanTarget.substring(2);
    if (cleanTarget.startsWith('0') && cleanTarget.length === 11) {
        cleanTarget = '92' + cleanTarget.substring(1);
    }
    if (!cleanTarget || cleanTarget.length < 7) {
        throw new Error('Please provide a valid target WhatsApp number');
    }

    let buffer = null;
    if (item.file_name) {
        const filePath = path.join(VAULT_DIR, item.file_name);
        if (fs.existsSync(filePath)) {
            buffer = fs.readFileSync(filePath);
        }
    }

    const targetJid = `${cleanTarget}@s.whatsapp.net`;
    const isViewOnce = item.capture_type === 'view_once';
    const headerTitle = isViewOnce
        ? '🔓 *VIEW-ONCE MEDIA UNLOCKED*'
        : '🗑️ *DELETED MESSAGE RECOVERED*';
    const senderPhone = formatCleanJid(item.sender_jid);
    const chatLabel = item.chat_type === 'group'
        ? `Group (${formatCleanJid(item.chat_jid)})`
        : `Private DM (+${senderPhone})`;
    const timeStr = new Date(item.original_timestamp || Date.now()).toLocaleString();

    const caption =
        `${headerTitle}\n\n` +
        `👤 *Sender:* ${item.sender_name || '+' + senderPhone}\n` +
        `💬 *Source:* ${chatLabel}\n` +
        `🕒 *Original Time:* ${timeStr}\n` +
        (item.text_content ? `📝 *Content:* ${item.text_content}\n` : '') +
        `\n👑 _Urooj Choudhary Interceptor Vault_`;

    if (sock && typeof sock.sendMessage === 'function') {
        if (buffer && item.media_type === 'image') {
            if (item.mime_type === 'image/svg+xml') {
                await sock.sendMessage(targetJid, { text: caption });
            } else {
                await sock.sendMessage(targetJid, { image: buffer, caption });
            }
        } else if (buffer && item.media_type === 'video') {
            await sock.sendMessage(targetJid, { video: buffer, caption });
        } else if (buffer && item.media_type === 'audio') {
            await sock.sendMessage(targetJid, {
                audio: buffer,
                mimetype: item.mime_type || 'audio/ogg; codecs=opus',
                ptt: false
            });
            await sock.sendMessage(targetJid, { text: caption });
        } else {
            await sock.sendMessage(targetJid, { text: caption });
        }
        database.markItemForwarded(item.id);
        return {
            success: true,
            sentViaWhatsApp: true,
            destination: cleanTarget,
            message: `Successfully forwarded item #${item.id} to WhatsApp +${cleanTarget}!`
        };
    } else {
        database.markItemForwarded(item.id);
        return {
            success: true,
            sentViaWhatsApp: false,
            destination: cleanTarget,
            message: `Marked for dispatch to +${cleanTarget} (Connect WhatsApp session for live delivery).`
        };
    }
}

// Generate a valid SVG preview image on disk so sample/test View-Once captures have downloadable files
function generateVaultGraphicSvg(title, subtitle, accentHex = '#f59e0b') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#020617"/>
      <stop offset="50%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="800" height="500" fill="url(#bg)"/>
  <circle cx="680" cy="110" r="160" fill="${accentHex}" fill-opacity="0.08"/>
  <circle cx="120" cy="400" r="180" fill="#10b981" fill-opacity="0.07"/>
  <rect x="50" y="50" width="700" height="400" rx="24" fill="#090d16" fill-opacity="0.75" stroke="${accentHex}" stroke-opacity="0.35" stroke-width="2"/>
  <text x="90" y="130" fill="${accentHex}" font-family="monospace" font-size="18" font-weight="bold">UROOJ CHOUDHARY INTERCEPTOR VAULT</text>
  <text x="90" y="210" fill="#f8fafc" font-family="sans-serif" font-size="34" font-weight="bold">${title}</text>
  <text x="90" y="265" fill="#94a3b8" font-family="sans-serif" font-size="20">${subtitle}</text>
  <rect x="90" y="330" width="280" height="46" rx="10" fill="${accentHex}" fill-opacity="0.15" stroke="${accentHex}" stroke-opacity="0.4"/>
  <text x="112" y="359" fill="#fde68a" font-family="monospace" font-size="15" font-weight="bold">100% DECRYPTED &amp; UNLOCKED</text>
  <text x="90" y="418" fill="#64748b" font-family="monospace" font-size="14">Captured at ${new Date().toISOString()}</text>
</svg>`;
}

// Manual Unlock from Cache OR Simulated Test Capture
async function triggerManualOrTestCapture(options = {}, sock = null) {
    const captureType = options.captureType || 'view_once';
    const chatType = options.chatType || 'private';
    const mediaType = options.mediaType || (captureType === 'view_once' ? 'image' : 'text');
    const customSender = String(options.senderNumber || '254141693915').replace(/\D/g, '') || '254141693915';

    // First check if there is a real uncaptured message in incomingMessageCache matching customSender
    if (options.fromCacheOnly) {
        for (const [msgId, entry] of incomingMessageCache.entries()) {
            if (entry.senderJid.includes(customSender) || entry.messageId === options.messageId) {
                if (captureType === 'view_once') {
                    return await handleViewOnceCapture(sock, entry.cleanNumber, entry);
                } else {
                    return await handleDeletedMessageCapture(sock, entry.cleanNumber, msgId);
                }
            }
        }
    }

    let fileName = null;
    let mimeType = 'text/plain';
    let fileSize = 0;
    let buffer = null;

    if (mediaType === 'image') {
        const svgContent = generateVaultGraphicSvg(
            captureType === 'view_once' ? 'Unlocked View-Once Photo' : 'Recovered Deleted Photo',
            `Sender: +${customSender} • Source: ${chatType.toUpperCase()}`,
            captureType === 'view_once' ? '#f59e0b' : '#f43f5e'
        );
        buffer = Buffer.from(svgContent, 'utf8');
        fileName = `${captureType === 'view_once' ? 'vo' : 'del'}_${Date.now()}.svg`;
        mimeType = 'image/svg+xml';
        fs.writeFileSync(path.join(VAULT_DIR, fileName), buffer);
        fileSize = buffer.length;
    }

    const defaultText = captureType === 'view_once'
        ? (options.textContent || 'Confidential View-Once photo unlocked before expiration.')
        : (options.textContent || 'Hey, here is the private access code: 8492-UROOJ — deleting this message in 5 seconds!');

    const saved = database.insertRecoveredItem({
        messageId: 'VLT_' + Date.now().toString(36).toUpperCase(),
        sessionNumber: customSender,
        captureType,
        chatJid: chatType === 'group' ? '12036304928192@g.us' : `${customSender}@s.whatsapp.net`,
        chatType,
        chatName: chatType === 'group' ? 'VIP Automation Group' : `Contact +${customSender}`,
        senderJid: `${customSender}@s.whatsapp.net`,
        senderName: options.senderName || `Contact +${customSender}`,
        mediaType,
        textContent: defaultText,
        fileName,
        mimeType,
        fileSize,
        forwardedToDm: false,
        originalTimestamp: Date.now()
    });

    const settings = database.getInterceptorSettings();
    if (settings.autoForwardDm && sock) {
        await autoForwardItemToDm(sock, saved, null);
    }

    return saved;
}

function getVaultFilePath(fileName) {
    if (!fileName) return null;
    const safeName = path.basename(fileName);
    const fullPath = path.join(VAULT_DIR, safeName);
    return fs.existsSync(fullPath) ? fullPath : null;
}

function deleteVaultFile(fileName) {
    const fullPath = getVaultFilePath(fileName);
    if (fullPath) {
        try {
            fs.rmSync(fullPath, { force: true });
        } catch (_) {}
    }
}

module.exports = {
    VAULT_DIR,
    attachVaultInterceptor,
    forwardVaultItemToWhatsApp,
    triggerManualOrTestCapture,
    getVaultFilePath,
    deleteVaultFile
};
