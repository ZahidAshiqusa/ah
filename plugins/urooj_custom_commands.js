'use strict';

/**
 * Urooj Choudhary Custom WhatsApp Commands
 * Owner: Urooj Choudhary (+254141693915)
 *
 * Implements:
 * 1. .button/msg/buttonlimit/button1/button2 (+targetNumber)
 * 2. .ptv +923number (send replied video as circular video note)
 * 3. .voice +923number (send replied audio/video as voice note PTT)
 * 4. .😍 (unlock View-Once media and send exclusively to Owner DM +254141693915)
 * 5. .qouted msg1/replied +number (send fake-quoted reply to target number)
 * 6. .online +9232number (subscribe & trace real-time online presence history)
 */

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { bot } = require('../lib/pluginLoader');
const settings = require('../settings');
const database = require('../lib/database');
const { VAULT_DIR } = require('../lib/storagePaths');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const OWNER_CLEAN_NUMBER = '254141693915';
const OWNER_JID = `${OWNER_CLEAN_NUMBER}@s.whatsapp.net`;
const OWNER_NAME = 'Urooj Choudhary';

// Deduplication set so pre-processor and plugin loader never double-fire on the same message ID
const processedCommandIds = new Set();
function markProcessed(msgId) {
    if (!msgId) return false;
    if (processedCommandIds.has(msgId)) return true;
    processedCommandIds.add(msgId);
    if (processedCommandIds.size > 500) {
        const first = processedCommandIds.values().next().value;
        processedCommandIds.delete(first);
    }
    return false;
}

// Helper: Normalize phone number string into clean digits and WhatsApp JID
function parsePhoneNumber(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0') && digits.length === 11) {
        digits = '92' + digits.slice(1);
    }
    if (digits.length < 7 || digits.length > 16) return null;
    return {
        clean: digits,
        jid: `${digits}@s.whatsapp.net`
    };
}

// Helper: Extract raw text from a Baileys message object
function extractRawText(message) {
    if (!message || !message.message) return '';
    let m = message.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    ).trim();
}

// Helper: Extract contextInfo & quotedMessage from a Baileys message
function getQuotedContext(message) {
    if (!message || !message.message) return { quotedMessage: null, contextInfo: null };
    let m = message.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;

    const contextInfo =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        m.stickerMessage?.contextInfo ||
        null;

    return {
        contextInfo,
        quotedMessage: contextInfo?.quotedMessage || null,
        quotedParticipant: contextInfo?.participant || contextInfo?.remoteJid || null,
        stanzaId: contextInfo?.stanzaId || null
    };
}

// Helper: Download media stream into a Buffer
async function downloadBuffer(mediaNode, type) {
    const stream = await downloadContentFromMessage(mediaNode, type);
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. .button/msg/buttonlimit/button1/button2 (+number)
// ─────────────────────────────────────────────────────────────────────────────
async function executeButtonCommand(sock, chatId, message, rawInput) {
    // Strip leading .button
    let body = String(rawInput || '').replace(/^[.!#/]?\s*button\b/i, '').trim();
    if (body.startsWith('/')) body = body.slice(1).trim();

    if (!body) {
        await sock.sendMessage(chatId, {
            text:
                `🔘 *${OWNER_NAME} Button Command*\n\n` +
                `*Usage 1:*\n` +
                `\`.button/Your Message/2/Button 1/Button 2 +923001234567\`\n\n` +
                `*Usage 2:*\n` +
                `\`.button/+923001234567/Your Message/2/Button 1/Button 2\`\n\n` +
                `👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    // Check if there is a trailing or leading phone number separated by space (e.g. ".button/msg/2/btn1/btn2 +923001234567")
    let targetPhone = null;

    // Split by '/' first
    const slashParts = body.split('/').map(s => s.trim()).filter(Boolean);

    // Check if the first slash segment is a phone number: .button/+923001234567/msg/2/btn1/btn2
    if (slashParts.length >= 3) {
        const firstCandidate = parsePhoneNumber(slashParts[0]);
        if (firstCandidate && /^[+\d\s-]+$/.test(slashParts[0])) {
            targetPhone = firstCandidate;
            slashParts.shift();
        }
    }

    // Check if the last slash segment is a phone number or ends with " +923..."
    if (!targetPhone && slashParts.length >= 2) {
        const lastPart = slashParts[slashParts.length - 1];
        // Check if lastPart itself is purely a phone number: .button/msg/2/btn1/btn2/+923001234567
        if (/^[+]?\d[\d\s-]{6,15}$/.test(lastPart)) {
            targetPhone = parsePhoneNumber(lastPart);
            if (targetPhone) slashParts.pop();
        } else {
            // Check if lastPart has a trailing phone number after space: "btn2 +923001234567"
            const trailingMatch = lastPart.match(/^(.*?)\s+([+]?\d[\d\s-]{6,15})$/);
            if (trailingMatch) {
                const parsed = parsePhoneNumber(trailingMatch[2]);
                if (parsed) {
                    targetPhone = parsed;
                    slashParts[slashParts.length - 1] = trailingMatch[1].trim();
                }
            }
        }
    }

    if (!targetPhone) {
        await sock.sendMessage(chatId, {
            text:
                `❌ *Target Phone Number Required!*\n\n` +
                `Please include the target number with country code:\n` +
                `• \`.button/Hello/2/Yes/No +923001234567\`\n` +
                `• \`.button/+923001234567/Hello/2/Yes/No\`\n\n` +
                `👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    const msgText = slashParts[0] || 'Hello!';
    const parsedLimit = parseInt(slashParts[1], 10);
    const buttonLimit = !isNaN(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 5) : 2;
    const rawButtonLabels = slashParts.slice(2).filter(Boolean);

    if (rawButtonLabels.length === 0) {
        rawButtonLabels.push('Option 1', 'Option 2');
    }

    const finalLabels = rawButtonLabels.slice(0, buttonLimit);
    const formattedButtons = finalLabels.map((label, idx) => ({
        id: `urooj_btn_${idx + 1}`,
        text: label
    }));

    const footerText = `👑 ${OWNER_NAME}`;
    let sentInteractive = false;

    if (sendButtons) {
        try {
            await sendButtons(sock, targetPhone.jid, {
                text: msgText,
                footer: footerText,
                buttons: formattedButtons
            });
            sentInteractive = true;
        } catch (err) {
            console.warn('[.button] sendButtons fallback:', err.message);
        }
    }

    if (!sentInteractive) {
        const buttonLines = formattedButtons.map((b, i) => `┣ 🔘 *[${i + 1}]* ${b.text}`).join('\n');
        const fallbackText =
            `${msgText}\n\n` +
            `┏━━━━━━━━━━━━━━━━━━━┓\n` +
            `${buttonLines}\n` +
            `┗━━━━━━━━━━━━━━━━━━━┛\n` +
            `_${footerText}_`;
        await sock.sendMessage(targetPhone.jid, { text: fallbackText });
    }

    await sock.sendMessage(chatId, {
        text:
            `✅ *Button Message Sent!*\n\n` +
            `📱 *To:* +${targetPhone.clean}\n` +
            `📝 *Message:* ${msgText}\n` +
            `🔢 *Button Limit:* ${buttonLimit} (${formattedButtons.map(b => b.text).join(', ')})\n\n` +
            `👑 _${OWNER_NAME}_`
    }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. .ptv +923number (Send video in circle / Video Note)
// ─────────────────────────────────────────────────────────────────────────────
async function executePtvCommand(sock, chatId, message, rawInput) {
    const argStr = String(rawInput || '').replace(/^[.!#/]?\s*ptv\b/i, '').replace(/^\//, '').trim();
    const targetPhone = parsePhoneNumber(argStr);

    if (!targetPhone) {
        await sock.sendMessage(chatId, {
            text:
                `🎥 *${OWNER_NAME} Circular Video (PTV)*\n\n` +
                `*Usage:* Reply to any video with:\n` +
                `\`.ptv +923001234567\`\n\n` +
                `👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    // Locate video node in current message or quoted message
    let m = message.message || {};
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    const { quotedMessage } = getQuotedContext(message);

    let videoNode = m.videoMessage || null;
    if (!videoNode && quotedMessage) {
        let q = quotedMessage;
        if (q.ephemeralMessage?.message) q = q.ephemeralMessage.message;
        if (q.viewOnceMessage?.message) q = q.viewOnceMessage.message;
        if (q.viewOnceMessageV2?.message) q = q.viewOnceMessageV2.message;
        if (q.viewOnceMessageV2Extension?.message) q = q.viewOnceMessageV2Extension.message;
        videoNode = q.videoMessage || null;
    }

    if (!videoNode) {
        await sock.sendMessage(chatId, {
            text: `❌ *Please reply to a video message* with \`.ptv +${targetPhone.clean}\` to send it in a circle!\n\n👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });
    const buffer = await downloadBuffer(videoNode, 'video');

    await sock.sendMessage(targetPhone.jid, {
        video: buffer,
        ptv: true,
        mimetype: videoNode.mimetype || 'video/mp4'
    });

    await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
    await sock.sendMessage(chatId, {
        text:
            `✅ *Circular Video Note (PTV) Sent!*\n\n` +
            `📱 *Recipient:* +${targetPhone.clean}\n` +
            `👑 _${OWNER_NAME}_`
    }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. .voice +923number (Send audio/video as playable Voice Note PTT)
// ─────────────────────────────────────────────────────────────────────────────
async function executeVoiceCommand(sock, chatId, message, rawInput) {
    const argStr = String(rawInput || '').replace(/^[.!#/]?\s*voice\b/i, '').replace(/^\//, '').trim();
    const targetPhone = parsePhoneNumber(argStr);

    if (!targetPhone) {
        await sock.sendMessage(chatId, {
            text:
                `🎙️ *${OWNER_NAME} Voice Note Sender*\n\n` +
                `*Usage:* Reply to any audio, voice note, or video with:\n` +
                `\`.voice +923001234567\`\n\n` +
                `👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    let m = message.message || {};
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    const { quotedMessage } = getQuotedContext(message);

    let mediaNode = m.audioMessage || m.videoMessage || null;
    let mediaType = m.audioMessage ? 'audio' : m.videoMessage ? 'video' : null;

    if (!mediaNode && quotedMessage) {
        let q = quotedMessage;
        if (q.ephemeralMessage?.message) q = q.ephemeralMessage.message;
        if (q.viewOnceMessage?.message) q = q.viewOnceMessage.message;
        if (q.viewOnceMessageV2?.message) q = q.viewOnceMessageV2.message;
        if (q.viewOnceMessageV2Extension?.message) q = q.viewOnceMessageV2Extension.message;

        if (q.audioMessage) {
            mediaNode = q.audioMessage;
            mediaType = 'audio';
        } else if (q.videoMessage) {
            mediaNode = q.videoMessage;
            mediaType = 'video';
        }
    }

    if (!mediaNode || !mediaType) {
        await sock.sendMessage(chatId, {
            text: `❌ *Please reply to an audio or video message* with \`.voice +${targetPhone.clean}\`!\n\n👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    await sock.sendMessage(chatId, { react: { text: '🎙️', key: message.key } });
    const buffer = await downloadBuffer(mediaNode, mediaType);

    await sock.sendMessage(targetPhone.jid, {
        audio: buffer,
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus'
    });

    await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
    await sock.sendMessage(chatId, {
        text:
            `✅ *Voice Note (PTT) Sent!*\n\n` +
            `📱 *Recipient:* +${targetPhone.clean}\n` +
            `👑 _${OWNER_NAME}_`
    }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. .😍 (Unlock View-Once file and send exclusively to Owner DM +254141693915)
// ─────────────────────────────────────────────────────────────────────────────
async function executeViewOnceEmojiCommand(sock, chatId, message) {
    const { quotedMessage, quotedParticipant, stanzaId } = getQuotedContext(message);

    if (!quotedMessage) {
        await sock.sendMessage(chatId, {
            text: `❌ *Please reply to a View-Once photo, video, or voice note with \`.😍\`* to unlock it to Owner DM (+${OWNER_CLEAN_NUMBER}).\n\n👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    let q = quotedMessage;
    if (q.ephemeralMessage?.message) q = q.ephemeralMessage.message;
    if (q.viewOnceMessage?.message) q = q.viewOnceMessage.message;
    else if (q.viewOnceMessageV2?.message) q = q.viewOnceMessageV2.message;
    else if (q.viewOnceMessageV2Extension?.message) q = q.viewOnceMessageV2Extension.message;

    let mediaNode = null;
    let mediaType = null;
    let ext = 'bin';
    let mime = 'application/octet-stream';
    let originalCaption = '';

    if (q.imageMessage) {
        mediaNode = q.imageMessage;
        mediaType = 'image';
        mime = q.imageMessage.mimetype || 'image/jpeg';
        ext = 'jpg';
        originalCaption = q.imageMessage.caption || '';
    } else if (q.videoMessage) {
        mediaNode = q.videoMessage;
        mediaType = 'video';
        mime = q.videoMessage.mimetype || 'video/mp4';
        ext = 'mp4';
        originalCaption = q.videoMessage.caption || '';
    } else if (q.audioMessage) {
        mediaNode = q.audioMessage;
        mediaType = 'audio';
        mime = q.audioMessage.mimetype || 'audio/ogg; codecs=opus';
        ext = 'ogg';
        originalCaption = 'View-Once Voice/Audio';
    }

    if (!mediaNode || !mediaType) {
        await sock.sendMessage(chatId, {
            text: `❌ The replied message does not contain View-Once image, video, or audio media.\n\n👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    await sock.sendMessage(chatId, { react: { text: '😍', key: message.key } });
    const buffer = await downloadBuffer(mediaNode, mediaType);

    // Save to persistent Vault as well
    const senderClean = String(quotedParticipant || chatId).replace(/@.*$/, '').replace(/:\d+$/, '');
    try {
        const fileName = `vo_emoji_${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(VAULT_DIR, fileName), buffer);
        database.insertRecoveredItem({
            messageId: stanzaId || `EMOJI_${Date.now()}`,
            sessionNumber: sock._sessionNumber || OWNER_CLEAN_NUMBER,
            captureType: 'view_once',
            chatJid: chatId,
            chatType: chatId.endsWith('@g.us') ? 'group' : 'private',
            chatName: chatId.endsWith('@g.us') ? `Group ${chatId.split('@')[0]}` : `+${senderClean}`,
            senderJid: quotedParticipant || chatId,
            senderName: `+${senderClean}`,
            mediaType,
            textContent: originalCaption || 'Unlocked via .😍 command',
            fileName,
            mimeType: mime,
            fileSize: buffer.length,
            forwardedToDm: true,
            originalTimestamp: Date.now()
        });
    } catch (_) {}

    const caption =
        `🔓 *VIEW-ONCE MEDIA UNLOCKED (.😍)*\n\n` +
        `👤 *Sender:* +${senderClean}\n` +
        `💬 *Chat:* ${chatId.endsWith('@g.us') ? 'Group Chat' : 'Private Chat'}\n` +
        (originalCaption ? `📝 *Caption:* ${originalCaption}\n` : '') +
        `\n👑 *${OWNER_NAME}* (+${OWNER_CLEAN_NUMBER})`;

    // Deliver strictly to Owner DM (+254141693915)
    if (mediaType === 'image') {
        await sock.sendMessage(OWNER_JID, { image: buffer, caption });
    } else if (mediaType === 'video') {
        await sock.sendMessage(OWNER_JID, { video: buffer, caption });
    } else if (mediaType === 'audio') {
        await sock.sendMessage(OWNER_JID, {
            audio: buffer,
            mimetype: mime,
            ptt: Boolean(mediaNode.ptt)
        });
        await sock.sendMessage(OWNER_JID, { text: caption });
    }

    await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. .qouted msg1/replied +number (Send fake-quoted reply to target number)
// ─────────────────────────────────────────────────────────────────────────────
async function executeQuotedCommand(sock, chatId, message, rawInput) {
    let body = String(rawInput || '').replace(/^[.!#/]?\s*(?:qouted|quoted)\b/i, '').trim();
    if (body.startsWith('/')) body = body.slice(1).trim();

    if (!body || !body.includes('/')) {
        await sock.sendMessage(chatId, {
            text:
                `💬 *${OWNER_NAME} Fake Quoted Reply (.qouted)*\n\n` +
                `*Usage 1:*\n` +
                `\`.qouted msg1/replied +923001234567\`\n\n` +
                `*Usage 2:*\n` +
                `\`.qouted/+923001234567/msg1/replied\`\n\n` +
                `👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    const parts = body.split('/').map(s => s.trim()).filter(Boolean);
    let targetPhone = null;

    // Check if first segment is target number: .qouted/+923001234567/msg1/replied
    if (parts.length >= 3 && /^[+]?\d[\d\s-]{6,15}$/.test(parts[0])) {
        targetPhone = parsePhoneNumber(parts[0]);
        if (targetPhone) parts.shift();
    }

    // Check if third segment is target number: .qouted/msg1/replied/+923001234567
    if (!targetPhone && parts.length >= 3 && /^[+]?\d[\d\s-]{6,15}$/.test(parts[parts.length - 1])) {
        targetPhone = parsePhoneNumber(parts[parts.length - 1]);
        if (targetPhone) parts.pop();
    }

    // Check if last segment ends with a phone number after space: .qouted msg1/replied +923001234567
    if (!targetPhone && parts.length >= 2) {
        const last = parts[parts.length - 1];
        const match = last.match(/^(.*?)\s+([+]?\d[\d\s-]{6,15})$/);
        if (match) {
            const parsed = parsePhoneNumber(match[2]);
            if (parsed) {
                targetPhone = parsed;
                parts[parts.length - 1] = match[1].trim();
            }
        }
    }

    if (!targetPhone || parts.length < 2) {
        await sock.sendMessage(chatId, {
            text:
                `❌ *Target Phone Number & Message Pair Required!*\n\n` +
                `Format:\n` +
                `• \`.qouted Hello how are you/I am fine +923001234567\`\n` +
                `• \`.qouted/+923001234567/Hello how are you/I am fine\`\n\n` +
                `👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    const msg1 = parts[0];
    const replied = parts.slice(1).join(' / ');
    const fakeId = '3EB0' + Math.random().toString(36).substring(2, 12).toUpperCase();

    const fakeQuoted = {
        key: {
            remoteJid: targetPhone.jid,
            fromMe: false,
            id: fakeId,
            participant: targetPhone.jid
        },
        message: {
            conversation: msg1
        }
    };

    await sock.sendMessage(targetPhone.jid, { text: replied }, { quoted: fakeQuoted });

    await sock.sendMessage(chatId, {
        text:
            `✅ *Quoted Reply Sent!*\n\n` +
            `📱 *To:* +${targetPhone.clean}\n` +
            `💭 *Quoted (msg1):* "${msg1}"\n` +
            `↩️ *Replied:* "${replied}"\n\n` +
            `👑 _${OWNER_NAME}_`
    }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. .online +9232number (Trace online presence & history)
// ─────────────────────────────────────────────────────────────────────────────
async function executeOnlineCommand(sock, chatId, message, rawInput) {
    const argStr = String(rawInput || '').replace(/^[.!#/]?\s*online\b/i, '').replace(/^\//, '').trim();
    const targetPhone = parsePhoneNumber(argStr);

    if (!targetPhone) {
        await sock.sendMessage(chatId, {
            text:
                `🟢 *${OWNER_NAME} Online History Tracker*\n\n` +
                `*Usage:*\n` +
                `\`.online +923201234567\`\n\n` +
                `Subscribes to real-time WhatsApp presence updates and displays the number's online/offline timeline.\n\n` +
                `👑 _${OWNER_NAME}_`
        }, { quoted: message });
        return;
    }

    const sessionManager = require('../lib/sessionManager');

    // Ensure presence listener is attached to this socket and subscribe to targetJid
    try {
        if (sock && typeof sock.presenceSubscribe === 'function') {
            await sock.presenceSubscribe(targetPhone.jid);
        }
        if (sock && sock.ev && !sock._presenceHookAttached) {
            sock._presenceHookAttached = true;
            sock.ev.on('presence.update', (update) => {
                const { id, presences } = update || {};
                if (!presences) return;
                for (const [participant, presenceData] of Object.entries(presences)) {
                    const st = presenceData?.lastKnownPresence || 'available';
                    sessionManager.logPresenceEvent(participant || id, st);
                }
            });
        }
    } catch (_) {}

    await sessionManager.subscribeTargetPresence(targetPhone.clean);

    // Wait briefly so any immediate presence packet from WhatsApp arrives
    await new Promise(r => setTimeout(r, 1200));

    const logs = sessionManager.getPresenceLogs(targetPhone.jid) || [];
    const statusLabels = {
        available: '🟢 ONLINE (Available)',
        composing: '✍️ ONLINE (Typing...)',
        recording: '🎙️ ONLINE (Recording Audio...)',
        unavailable: '⚫ OFFLINE (Unavailable)',
        subscribed: '📡 Subscribed (Monitoring Active)'
    };

    const latestReal = logs.find(l => l.status !== 'subscribed') || logs[0];
    const currentStatusText = latestReal
        ? (statusLabels[latestReal.status] || latestReal.status.toUpperCase())
        : '📡 Monitoring Started (Waiting for target activity)';

    let historyLines = '';
    const displayLogs = logs.slice(0, 12);
    if (displayLogs.length === 0) {
        historyLines = `• No prior events logged yet — real-time tracker is now active for +${targetPhone.clean}.`;
    } else {
        historyLines = displayLogs
            .map((entry, idx) => {
                const badge = statusLabels[entry.status] || entry.status;
                return `${idx + 1}. [${entry.time}] ${badge}`;
            })
            .join('\n');
    }

    const report =
        `📡 *ONLINE PRESENCE TRACKER*\n\n` +
        `📱 *Target Number:* +${targetPhone.clean}\n` +
        `⚡ *Current State:* ${currentStatusText}\n` +
        `🕒 *Checked At:* ${new Date().toLocaleTimeString()}\n\n` +
        `📜 *Online History Log:*\n` +
        `${historyLines}\n\n` +
        `_Run \`.online +${targetPhone.clean}\` anytime to view updated online timestamps._\n` +
        `👑 *${OWNER_NAME}* (+${OWNER_CLEAN_NUMBER})`;

    await sock.sendMessage(chatId, { text: report }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct Socket Pre-Processor (Handles slash-syntax & emoji commands reliably)
// ─────────────────────────────────────────────────────────────────────────────
async function handleCustomCommandMessage(sock, chatUpdate) {
    const messages = chatUpdate?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return false;

    for (const message of messages) {
        if (!message || !message.key || !message.message) continue;
        const chatId = message.key.remoteJid;
        if (!chatId || chatId === 'status@broadcast') continue;

        const rawText = extractRawText(message);
        if (!rawText) continue;

        const trimmed = rawText.trim();

        // Check if it matches any of the 6 custom commands:
        // 1. .button/... or .button ...
        // 2. .ptv ...
        // 3. .voice ...
        // 4. .😍 or 😍 (when replying to View-Once)
        // 5. .qouted ... or .quoted ...
        // 6. .online ...
        const isButtonCmd = /^[.!#/]button(?:\/|\s|$)/i.test(trimmed);
        const isPtvCmd = /^[.!#/]ptv(?:\/|\s|$)/i.test(trimmed);
        const isVoiceCmd = /^[.!#/]voice(?:\/|\s|$)/i.test(trimmed);
        const isEmojiVvCmd = /^[.!#/]?😍$/.test(trimmed) && (trimmed.startsWith('.') || Boolean(getQuotedContext(message).quotedMessage));
        const isQuotedCmd = /^[.!#/](?:qouted|quoted)(?:\/|\s|$)/i.test(trimmed);
        const isOnlineCmd = /^[.!#/]online(?:\/|\s|$)/i.test(trimmed);

        if (!isButtonCmd && !isPtvCmd && !isVoiceCmd && !isEmojiVvCmd && !isQuotedCmd && !isOnlineCmd) {
            continue;
        }

        if (markProcessed(message.key.id)) {
            return true;
        }

        try {
            if (isButtonCmd) {
                await executeButtonCommand(sock, chatId, message, trimmed);
            } else if (isPtvCmd) {
                await executePtvCommand(sock, chatId, message, trimmed);
            } else if (isVoiceCmd) {
                await executeVoiceCommand(sock, chatId, message, trimmed);
            } else if (isEmojiVvCmd) {
                await executeViewOnceEmojiCommand(sock, chatId, message);
            } else if (isQuotedCmd) {
                await executeQuotedCommand(sock, chatId, message, trimmed);
            } else if (isOnlineCmd) {
                await executeOnlineCommand(sock, chatId, message, trimmed);
            }
        } catch (err) {
            console.error('[uroojCustomCommands] Execution error:', err.message);
            await sock.sendMessage(chatId, {
                text: `❌ Command error: ${err.message}\n👑 _${OWNER_NAME}_`
            }, { quoted: message });
        }
        return true;
    }

    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Register in Plugin Loader so commands appear in .menu / .help & Web Dashboard
// ─────────────────────────────────────────────────────────────────────────────
bot({
    command: ['button'],
    menuCommands: ['button/msg/buttonlimit/button1/button2'],
    description: 'Send interactive button message to target number (.button/msg/buttonlimit/button1/button2 +number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.button ${args.join(' ')}`;
    await executeButtonCommand(sock, chatId, message, raw);
});

bot({
    command: ['ptv'],
    menuCommands: ['ptv'],
    description: 'Send replied video in a circle (Video Note) to +number (.ptv +923number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.ptv ${args.join(' ')}`;
    await executePtvCommand(sock, chatId, message, raw);
});

bot({
    command: ['voice'],
    menuCommands: ['voice'],
    description: 'Send replied audio/video as a Voice Note (PTT) to +number (.voice +923number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.voice ${args.join(' ')}`;
    await executeVoiceCommand(sock, chatId, message, raw);
});

bot({
    command: ['😍', 'vvdm'],
    menuCommands: ['😍'],
    description: 'Unlock replied View-Once file directly to Owner DM (+254141693915)',
    category: 'owner'
}, async (sock, chatId, message) => {
    if (markProcessed(message?.key?.id)) return;
    await executeViewOnceEmojiCommand(sock, chatId, message);
});

bot({
    command: ['qouted', 'quoted'],
    menuCommands: ['qouted'],
    description: 'Send fake quoted message reply to target number (.qouted msg1/replied +number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.qouted ${args.join(' ')}`;
    await executeQuotedCommand(sock, chatId, message, raw);
});

bot({
    command: ['online'],
    menuCommands: ['online'],
    description: 'Trace real-time online presence & history of a number (.online +9232number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.online ${args.join(' ')}`;
    await executeOnlineCommand(sock, chatId, message, raw);
});

module.exports = {
    handleCustomCommandMessage,
    executeButtonCommand,
    executePtvCommand,
    executeVoiceCommand,
    executeViewOnceEmojiCommand,
    executeQuotedCommand,
    executeOnlineCommand
};
