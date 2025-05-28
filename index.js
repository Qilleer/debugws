const TelegramBot = require('node-telegram-bot-api');
const { 
  createWhatsAppConnection, 
  generatePairingCode, 
  logoutWhatsApp,
  toggleAutoAccept,
  getAutoAcceptStatus 
} = require('./whatsappClient');
const config = require('./config');

// Bot instance & user states
const bot = new TelegramBot(config.telegram.token, { polling: true });
const userStates = {};

// Check if owner
function isOwner(userId) {
  return config.telegram.owners.includes(userId.toString());
}

// Handle /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isOwner(userId)) {
    await bot.sendMessage(chatId, '❌ Lu bukan owner bot ini bro!');
    return;
  }
  
  await showMainMenu(chatId);
});

// Handle callbacks
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  
  if (!isOwner(userId)) {
    await bot.answerCallbackQuery(query.id, { 
      text: '❌ Lu bukan owner!', 
      show_alert: true 
    });
    return;
  }
  
  switch(data) {
    case 'login':
      await handleLogin(chatId, userId);
      break;
      
    case 'cancel_login':
      await handleCancelLogin(chatId, userId);
      break;
      
    case 'auto_accept':
      await handleAutoAccept(chatId, userId, query.message.message_id);
      break;
      
    case 'toggle_auto_accept':
      await handleToggleAutoAccept(chatId, userId, query.message.message_id);
      break;
      
    case 'status':
      await handleStatus(chatId, userId);
      break;
      
    case 'logout':
      await handleLogout(chatId, userId);
      break;
      
    case 'main_menu':
      await showMainMenu(chatId, query.message.message_id);
      break;
  }
  
  await bot.answerCallbackQuery(query.id);
});

// Handle login
async function handleLogin(chatId, userId) {
  if (!userStates[userId]) {
    userStates[userId] = {};
  }
  
  userStates[userId].waitingForPhone = true;
  
  await bot.sendMessage(chatId, '📱 Kirim nomor WA lu (dengan kode negara, tanpa +):\n\nContoh: 628123456789', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Batal', callback_data: 'cancel_login' }]
      ]
    }
  });
}

// Handle cancel login
async function handleCancelLogin(chatId, userId) {
  // Reset waiting status
  if (userStates[userId]) {
    userStates[userId].waitingForPhone = false;
    
    // Close WhatsApp connection if exists
    if (userStates[userId].whatsapp?.socket) {
      await logoutWhatsApp(userId);
    }
  }
  
  await bot.sendMessage(chatId, '✅ Login dibatalkan!');
  await showMainMenu(chatId);
}

// Handle phone number input
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  if (!text || text.startsWith('/')) return;
  if (!isOwner(userId)) return;
  
  if (userStates[userId]?.waitingForPhone) {
    userStates[userId].waitingForPhone = false;
    
    // Delete user's message for privacy
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    
    // Validate phone number
    const phoneNumber = text.trim();
    if (!/^\d{10,15}$/.test(phoneNumber)) {
      await bot.sendMessage(chatId, '❌ Format nomor salah! Harus 10-15 digit angka saja.');
      return;
    }
    
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Tunggu bentar, lagi bikin koneksi...');
    
    try {
      // Create connection
      const sock = await createWhatsAppConnection(userId, bot);
      if (!sock) throw new Error('Gagal bikin koneksi');
      
      // Wait 3 seconds for stable connection
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Generate pairing code
      await generatePairingCode(userId, phoneNumber, bot, loadingMsg.message_id);
    } catch (err) {
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Coba Lagi', callback_data: 'login' }],
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
    }
  }
});

// Handle auto accept settings
async function handleAutoAccept(chatId, userId, messageId) {
  const status = getAutoAcceptStatus(userId);
  
  await bot.editMessageText(
    `🤖 *Auto Accept Settings*\n\nStatus: ${status.enabled ? '✅ AKTIF' : '❌ NONAKTIF'}\n\nKalo aktif, bot bakal otomatis approve semua yang mau join grup.`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: status.enabled ? '❌ Matikan' : '✅ Aktifkan', callback_data: 'toggle_auto_accept' }],
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

// Handle toggle auto accept
async function handleToggleAutoAccept(chatId, userId, messageId) {
  const currentStatus = getAutoAcceptStatus(userId);
  const newStatus = !currentStatus.enabled;
  
  const result = await toggleAutoAccept(userId, newStatus);
  
  if (result.success) {
    await handleAutoAccept(chatId, userId, messageId);
  } else {
    await bot.sendMessage(chatId, '❌ Gagal ubah setting. Coba lagi!');
  }
}

// Handle status
async function handleStatus(chatId, userId) {
  const isConnected = userStates[userId]?.whatsapp?.isConnected || false;
  const autoAcceptStatus = getAutoAcceptStatus(userId);
  
  let message = '*📊 Status Bot*\n\n';
  message += `WhatsApp: ${isConnected ? '✅ Connected' : '❌ Disconnected'}\n`;
  message += `Auto Accept: ${autoAcceptStatus.enabled ? '✅ ON' : '❌ OFF'}\n`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
      ]
    }
  });
}

// Handle logout
async function handleLogout(chatId, userId) {
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Sedang logout...');
  
  const success = await logoutWhatsApp(userId);
  
  await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
  
  if (success) {
    await bot.sendMessage(chatId, '✅ Logout berhasil! Session dihapus.');
  } else {
    await bot.sendMessage(chatId, '❌ Error waktu logout.');
  }
  
  await showMainMenu(chatId);
}

// Show main menu
async function showMainMenu(chatId, messageId = null) {
  const menuText = '👋 *Welcome to Auto Accept Bot!*\n\nPilih menu:';
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔑 Login WhatsApp', callback_data: 'login' }],
      [{ text: '🤖 Auto Accept Settings', callback_data: 'auto_accept' }],
      [{ text: '🔄 Status', callback_data: 'status' }],
      [{ text: '🚪 Logout', callback_data: 'logout' }]
    ]
  };
  
  if (messageId) {
    await bot.editMessageText(menuText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } else {
    await bot.sendMessage(chatId, menuText, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }
}

// Export userStates for whatsappClient
module.exports = { userStates };

console.log('✅ Bot started! Send /start to begin.');