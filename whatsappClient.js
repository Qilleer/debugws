const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Get userStates from index.js
function getUserStates() {
  return require('./index').userStates;
}

// Tracking reconnect attempts
const reconnectAttempts = {};
const MAX_RECONNECT_ATTEMPTS = 3;

// Create WhatsApp connection
async function createWhatsAppConnection(userId, bot, reconnect = false) {
  try {
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
    
    // Pastikan folder session ada (JANGAN HAPUS SESSION LAMA)
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // Buat socket dengan browser config lengkap
    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Safari"),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 5000
    });
    
    // Log all events for debugging (compatible version)
    sock.ev.process(
      async (events) => {
        for (const key in events) {
          if (events[key]) {
            console.log('[DEBUG][process] Event:', key, JSON.stringify(events[key], null, 2));
          }
        }
      }
    );
    
    // Save user state
    const userStates = getUserStates();
    
    if (!userStates[userId]) {
      userStates[userId] = {};
    }
    
    userStates[userId].whatsapp = {
      socket: sock,
      isConnected: false,
      lastConnect: null,
      isWaitingForPairingCode: false,
      isWaitingForQR: false,
      lastQRTime: null
    };
    
    // Initialize auto accept
    if (!userStates[userId].autoAccept) {
      userStates[userId].autoAccept = {
        enabled: false
      };
    }
    
    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);
    
    // Handle connection update
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log(`[DEBUG] Connection update for ${userId}: ${connection}`);
      
      // Handle QR code if available
      if (qr && userStates[userId]?.whatsapp?.isWaitingForQR) {
        const now = Date.now();
        const lastQRTime = userStates[userId].whatsapp.lastQRTime || 0;
        
        if (now - lastQRTime < 30000) {
          console.log(`[DEBUG] Skipping QR code for ${userId} - too soon since last QR`);
          return;
        }
        
        try {
          userStates[userId].whatsapp.lastQRTime = now;
          
          const qrUrl = await require('qrcode').toDataURL(qr);
          const qrBuffer = Buffer.from(qrUrl.split(',')[1], 'base64');
          
          await bot.sendPhoto(userId, qrBuffer, {
            caption: "🔒 *Scan QR Code ini dengan WhatsApp*\n\nBuka WhatsApp > Menu > Perangkat Tertaut > Tautkan Perangkat\n\nQR code valid selama 60 detik!",
            parse_mode: 'Markdown'
          });
          
          console.log(`[DEBUG] Sent QR code to user ${userId}`);
        } catch (qrErr) {
          console.error(`[ERROR] Failed to send QR code: ${qrErr.message}`);
          await bot.sendMessage(userId, "❌ Error saat mengirim QR code. Coba lagi nanti.");
        }
      }
      
      if (connection === "open") {
        console.log(`WhatsApp connection open for user: ${userId}`);
        
        // Reset reconnect attempts
        reconnectAttempts[userId] = 0;
        
        // Setup auto accept handler
        setupAutoAcceptHandler(userId);
        
        // Update state
        if (userStates[userId] && userStates[userId].whatsapp) {
          userStates[userId].whatsapp.isConnected = true;
          userStates[userId].whatsapp.lastConnect = new Date();
          userStates[userId].whatsapp.isWaitingForPairingCode = false;
          userStates[userId].whatsapp.isWaitingForQR = false;
          userStates[userId].whatsapp.lastQRTime = null;
        }
        
        // Send success message
        if (reconnect) {
          await bot.sendMessage(
            userId,
            "✅ *Reconnect berhasil!* Bot WhatsApp sudah terhubung kembali.",
            { parse_mode: 'Markdown' }
          );
        } else {
          await bot.sendMessage(
            userId,
            "🚀 *Bot WhatsApp berhasil terhubung!*\n\nSekarang kamu bisa menggunakan auto accept!",
            { parse_mode: 'Markdown' }
          );
        }
      } else if (connection === "close") {
        // Update state
        if (userStates[userId] && userStates[userId].whatsapp) {
          userStates[userId].whatsapp.isConnected = false;
        }
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const disconnectReason = lastDisconnect?.error?.output?.payload?.message || "Unknown";
        
        console.log(`[DEBUG] Connection closed for userId ${userId}. Status code: ${statusCode}, Reason: ${disconnectReason}`);
        
        // Cek apakah perlu reconnect
        let shouldReconnect = true;
        
        // Status code 401 atau 403 biasanya logout/banned
        if (statusCode === 401 || statusCode === 403) {
          shouldReconnect = false;
        }
        
        // Tambah tracking reconnect attempts
        if (!reconnectAttempts[userId]) {
          reconnectAttempts[userId] = 0;
        }
        
        // Logika reconnect
        if (shouldReconnect && userStates[userId] && reconnectAttempts[userId] < MAX_RECONNECT_ATTEMPTS) {
          // Increment attempt counter
          reconnectAttempts[userId]++;
          
          // Notify user on first attempt only
          if (reconnectAttempts[userId] === 1) {
            await bot.sendMessage(
              userId, 
              `⚠️ *Koneksi terputus*\nReason: ${disconnectReason}\n\nSedang mencoba reconnect... (Attempt ${reconnectAttempts[userId]}/${MAX_RECONNECT_ATTEMPTS})`,
              { parse_mode: 'Markdown' }
            );
          }
          
          // Wait before reconnect
          setTimeout(async () => {
            if (userStates[userId]) {
              console.log(`[DEBUG] Attempting to reconnect for userId: ${userId} (Attempt ${reconnectAttempts[userId]}/${MAX_RECONNECT_ATTEMPTS})`);
              await createWhatsAppConnection(userId, bot, true);
            }
          }, config.whatsapp.reconnectDelay || 5000);
        } else if (userStates[userId]) {
          // Reset attempts
          reconnectAttempts[userId] = 0;
          
          // Send permanent disconnect message
          await bot.sendMessage(
            userId, 
            "❌ *Koneksi terputus permanen*\nPerlu login ulang pakai pairing code lagi.", 
            { parse_mode: 'Markdown' }
          );
          
          // Delete session files
          const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`Session files deleted for userId: ${userId}`);
          }
          
          // Clear user state
          userStates[userId].whatsapp = {
            socket: null,
            isConnected: false,
            lastConnect: null,
            isWaitingForPairingCode: false,
            isWaitingForQR: false,
            lastQRTime: null
          };
        }
      }
    });
    
    // Handle join requests (baru, event group.join-request)
    sock.ev.on('group.join-request', async (update) => {
      const userStates = getUserStates();
      if (!userStates[userId].autoAccept?.enabled) return;

      const { id, participant } = update;
      try {
        await sock.groupRequestParticipantsUpdate(
          id, // group id
          [participant], // participant to approve
          'approve' // approve | reject
        );
        console.log(`[DEBUG] Auto approved ${participant} for group ${id} via group.join-request`);
      } catch (err) {
        console.error('[ERROR] Error auto accepting (group.join-request):', err);
      }
    });
    
    return sock;
  } catch (err) {
    console.error(`Error creating WhatsApp connection for ${userId}:`, err);
    
    if (!reconnect) {
      await bot.sendMessage(
        userId,
        `❌ Ada error saat membuat koneksi: ${err.message}`
      );
    }
    
    return null;
  }
}

// Generate pairing code
async function generatePairingCode(userId, phoneNumber, bot, messageId) {
  const userStates = getUserStates();
  
  try {
    // Check if socket exists
    if (!userStates[userId]?.whatsapp?.socket) {
      throw new Error("Koneksi WhatsApp belum dibuat");
    }
    
    const sock = userStates[userId].whatsapp.socket;
    
    // Set flag to indicate we're in pairing phase
    userStates[userId].whatsapp.isWaitingForPairingCode = true;
    
    // Store phone number
    userStates[userId].whatsapp.phoneNumber = phoneNumber;
    
    // Delete loading message
    try {
      await bot.deleteMessage(userId, messageId);
    } catch (err) {
      console.warn(`Could not delete loading message: ${err.message}`);
    }
    
    // Request pairing code with options
    const code = await sock.requestPairingCode(phoneNumber);
    
    // Send pairing code
    await bot.sendMessage(
      userId,
      `🔑 *Pairing Code:*\n\n*${code}*\n\nMasukkan code di atas ke WhatsApp kamu dalam 60 detik!\n\nBuka WhatsApp > Menu > Perangkat Tertaut > Tautkan Perangkat\n\nKalau terputus, otomatis akan reconnect!`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batal', callback_data: 'cancel_login' }]
          ]
        }
      }
    );
    
    return true;
  } catch (err) {
    console.error(`Error generating pairing code for ${userId}:`, err);
    
    // Delete loading message if exists
    try {
      await bot.deleteMessage(userId, messageId);
    } catch (delErr) {
      console.warn(`Could not delete loading message: ${delErr.message}`);
    }
    
    // Send error message
    await bot.sendMessage(
      userId,
      `❌ Gagal membuat pairing code. Coba lagi nanti atau pakai nomor lain`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      }
    );
    
    return false;
  }
}

// Setup auto accept handler
function setupAutoAcceptHandler(userId) {
  const userStates = getUserStates();
  const sock = userStates[userId]?.whatsapp?.socket;
  
  if (!sock || userStates[userId].autoAcceptHandlerActive) return;
  
  // Handle join requests
  sock.ev.on('group-participants.update', async (update) => {
    console.log('[DEBUG] Group participants update:', update);
    
    // Check if auto accept is enabled
    if (!userStates[userId].autoAccept?.enabled) {
      console.log('[DEBUG] Auto accept is disabled, skipping');
      return;
    }
    
    const { id, participants, action } = update;
    console.log(`[DEBUG] Action: ${action}, Group: ${id}, Participants: ${participants.join(', ')}`);
    
    // Only process join_request action
    if (action !== 'join_request') {
      console.log('[DEBUG] Not a join request, skipping');
      return;
    }
    
    try {
      // Approve all join requests
      for (const jid of participants) {
        console.log(`[DEBUG] Attempting to approve ${jid} for group ${id}`);
        await sock.groupRequestParticipantsUpdate(
          id, // group id
          [jid], // participants to approve
          'approve' // approve | reject
        );
        
        console.log(`[DEBUG] Successfully approved ${jid} for group ${id}`);
      }
    } catch (err) {
      console.error('[ERROR] Error auto accepting:', err);
    }
  });
  
  userStates[userId].autoAcceptHandlerActive = true;
}

// Toggle auto accept
async function toggleAutoAccept(userId, enabled) {
  const userStates = getUserStates();
  
  if (!userStates[userId]) {
    userStates[userId] = {};
  }
  
  if (!userStates[userId].autoAccept) {
    userStates[userId].autoAccept = {};
  }
  
  userStates[userId].autoAccept.enabled = enabled;
  
  // Re-setup handler if enabling
  if (enabled && userStates[userId].whatsapp?.isConnected) {
    setupAutoAcceptHandler(userId);
  }
  
  return { success: true, enabled };
}

// Get auto accept status
function getAutoAcceptStatus(userId) {
  const userStates = getUserStates();
  return {
    enabled: userStates[userId]?.autoAccept?.enabled || false
  };
}

// Logout WhatsApp
async function logoutWhatsApp(userId) {
  const userStates = getUserStates();
  
  try {
    // Logout if connected
    if (userStates[userId]?.whatsapp?.socket) {
      await userStates[userId].whatsapp.socket.logout();
    }
    
    // Delete session files
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    
    // Clear state
    delete userStates[userId];
    
    // Reset reconnect attempts
    reconnectAttempts[userId] = 0;
    
    return true;
  } catch (err) {
    console.error('Error logging out:', err);
    return false;
  }
}

module.exports = {
  createWhatsAppConnection,
  generatePairingCode,
  toggleAutoAccept,
  getAutoAcceptStatus,
  logoutWhatsApp
};