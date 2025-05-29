const TelegramBot = require('node-telegram-bot-api');
const { 
  createWhatsAppConnection, 
  generatePairingCode, 
  logoutWhatsApp,
  toggleAutoAccept,
  getAutoAcceptStatus,
  restoreAllSessions,
  getAllGroups,
  renameGroup
} = require('./whatsappClient');
const config = require('./config');

// Bot instance & user states
const bot = new TelegramBot(config.telegram.token, { polling: true });
const userStates = {};

// Check if owner
function isOwner(userId) {
  return config.telegram.owners.includes(userId.toString());
}

// Initialize bot - restore sessions on startup
async function initializeBot() {
  console.log('🔄 Restoring existing sessions...');
  
  try {
    const restoredSessions = await restoreAllSessions(bot);
    
    if (restoredSessions.length > 0) {
      console.log(`✅ Restored ${restoredSessions.length} sessions:`, restoredSessions);
      
      // Notify owners about restored sessions
      for (const ownerId of config.telegram.owners) {
        try {
          await bot.sendMessage(
            ownerId, 
            `🚀 *Bot Started!*\n\n✅ Restored ${restoredSessions.length} WhatsApp session(s)\n\nBot siap digunakan!`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.warn(`Could not notify owner ${ownerId}:`, err.message);
        }
      }
    } else {
      console.log('ℹ️ No existing sessions found');
    }
  } catch (err) {
    console.error('❌ Error restoring sessions:', err.message);
  }
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
    try {
      await bot.answerCallbackQuery(query.id, { 
        text: '❌ Lu bukan owner!', 
        show_alert: true 
      });
    } catch (err) {
      console.warn(`Failed to answer callback query: ${err.message}`);
    }
    return;
  }
  
  try {
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
        
      case 'rename_groups':
        await handleRenameGroups(chatId, userId);
        break;
        
      case 'confirm_rename':
        await handleConfirmRename(chatId, userId);
        break;
        
      case 'main_menu':
        await showMainMenu(chatId, query.message.message_id);
        break;
    }
    
    // Handle dynamic callbacks for group selection
    if (data.startsWith('select_base_')) {
      const baseName = data.replace('select_base_', '');
      await handleBaseNameSelection(chatId, userId, baseName);
    }
  } catch (err) {
    console.error('Error handling callback:', err);
    try {
      await bot.sendMessage(chatId, '❌ Terjadi error saat memproses perintah. Coba lagi ya!');
    } catch (sendErr) {
      console.error('Failed to send error message:', sendErr.message);
    }
  }
  
  // Answer callback query with error handling
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.warn(`Failed to answer callback query: ${err.message}`);
    // Ignore error, lanjut aja
  }
});

// Handle login
async function handleLogin(chatId, userId) {
  // Check if already connected
  if (userStates[userId]?.whatsapp?.isConnected) {
    await bot.sendMessage(chatId, '✅ WhatsApp sudah terhubung! Ga perlu login lagi.');
    return;
  }
  
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

// Extract number from group name - FIXED VERSION
function extractNumberFromGroupName(groupName) {
  // Try to find number at the end of string first
  const endMatch = groupName.match(/(\d+)\s*$/);
  if (endMatch) {
    return parseInt(endMatch[1]);
  }
  
  // If no number at end, try to find any number
  const anyMatch = groupName.match(/\d+/);
  if (anyMatch) {
    return parseInt(anyMatch[0]);
  }
  
  // If no number found, return 0
  return 0;
}

// Handle rename groups
async function handleRenameGroups(chatId, userId) {
  // Check if WhatsApp is connected
  if (!userStates[userId]?.whatsapp?.isConnected) {
    await bot.sendMessage(chatId, '❌ WhatsApp belum terhubung! Login dulu ya.');
    return;
  }
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Mengambil daftar grup...');
  
  try {
    const groups = await getAllGroups(userId);
    
    if (!groups || groups.length === 0) {
      await bot.editMessageText('❌ Tidak ada grup yang ditemukan!', {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    // Group by base name - IMPROVED VERSION
    const groupedByBase = {};
    
    groups.forEach(group => {
      // Extract base name (remove numbers and extra spaces)
      let baseName = group.name.replace(/\s*\d+\s*$/, '').trim();
      
      // If base name is empty after removing numbers, use original name
      if (!baseName) {
        baseName = group.name;
      }
      
      if (!groupedByBase[baseName]) {
        groupedByBase[baseName] = [];
      }
      
      groupedByBase[baseName].push(group);
    });
    
    console.log('[DEBUG] Grouped data:', JSON.stringify(groupedByBase, null, 2));
    
    // Filter only base names with more than 1 group
    const baseNamesWithMultiple = Object.keys(groupedByBase).filter(
      baseName => groupedByBase[baseName].length > 1
    );
    
    if (baseNamesWithMultiple.length === 0) {
      await bot.editMessageText('❌ Tidak ada grup dengan nama dasar yang sama!\n\nContoh: "HK 1", "HK 2" akan dikelompokkan sebagai "HK"', {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    // Create keyboard for base name selection
    const keyboard = [];
    baseNamesWithMultiple.forEach(baseName => {
      const count = groupedByBase[baseName].length;
      keyboard.push([{
        text: `${baseName} (${count} grup)`,
        callback_data: `select_base_${baseName}`
      }]);
    });
    keyboard.push([{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]);
    
    // Store grouped data for later use
    userStates[userId].groupedData = groupedByBase;
    
    await bot.editMessageText(
      '📝 *Pilih kelompok grup yang mau di-rename:*\n\nBot akan rename grup secara batch dengan numbering otomatis.',
      {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    );
    
  } catch (err) {
    console.error('Error getting groups:', err);
    await bot.editMessageText(`❌ Error mengambil daftar grup: ${err.message}`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
  }
}

// Handle base name selection - FIXED VERSION
async function handleBaseNameSelection(chatId, userId, baseName) {
  const groups = userStates[userId].groupedData[baseName];
  
  console.log(`[DEBUG] Processing base name: ${baseName}`);
  console.log(`[DEBUG] Groups:`, groups.map(g => g.name));
  
  // Sort groups by number (extract number from name) - IMPROVED
  groups.sort((a, b) => {
    const numA = extractNumberFromGroupName(a.name);
    const numB = extractNumberFromGroupName(b.name);
    console.log(`[DEBUG] Comparing: ${a.name} (${numA}) vs ${b.name} (${numB})`);
    return numA - numB;
  });
  
  let message = `📋 *Grup "${baseName}":*\n\n`;
  groups.forEach((group, index) => {
    const number = extractNumberFromGroupName(group.name);
    message += `${number}. ${group.name}\n`;
  });
  message += '\n💬 Kirim nomor grup yang mau dimulai rename (contoh: 1)';
  
  // Set state for waiting start number
  userStates[userId].renameState = {
    step: 'waiting_start_number',
    baseName: baseName,
    groups: groups
  };
  
  console.log(`[DEBUG] Rename state set:`, userStates[userId].renameState);
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Batal', callback_data: 'rename_groups' }]
      ]
    }
  });
}

// Handle phone number input and rename flow
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  if (!text || text.startsWith('/')) return;
  if (!isOwner(userId)) return;
  
  try {
    // Handle phone number input
    if (userStates[userId]?.waitingForPhone) {
      userStates[userId].waitingForPhone = false;
      
      // Delete user's message for privacy
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (err) {
        console.warn('Could not delete phone number message:', err.message);
      }
      
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
        try {
          await bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (delErr) {
          console.warn('Could not delete loading message:', delErr.message);
        }
        await bot.sendMessage(chatId, `❌ Error: ${err.message}`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Coba Lagi', callback_data: 'login' }],
              [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
            ]
          }
        });
      }
      return;
    }
    
    // Handle rename flow - FIXED VERSION
    if (userStates[userId]?.renameState) {
      const state = userStates[userId].renameState;
      
      console.log(`[DEBUG] Processing rename step: ${state.step}, input: ${text}`);
      
      switch (state.step) {
        case 'waiting_start_number':
          const startNum = parseInt(text.trim());
          console.log(`[DEBUG] Start number input: ${startNum}`);
          
          if (isNaN(startNum) || startNum < 1) {
            await bot.sendMessage(chatId, '❌ Nomor tidak valid! Kirim angka yang benar.');
            return;
          }
          
          // Check if start number exists - FIXED
          const availableNumbers = state.groups.map(group => {
            const num = extractNumberFromGroupName(group.name);
            console.log(`[DEBUG] Group: ${group.name}, extracted number: ${num}`);
            return num;
          });
          
          console.log(`[DEBUG] Available numbers:`, availableNumbers);
          console.log(`[DEBUG] Looking for number:`, startNum);
          
          const hasStartNum = availableNumbers.includes(startNum);
          
          if (!hasStartNum) {
            await bot.sendMessage(chatId, `❌ Nomor grup ${startNum} tidak ditemukan!\n\nNomor yang tersedia: ${availableNumbers.join(', ')}`);
            return;
          }
          
          state.startNumber = startNum;
          state.step = 'waiting_end_number';
          
          await bot.sendMessage(chatId, `✅ Mulai dari grup nomor: ${startNum}\n\n💬 Kirim nomor grup terakhir untuk rename\n\nNomor tersedia: ${availableNumbers.join(', ')}`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Batal', callback_data: 'rename_groups' }]
              ]
            }
          });
          break;
          
        case 'waiting_end_number':
          const endNum = parseInt(text.trim());
          console.log(`[DEBUG] End number input: ${endNum}`);
          
          if (isNaN(endNum) || endNum < state.startNumber) {
            await bot.sendMessage(chatId, `❌ Nomor tidak valid! Harus lebih besar atau sama dengan ${state.startNumber}.`);
            return;
          }
          
          // Check if end number exists - FIXED
          const availableEndNumbers = state.groups.map(group => extractNumberFromGroupName(group.name));
          const hasEndNum = availableEndNumbers.includes(endNum);
          
          if (!hasEndNum) {
            await bot.sendMessage(chatId, `❌ Nomor grup ${endNum} tidak ditemukan!\n\nNomor yang tersedia: ${availableEndNumbers.join(', ')}`);
            return;
          }
          
          state.endNumber = endNum;
          state.step = 'waiting_new_name';
          
          await bot.sendMessage(chatId, `✅ Rename dari grup ${state.startNumber} sampai ${state.endNumber}\n\n💬 Kirim nama grup baru (tanpa nomor, contoh: "MK"):`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Batal', callback_data: 'rename_groups' }]
              ]
            }
          });
          break;
          
        case 'waiting_new_name':
          const newName = text.trim();
          if (!newName || newName.length < 1) {
            await bot.sendMessage(chatId, '❌ Nama grup tidak boleh kosong!');
            return;
          }
          
          state.newName = newName;
          state.step = 'waiting_start_numbering';
          
          await bot.sendMessage(chatId, `✅ Nama grup baru: "${newName}"\n\n💬 Kirim nomor mulai untuk nama baru (contoh: jika kirim 4, maka jadi "${newName} 4", "${newName} 5", dst):`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Batal', callback_data: 'rename_groups' }]
              ]
            }
          });
          break;
          
        case 'waiting_start_numbering':
          const startNumbering = parseInt(text.trim());
          if (isNaN(startNumbering) || startNumbering < 1) {
            await bot.sendMessage(chatId, '❌ Nomor tidak valid! Kirim angka yang benar.');
            return;
          }
          
          state.startNumbering = startNumbering;
          
          // Show confirmation - IMPROVED
          const groupsInRange = state.groups.filter(group => {
            const groupNum = extractNumberFromGroupName(group.name);
            return groupNum >= state.startNumber && groupNum <= state.endNumber;
          });
          
          const totalGroups = groupsInRange.length;
          let confirmMsg = `🔄 *Konfirmasi Rename:*\n\n`;
          confirmMsg += `Base Name: ${state.baseName}\n`;
          confirmMsg += `Range: Grup ${state.startNumber} - ${state.endNumber}\n`;
          confirmMsg += `Total: ${totalGroups} grup\n`;
          confirmMsg += `Nama Baru: ${state.newName}\n`;
          confirmMsg += `Mulai Numbering: ${startNumbering}\n\n`;
          confirmMsg += `*Preview:*\n`;
          
          // Sort groups in range for preview
          groupsInRange.sort((a, b) => {
            const numA = extractNumberFromGroupName(a.name);
            const numB = extractNumberFromGroupName(b.name);
            return numA - numB;
          });
          
          groupsInRange.forEach((group, index) => {
            const oldNumber = extractNumberFromGroupName(group.name);
            const newNumber = startNumbering + index;
            confirmMsg += `• ${group.name} → ${state.newName} ${newNumber}\n`;
          });
          
          confirmMsg += `\n⚠️ Proses ini tidak bisa dibatalkan!`;
          
          await bot.sendMessage(chatId, confirmMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Lanjutkan Rename', callback_data: 'confirm_rename' }],
                [{ text: '❌ Batal', callback_data: 'rename_groups' }]
              ]
            }
          });
          break;
      }
    }
  } catch (err) {
    console.error('Error handling message:', err);
    try {
      await bot.sendMessage(chatId, '❌ Terjadi error. Coba lagi ya!');
    } catch (sendErr) {
      console.error('Failed to send error message:', sendErr.message);
    }
  }
});

// Handle confirm rename - IMPROVED VERSION
async function handleConfirmRename(chatId, userId) {
  const state = userStates[userId].renameState;
  
  if (!state) {
    await bot.sendMessage(chatId, '❌ Session expired. Mulai lagi dari menu rename.');
    return;
  }
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Memulai proses rename...');
  
  try {
    // Filter groups to rename - FIXED
    const groupsToRename = state.groups.filter(group => {
      const groupNum = extractNumberFromGroupName(group.name);
      return groupNum >= state.startNumber && groupNum <= state.endNumber;
    });
    
    console.log(`[DEBUG] Groups to rename:`, groupsToRename.map(g => `${g.name} (${extractNumberFromGroupName(g.name)})`));
    
    // Sort groups by number - FIXED
    groupsToRename.sort((a, b) => {
      const numA = extractNumberFromGroupName(a.name);
      const numB = extractNumberFromGroupName(b.name);
      return numA - numB;
    });
    
    let successCount = 0;
    let failCount = 0;
    let statusMessage = '';
    
    for (let i = 0; i < groupsToRename.length; i++) {
      const group = groupsToRename[i];
      const newNumber = state.startNumbering + i; // Sequential numbering
      const newGroupName = `${state.newName} ${newNumber}`;
      
      console.log(`[DEBUG] Renaming: ${group.name} → ${newGroupName}`);
      
      try {
        await renameGroup(userId, group.id, newGroupName);
        successCount++;
        statusMessage += `✅ ${group.name} → ${newGroupName}\n`;
        
        // Update progress
        try {
          await bot.editMessageText(
            `⏳ Proses rename... (${i + 1}/${groupsToRename.length})\n\n${statusMessage}`,
            {
              chat_id: chatId,
              message_id: loadingMsg.message_id
            }
          );
        } catch (editErr) {
          console.warn('Could not update progress message:', editErr.message);
        }
        
        // Delay to avoid rate limit - INCREASED
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 detik
      } catch (err) {
        failCount++;
        statusMessage += `❌ ${group.name} → Error: ${err.message}\n`;
        console.error(`Error renaming ${group.name}:`, err);
        
        // If rate limit, wait longer
        if (err.message.includes('rate') || err.message.includes('overlimit') || err.message.includes('timeout')) {
          console.log(`[DEBUG] Rate limit detected, waiting 10 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 10000)); // 10 detik
        }
      }
    }
    
    // Final result
    let finalMessage = `🎉 *Proses rename selesai!*\n\n`;
    finalMessage += `✅ Berhasil: ${successCount}\n`;
    finalMessage += `❌ Gagal: ${failCount}\n\n`;
    finalMessage += `*Detail:*\n${statusMessage}`;
    
    await bot.editMessageText(finalMessage, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Rename Lagi', callback_data: 'rename_groups' }],
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
    
  } catch (err) {
    console.error('Error in rename process:', err);
    try {
      await bot.editMessageText(`❌ Error dalam proses rename: ${err.message}`, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
    } catch (editErr) {
      console.error('Failed to edit error message:', editErr.message);
    }
  }
  
  // Clear rename state
  try {
    delete userStates[userId].renameState;
    delete userStates[userId].groupedData;
  } catch (err) {
    console.warn('Could not clear rename state:', err.message);
  }
}

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
  const lastConnect = userStates[userId]?.whatsapp?.lastConnect;
  
  let message = '*📊 Status Bot*\n\n';
  message += `WhatsApp: ${isConnected ? '✅ Connected' : '❌ Disconnected'}\n`;
  message += `Auto Accept: ${autoAcceptStatus.enabled ? '✅ ON' : '❌ OFF'}\n`;
  
  if (lastConnect) {
    message += `Last Connect: ${lastConnect.toLocaleString('id-ID')}\n`;
  }
  
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
  
  try {
    await bot.deleteMessage(chatId, loadingMsg.message_id);
  } catch (err) {
    console.warn('Could not delete loading message:', err.message);
  }
  
  if (success) {
    await bot.sendMessage(chatId, '✅ Logout berhasil! Session dihapus.');
  } else {
    await bot.sendMessage(chatId, '❌ Error waktu logout.');
  }
  
  await showMainMenu(chatId);
}

// Show main menu
async function showMainMenu(chatId, messageId = null) {
  const isConnected = userStates[chatId]?.whatsapp?.isConnected || false;
  
  const menuText = `👋 *Welcome to Auto Accept Bot!*\n\nStatus: ${isConnected ? '✅ Connected' : '❌ Disconnected'}\n\nPilih menu:`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔑 Login WhatsApp', callback_data: 'login' }],
      [{ text: '🤖 Auto Accept Settings', callback_data: 'auto_accept' }],
      [{ text: '✏️ Rename Groups', callback_data: 'rename_groups' }],
      [{ text: '🔄 Status', callback_data: 'status' }],
      [{ text: '🚪 Logout', callback_data: 'logout' }]
    ]
  };
  
  if (messageId) {
    try {
      await bot.editMessageText(menuText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (err) {
      console.warn('Could not edit main menu message:', err.message);
      // Fallback: send new message
      await bot.sendMessage(chatId, menuText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } else {
    await bot.sendMessage(chatId, menuText, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
   });
 }
}

// Global error handlers
bot.on('error', (error) => {
 console.error('Telegram Bot Error:', error);
});

bot.on('polling_error', (error) => {
 console.error('Telegram Polling Error:', error);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
 console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
 console.error('Uncaught Exception:', err);
 process.exit(1);
});

// Export userStates for whatsappClient
module.exports = { userStates };

// Initialize bot with session restore
initializeBot().then(() => {
 console.log('✅ Bot started! Send /start to begin.');
}).catch(err => {
 console.error('❌ Bot initialization failed:', err);
});
