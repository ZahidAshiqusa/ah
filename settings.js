// Urooj Choudhary - Settings
// All values are read from environment variables.
// Copy .env.example to .env and fill in your details,
// OR set them as environment variables on your hosting platform.

require('dotenv').config({ override: true });

const settings = {
  // ── Bot Identity ─────────────────────────────────────────────────────────
  botName:     process.env.BOT_NAME     || 'Urooj Choudhary',
  botOwner:    process.env.BOT_OWNER    || 'Urooj Choudhary',
  ownerName:   process.env.BOT_OWNER    || 'Urooj Choudhary',
  packname:    process.env.PACK_NAME    || 'Urooj Choudhary',
  author:      process.env.PACK_AUTHOR  || 'Urooj Choudhary',
  description: 'Urooj Choudhary WhatsApp Automation Suite & Bot Management Platform.',
  version:     '1.0.0',

  // ── Owner & Session ──────────────────────────────────────────────────────
  // ownerNumber: your WhatsApp number with country code, no + or spaces
  ownerNumber: (process.env.OWNER_NUMBER || '254141693915').replace(/[^0-9]/g, '') || '254141693915',

  // ── Behaviour ────────────────────────────────────────────────────────────
  prefix:      process.env.PREFIX       || '.',
  timezone:    process.env.TIMEZONE     || 'Asia/Karachi',
  commandMode: process.env.COMMAND_MODE || 'public',   // 'public' or 'private'

  // ── Auto Features ────────────────────────────────────────────────────────
  AUTO_STATUS_REACT:  process.env.AUTO_STATUS_REACT  || 'false',
  AUTO_STATUS_REPLY:  process.env.AUTO_STATUS_REPLY  || 'false',
  AUTO_STATUS_MSG:    process.env.AUTO_STATUS_MSG     || 'Status Viewed by Urooj Choudhary',
  AUTOREAD:           process.env.AUTOREAD            || 'false',
  AUTOTYPE:           process.env.AUTOTYPE            || 'false',
  AUTORECORD:         process.env.AUTORECORD          || 'false',
  AUTORECORDTYPE:     process.env.AUTORECORDTYPE      || 'false',

  // ── API Keys ─────────────────────────────────────────────────────────────
  giphyApiKey: process.env.GIPHY_API_KEY || '',
};

module.exports = settings;
