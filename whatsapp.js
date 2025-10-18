import { default as makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import * as commands from './whatsapp/commands/index.js';
import pino from 'pino';
const logger = pino();
import { promises as fs } from 'fs';
import qrcode from 'qrcode-terminal';
import { getWeatherData, deepInfraAPI, vision, visionQuality, visionHelp, assistantgenerateResponse } from './models/models.js';
import { pickRandomTopic } from './data/helper.js';
import { topics } from './data/topics.js';
import { initializeLightCache } from './hue/index.js';
import dotenv from 'dotenv';
dotenv.config();

const myPhone = process.env.MY_PHONE;
const secondPhone = process.env.SECOND_PHONE;
const buttons = ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'];

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./.auth/baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'debug' }),
    printQRInTerminal: true,
    browser: ["WhatsApp Bot", "Chrome", "1.0.0"],
    
    // Connection settings
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    emitOwnEvents: true,
    markOnlineOnConnect: true,
    
    // Sync settings
    syncFullHistory: false,
    shouldIgnoreJid: jid => false,
    shouldSyncHistoryMessage: () => false,
    
    // Message retry and cache settings
    msgRetryCounterCache: {
      maxRetriesPerMessage: 3,
    },
    getMessage: async () => undefined,
    
    // Link preview and media settings
    generateHighQualityLinkPreview: true,
    patchMessageBeforeSending: (message) => message,
    
    // Device and cache settings
    userDevicesCache: new Map(),
    
    // Timeout settings
    retryRequestDelayMs: 250
  });

  sock.ev.on('creds.update', saveCreds);

  // Handle device properties and messaging history
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
    logger.info(`Received messaging history: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} messages`);
    if (isLatest) {
      logger.info('History is up to date');
    }
  });

  // Handle received properties
  sock.ev.on('received-patcher', async ({ data, namespace }) => {
    logger.info('Received properties:', { namespace });
    if (namespace === 'critical_block') {
      logger.info('Received critical properties');
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.log("📱 Scan the QR code below:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('✅ WhatsApp connected.');
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== 401 && statusCode !== 440;
      
      logger.info('❌ Connection closed. Status code:', statusCode);
      
      if (shouldReconnect) {
        logger.info('🔄 Reconnecting...');
        setTimeout(() => {
          logger.info('Starting reconnection...');
          startSock();
        }, 5000); // Wait 5 seconds before reconnecting
      } else {
        logger.error('❌ Connection closed permanently.');
      }
    } else if (connection === 'connecting') {
      logger.info('🔄 Connecting to WhatsApp...');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const messageType = Object.keys(msg.message)[0];
    
    // Send read receipt
    try {
      await sock.readMessages([msg.key]);
      logger.info(`Sent read receipt for message ${msg.key.id}`);
    } catch (err) {
      logger.warn(`Failed to send read receipt: ${err.message}`);
    }

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const button = text.toLowerCase();

    const command = text.split(' ')[0].toLowerCase();

    try {
      // Log incoming message details for debugging
      logger.info('Processing message:', {
        messageId: msg.key.id,
        type: messageType,
        command: command,
        isButton: buttons.includes(button)
      });

      if (buttons.includes(button)) {
        try {
          if (['a', 'b'].includes(button)) {
            await fs.writeFile('button.txt', button.toUpperCase(), 'utf8');
          } else {
            await fs.writeFile('button.txt', button, 'utf8');
          }
          logger.info('Button processed:', button);
        } catch (fsErr) {
          throw new Error(`Failed to write button: ${fsErr.message}`);
        }
      }

      // Media processing (image with caption)
      if (msg.message.imageMessage) {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage });

        if (text.startsWith("Text high")) {
          const res = await visionQuality(buffer.toString('base64'));
          await sock.sendMessage(sender, { text: res });
        } else if (text.startsWith("Text")) {
          const res = await vision(buffer.toString('base64'));
          await sock.sendMessage(sender, { text: res });
        } else if (text.startsWith("Help")) {
          const res = await visionHelp(buffer.toString('base64'));
          await sock.sendMessage(sender, { text: res });
        }

      }
      else if (commands[command]) {
        try {
          logger.info(`Executing command: ${command}`);
          await commands[command](sock, sender, text);
          logger.info(`Command completed: ${command}`);
        } catch (cmdErr) {
          throw new Error(`Command '${command}' failed: ${cmdErr.message}`);
        }
      }
      else if (text.startsWith('Altweather')) {
        await sendWeatherMessage(sock, sender);

      }
      else if (text === '!sendpoll') {
        await sock.sendMessage(sender, {
          poll: {
            name: 'Winter or Summer?',
            values: ['Winter', 'Summer'],
            selectableCount: 1
          }
        });

      }
      else if (text.startsWith("Send")) {
        await sendRandomMessage(sock, sender);
        await sendRandomMessage(sock, secondPhone + '@s.whatsapp.net');
      }
      else if (text.startsWith("Weather")) {
        const city = text.replace("Weather ", "");
        const forecast = await getWeatherData(city);
        const response = formatWeather(city, forecast);
        await sock.sendMessage(sender, { text: response });

      }
      else if (text.startsWith("Light on ")) {
        const lightName = text.replace("Light on ", "");
        commands.hue.lightOn(sock, sender, lightName);
      }
      else if (text.startsWith("Light off ")) {
        const lightName = text.replace("Light off ", "");
        commands.hue.lightOff(sock, sender, lightName);
      }
      else if (text === "Lights off") commands.hue.lightsOff(sock, sender)
      else if (text === "List lights") commands.hue.listLights(sock, sender)
      else if (text.startsWith("Lights in ")) {
        const roomName = text.replace("Lights in ", "");
        commands.hue.listLightsByRoom(sock, sender, roomName);
      }
      else if (text.startsWith("Brightness ")) {
        const parts = text.replace("Brightness ", "").split(" ");
        if (parts.length >= 2) {
          const brightness = parts[0];
          const lightName = parts.slice(1).join(" ");
          commands.hue.setBrightness(sock, sender, lightName, brightness);
        } else {
          await sock.sendMessage(sender, { text: "Usage: Brightness <0-100> <light name>" });
        }
      }
      else if (text.startsWith("Color temp ")) {
        const parts = text.replace("Color temp ", "").split(" ");
        if (parts.length >= 2) {
          const colorTemp = parts[0];
          const lightName = parts.slice(1).join(" ");
          commands.hue.setColorTemp(sock, sender, lightName, colorTemp);
        } else {
          await sock.sendMessage(sender, { text: "Usage: Color temp <1-10> <light name>" });
        }
      }
      else if (text.startsWith("Color ")) {
        const parts = text.replace("Color ", "").split(" ");
        if (parts.length >= 2) {
          const color = parts[0];
          const lightName = parts.slice(1).join(" ");
          commands.hue.setColor(sock, sender, lightName, color);
        } else {
          await sock.sendMessage(sender, { text: "Usage: Color <color> <light name>" });
        }
      }
      else if (text.startsWith("Light info ")) {
        const lightName = text.replace("Light info ", "");
        commands.hue.lightInfo(sock, sender, lightName);
      }
      else if (text === "Refresh cache") commands.hue.refreshCache(sock, sender)
      else if (text === "Cache status") commands.hue.cacheStatus(sock, sender)
      else {
        const response = await assistantgenerateResponse(text);
        await sock.sendMessage(sender, { text: response });
      }
    } catch (err) {
      // Log detailed error information
      logger.error("❌ Error processing message:", {
        error: err.message,
        stack: err.stack,
        messageId: msg.key.id,
        sender: sender,
        type: messageType,
        text: text,
        command: command,
        context: {
          isButton: buttons.includes(button),
          isImage: !!msg.message.imageMessage,
          isCommand: !!commands[command]
        }
      });
      
      // Try to notify the sender of the error with more specific information
      try {
        const errorMessage = err.message.includes('network') 
          ? "Sorry, there seems to be a connection issue. Please try again in a moment."
          : "Sorry, there was an error processing your message. Please try again.";
        
        await sock.sendMessage(sender, { text: errorMessage });
      } catch (notifyErr) {
        logger.error("Failed to send error notification:", {
          error: notifyErr.message,
          originalError: err.message,
          sender: sender
        });
      }
    }
  });

  // Handle message receipt events
  sock.ev.on('message-receipt.update', async (updates) => {
    for (const update of updates) {
      try {
        const { key, receipt } = update;
        logger.info('Receipt update:', {
          messageId: key.id,
          remoteJid: key.remoteJid,
          fromMe: key.fromMe,
          receiptType: receipt.type,
          timestamp: receipt.timestamp,
          receiptDetails: receipt
        });
      } catch (err) {
        logger.warn('Failed to process receipt update:', {
          error: err.message,
          update: JSON.stringify(update)
        });
      }
    }
  });

  // Handle acknowledgments
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      try {
        logger.info('Message update:', {
          messageId: update.key.id,
          update: update.update,
          type: update.type
        });
      } catch (err) {
        logger.warn('Failed to process message update:', {
          error: err.message,
          update: JSON.stringify(update)
        });
      }
    }
  });

  logger.info("✅ Baileys connected.");
}

function formatWeather(city, forecast) {
  return `${city}
${forecast.list.slice(0, 8).map(f => `
${f.dt_txt}:
• Temp: ${f.main.temp}
• Humidity: ${f.main.humidity}
• Desc: ${f.weather[0].description}
`).join('')}`;
}

async function sendRandomMessage(sock, recipient = myPhone + "@s.whatsapp.net") {
  const topic = pickRandomTopic(topics);
  const response = await deepInfraAPI(`Give me a random fact about ${topic}`);
  await sock.sendMessage(recipient, { text: response });
}

async function sendWeatherMessage(sock, recipient = myPhone + "@s.whatsapp.net", city = "Manchester") {
  const weatherData = await getWeatherData(city);
  const summary = await deepInfraAPI(`Summarize this weather: ${JSON.stringify(weatherData)}`);
  await sock.sendMessage(recipient, { text: summary });
}

// Initialize the application
async function initializeApp() {
  try {
    // Initialize light cache first
    await initializeLightCache();
    
    // Then start the WhatsApp socket
    await startSock();
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

// Start the application
initializeApp();
