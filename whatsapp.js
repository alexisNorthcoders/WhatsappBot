import { default as makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, DisconnectReason } from '@whiskeysockets/baileys';
import * as commands from './whatsapp/commands/index.js';
import restartCommand from './whatsapp/commands/restart.js';
import { spriteIterateCommand } from './whatsapp/commands/sprite.js';
import { actorJid, isAllowedActor, lidExtraJidsHint } from './whatsapp/whatsAppActorAllowlist.js';
import pino from 'pino';
const logger = pino();
import { promises as fs } from 'fs';
import qrcode from 'qrcode-terminal';
import { getWeatherData, deepInfraAPI, vision, visionQuality, visionHelp, assistantgenerateResponse } from './models/models.js';
import { pickRandomTopic } from './data/helper.js';
import { topics } from './data/topics.js';
import { initializeLightCache } from './hue/index.js';
import { shouldTryLightsAgent, runLightsAgent, LIGHTS_AGENT_SKIP } from './whatsapp/agents/lightsAgent.js';
import {
  shouldTryWeatherAgent,
  runWeatherAgent,
  WEATHER_AGENT_SKIP,
} from './whatsapp/agents/weatherAgent.js';
import { shouldTryJoplinAgent, runJoplinAgent, JOPLIN_AGENT_SKIP } from './whatsapp/agents/joplinAgent.js';
import { shouldTryEmailAgent, runEmailAgent, EMAIL_AGENT_SKIP } from './whatsapp/agents/emailAgent.js';
import { getMessages, appendMessage, clearMessages } from './whatsapp/chatMemory.js';
import { getCursorCliRepoRoot } from './whatsapp/agents/cursorCliAgent.js';
import {
  readPendingCursorRun,
  clearPendingCursorRun,
} from './whatsapp/agents/cursorCliPending.js';
import dotenv from 'dotenv';
dotenv.config();

const myPhone = process.env.MY_PHONE;
const secondPhone = process.env.SECOND_PHONE;
const buttons = ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'];

/** Avoid overlapping reconnect timers when the connection flaps (prevents duplicate sockets → 440 connectionReplaced). */
let reconnectTimer = null;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./.auth/baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'debug' }),
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
      (async () => {
        const pending = await readPendingCursorRun(getCursorCliRepoRoot());
        if (pending?.sender && pending?.logPath) {
          try {
            await sock.sendMessage(pending.sender, {
              text:
                'Previous Cursor agent run was interrupted before the bot could send the completion message (for example `pm2 restart` while the agent was still running). Inspect the run on the Pi:\n' +
                pending.logPath,
            });
            await clearPendingCursorRun(getCursorCliRepoRoot());
          } catch (e) {
            logger.warn({ err: e }, 'pending Cursor run notice failed');
          }
        }
      })();
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Only loggedOut (401) invalidates this device session — see Baileys README / DisconnectReason.
      // 440 = connectionReplaced: reconnect after a short delay; not reconnecting often strands the bot until you wipe .auth.
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.info(
        { statusCode, reason: statusCode != null ? DisconnectReason[statusCode] : 'unknown', err: lastDisconnect?.error?.message },
        '❌ Connection closed'
      );

      if (shouldReconnect) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          logger.info('Starting reconnection...');
          startSock();
        }, 5000);
      } else {
        logger.error('Session logged out — scan QR again (or remove linked device in WhatsApp).');
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
      else if (/^\s*sprite\+/i.test(text)) {
        await spriteIterateCommand(sock, sender, text);
      }
      else if (commands[command]) {
        try {
          logger.info(`Executing command: ${command}`);
          await commands[command](sock, sender, text, msg);
          logger.info(`Command completed: ${command}`);
        } catch (cmdErr) {
          throw new Error(`Command '${command}' failed: ${cmdErr.message}`);
        }
      }
      else if (text.startsWith('Altweather')) {
        await sendWeatherMessage(sock, sender);

      }
      else if (command === '!help') {
        await commands.help(sock, sender);
      }
      else if (command === '!restart') {
        const actor = actorJid(msg, sender);
        if (!isAllowedActor(actor)) {
          await sock.sendMessage(sender, {
            text:
              `Not allowed to restart this bot from this identity.${lidExtraJidsHint(actor)}\n\n(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CURSOR_AGENT_EXTRA_JIDS.)`,
          });
        } else {
          await restartCommand(sock, sender);
        }
      }
      else if (command === '!clear') {
        const count = await clearMessages(sender);
        await sock.sendMessage(sender, {
          text: count > 0
            ? `Chat memory cleared (${count} message${count !== 1 ? 's' : ''} removed).`
            : 'Chat memory was already empty.',
        });
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
      else {
        let handled = false;
        if (shouldTryLightsAgent(text)) {
          try {
            const lightsReply = await runLightsAgent(text);
            if (lightsReply.trim().toUpperCase() !== LIGHTS_AGENT_SKIP) {
              await sock.sendMessage(sender, { text: lightsReply });
              await appendMessage(sender, 'user', text);
              await appendMessage(sender, 'assistant', lightsReply);
              handled = true;
            }
          } catch (lightsErr) {
            logger.error({ err: lightsErr }, 'Lights agent error');
            await sock.sendMessage(sender, {
              text: `Lights assistant error: ${lightsErr.message}`,
            });
            handled = true;
          }
        }
        if (!handled && shouldTryWeatherAgent(text)) {
          try {
            const weatherReply = await runWeatherAgent(text);
            if (weatherReply.trim().toUpperCase() !== WEATHER_AGENT_SKIP) {
              await sock.sendMessage(sender, { text: weatherReply });
              await appendMessage(sender, 'user', text);
              await appendMessage(sender, 'assistant', weatherReply);
              handled = true;
            }
          } catch (weatherErr) {
            logger.error({ err: weatherErr }, 'Weather agent error');
            await sock.sendMessage(sender, {
              text: `Weather assistant error: ${weatherErr.message}`,
            });
            handled = true;
          }
        }
        if (!handled && shouldTryJoplinAgent(text)) {
          try {
            const joplinReply = await runJoplinAgent(text);
            if (joplinReply.trim().toUpperCase() !== JOPLIN_AGENT_SKIP) {
              await sock.sendMessage(sender, { text: joplinReply });
              await appendMessage(sender, 'user', text);
              await appendMessage(sender, 'assistant', joplinReply);
              handled = true;
            }
          } catch (joplinErr) {
            logger.error({ err: joplinErr }, 'Joplin agent error');
            await sock.sendMessage(sender, {
              text: `Notes assistant error: ${joplinErr.message}`,
            });
            handled = true;
          }
        }
        if (!handled && shouldTryEmailAgent(text)) {
          try {
            const emailReply = await runEmailAgent(text);
            if (emailReply.trim().toUpperCase() !== EMAIL_AGENT_SKIP) {
              await sock.sendMessage(sender, { text: emailReply });
              await appendMessage(sender, 'user', text);
              await appendMessage(sender, 'assistant', emailReply);
              handled = true;
            }
          } catch (emailErr) {
            logger.error({ err: emailErr }, 'Email agent error');
            await sock.sendMessage(sender, {
              text: `Email assistant error: ${emailErr.message}`,
            });
            handled = true;
          }
        }
        if (!handled) {
          const prior = await getMessages(sender);
          const response = await assistantgenerateResponse(text, prior);
          await sock.sendMessage(sender, { text: response });
          await appendMessage(sender, 'user', text);
          await appendMessage(sender, 'assistant', response);
        }
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
