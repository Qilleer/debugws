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

// Restore all existing sessions on startup
async function restoreAllSessions(bot) {
  const sessionsPath = config.whatsapp.sessionPath;
  const restoredSessions = [];
  
  if (!fs.existsSync(sessionsPath)) {
    return restoredSessions;
  }
  
  try {
    const sessionDirs = fs.readdirSync(sessionsPath)
      .filter(dir => dir.startsWith('wa_') && fs.statSync(path.join(sessionsPath, dir)).isDirectory());
    
    for (const sessionDir of sessionDirs) {
      try {
        // Extract userId from folder name (wa_12345 -> 12345)
        const userId = sessionDir.replace('wa_', '');
        
        // Check if session has required files
        const sessionPath = path.join(sessionsPath, sessionDir);
        const credsFile = path.join(sessionPath, 'creds.json');
        
        if (!fs.existsSync(credsFile)) {
          continue;
        }
        
        // Create connection for this user
        const sock = await createWhatsAppConnection(userId, bot, false, true);
        
        if (sock) {
          restoredSessions.push(userId);
          
          // Wait a bit between connections to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (err) {
        // Silent fail
      }
    }
    
    return restoredSessions;
  } catch (err) {
    return restoredSessions;
  }
}

// Create WhatsApp connection
async function createWhatsAppConnection(userId, bot, reconnect = false, isRestore = false) {
  try {
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
    
    // Pastikan folder session ada (JANGAN HAPUS SESSION LAMA)
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // Check if this is a fresh session or existing one
    const isExistingSession = fs.existsSync(path.join(sessionPath, 'creds.json'));
    
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
      lastQRTime: null,
      isExistingSession: isExistingSession
    };
    
    // Initialize auto accept - restore previous setting
    if (!userStates[userId].autoAccept) {
      // Try to load previous auto accept setting from file
      const settingsPath = path.join(sessionPath, 'settings.json');
      let autoAcceptEnabled = false;
      
      if (fs.existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          autoAcceptEnabled = settings.autoAccept || false;
        } catch (err) {
          // Silent fail
        }
      }
      
      userStates[userId].autoAccept = {
        enabled: autoAcceptEnabled
      };
    }
    
    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);
    
    // Handle connection update
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // Handle QR code if available (only for new sessions)
      if (qr && !isExistingSession && userStates[userId]?.whatsapp?.isWaitingForQR) {
        const now = Date.now();
        const lastQRTime = userStates[userId].whatsapp.lastQRTime || 0;
        
        if (now - lastQRTime < 30000) {
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
        } catch (qrErr) {
          await bot.sendMessage(userId, "❌ Error saat mengirim QR code. Coba lagi nanti.");
        }
      }
      
      if (connection === "open") {
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
          
          // Save settings
          await saveUserSettings(userId);
        }
        
        // Send success message
        if (isRestore) {
          // Silent for restore
        } else if (reconnect) {
          await bot.sendMessage(
            userId,
            "✅ *Reconnect berhasil!* Bot WhatsApp sudah terhubung kembali.",
            { parse_mode: 'Markdown' }
          );
        } else if (!isRestore) {
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
          
          // Notify user on first attempt only (skip for restore)
          if (reconnectAttempts[userId] === 1 && !isRestore) {
            await bot.sendMessage(
              userId, 
              `⚠️ *Koneksi terputus*\nReason: ${disconnectReason}\n\nSedang mencoba reconnect... (Attempt ${reconnectAttempts[userId]}/${MAX_RECONNECT_ATTEMPTS})`,
              { parse_mode: 'Markdown' }
            );
          }
          
          // Wait before reconnect
          setTimeout(async () => {
            if (userStates[userId]) {
              await createWhatsAppConnection(userId, bot, true);
            }
          }, config.whatsapp.reconnectDelay || 5000);
        } else if (userStates[userId]) {
          // Reset attempts
          reconnectAttempts[userId] = 0;
          
          // Send permanent disconnect message (skip for restore)
          if (!isRestore) {
            await bot.sendMessage(
              userId, 
              "❌ *Koneksi terputus permanen*\nPerlu login ulang pakai pairing code lagi.", 
              { parse_mode: 'Markdown' }
            );
          }
          
          // Delete session files only if logout/banned
          if (statusCode === 401 || statusCode === 403) {
            const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
            if (fs.existsSync(sessionPath)) {
              fs.rmSync(sessionPath, { recursive: true, force: true });
            }
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
    
    // Handle join requests
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
      } catch (err) {
        // Silent fail
      }
    });
    
    return sock;
  } catch (err) {
    if (!reconnect && !isRestore) {
      await bot.sendMessage(
        userId,
        `❌ Ada error saat membuat koneksi: ${err.message}`
      );
    }
    
    return null;
  }
}

// Save user settings to file
async function saveUserSettings(userId) {
  const userStates = getUserStates();
  
  try {
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
    const settingsPath = path.join(sessionPath, 'settings.json');
    
    const settings = {
      autoAccept: userStates[userId]?.autoAccept?.enabled || false,
      lastSaved: new Date().toISOString()
    };
    
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    // Silent fail
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
      // Silent fail
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
    // Delete loading message if exists
    try {
      await bot.deleteMessage(userId, messageId);
    } catch (delErr) {
      // Silent fail
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
    // Check if auto accept is enabled
    if (!userStates[userId].autoAccept?.enabled) {
      return;
    }
    
    const { id, participants, action } = update;
    
    // Only process join_request action
    if (action !== 'join_request') {
      return;
    }
    
    try {
      // Approve all join requests
      for (const jid of participants) {
        await sock.groupRequestParticipantsUpdate(
          id, // group id
          [jid], // participants to approve
          'approve' // approve | reject
        );
      }
    } catch (err) {
      // Silent fail
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
  
  // Save settings to file
  await saveUserSettings(userId);
  
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
    return false;
  }
}

module.exports = {
  createWhatsAppConnection,
  generatePairingCode,
  toggleAutoAccept,
  getAutoAcceptStatus,
  logoutWhatsApp,
  restoreAllSessions
};
