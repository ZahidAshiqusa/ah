// Urooj Choudhary Owner Command
const settings = require('../settings');
const { bot } = require('../lib/pluginLoader');

bot({
  command: ['owner'],
  description: 'Get owner information',
  category: 'general',
}, async (sock, chatId) => {
  await sock.sendMessage(chatId, {
    text: '*👑 Urooj Choudhary Owner*\n\n👤 *Name:* Urooj Choudhary\n📞 *Number:* +' + (settings.ownerNumber || '254141693915'),
  });
});
