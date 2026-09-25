import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import * as commands from './whatsapp/commands/index.js';
import { isAllowedActor, resolveOwnerLids } from './whatsapp/whatsAppActorAllowlist.js';
import { createBaileysMessageHandler } from './whatsapp/orchestration/createBaileysMessageHandler.js';
import { createProductionPorts } from './whatsapp/orchestration/createProductionPorts.js';
import { createMsgRetryCounterCache, socketCacheOptions } from './whatsapp/socketCacheOptions.js';
import { createSentMessageStore } from './whatsapp/sentMessageStore.js';
import { backupAuthDirOnce } from './whatsapp/baileysAuthBackup.js';
import pino from 'pino';
const logger = pino();
/** Shared across reconnects so decryption retry counts (and maxMsgRetryCount) persist. */
const msgRetryCounterCache = createMsgRetryCounterCache();
/** The bot's own outgoing messages, so retry requests can be answered; also shared across reconnects. */
const sentMessageStore = createSentMessageStore();
import { promises as fs } from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';

const BAILEYS_AUTH_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.auth',
  'baileys'
);
/** One-time copy of the auth folder from before Baileys 7.x's one-way LID session migration. */
const BAILEYS_AUTH_BACKUP_DIR = path.join(path.dirname(BAILEYS_AUTH_DIR), 'baileys-pre-v7-backup');
import { initializeLightCache } from './hue/index.js';
import { createAgentRunnerIntegration } from './whatsapp/agentRunner/index.js';
import { startRedditCronDigest } from './whatsapp/agents/redditCronDigest.js';
import {
  startReminderScheduler,
  stopReminderScheduler,
} from './whatsapp/reminders/reminderScheduler.js';
import dotenv from 'dotenv';
dotenv.config();

const myPhone = process.env.MY_PHONE;
const secondPhone = process.env.SECOND_PHONE;

/** @returns {string | null} */
function ownerJidFromMyPhone() {
  const raw = String(myPhone || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return raw;
  const d = raw.replace(/\D/g, '');
  return d ? `${d}@s.whatsapp.net` : null;
}

/**
 * `claude…` commands go to agent-runner (docs/adr/0001-agent-runner-out-of-process.md); its
 * outbox is delivered from here.
 */
const agentRunner = createAgentRunnerIntegration({
  url: process.env.AGENT_RUNNER_URL?.trim() || 'http://127.0.0.1:3790',
  redisUrl: process.env.REDIS_URL,
  sendText: async (chatId, text) => {
    if (!waSocket) throw new Error('WhatsApp socket not ready');
    // bounded: a send that never settles would wedge the outbox poll for good
    let timer;
    await Promise.race([
      waSocket.sendMessage(chatId, { text }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WhatsApp send timed out')), 60_000);
      }),
    ]).finally(() => clearTimeout(timer));
  },
  getOwnerJid: ownerJidFromMyPhone,
  logger,
});
const agentRunnerOutboxPollMs =
  parseInt(process.env.AGENT_RUNNER_OUTBOX_POLL_MS || '', 10) || 5000;

/** Avoid overlapping reconnect timers when the connection flaps (prevents duplicate sockets → 440 connectionReplaced). */
let reconnectTimer = null;
/** Latest socket — used to tear down before starting another (avoids duplicate live connections). */
let waSocket = null;
/** Resets on successful `connection === 'open'`; used for exponential backoff on transient closes. */
let reconnectAttempt = 0;

async function startSock() {
  try {
    waSocket?.end(undefined);
  } catch {
    /* ignore */
  }
  const { state, saveCreds } = await useMultiFileAuthState(BAILEYS_AUTH_DIR);
  // Reduces disk thrash and missed key writes; Baileys README recommends for non-trivial bots.
  state.keys = makeCacheableSignalKeyStore(state.keys, logger);

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
    ...socketCacheOptions(msgRetryCounterCache),
    getMessage: sentMessageStore.getMessage,
    
    // Link preview and media settings
    generateHighQualityLinkPreview: true,
    patchMessageBeforeSending: (message) => message,
    
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
      logger.info(
        { path: BAILEYS_AUTH_DIR },
        '📱 Pairing: scan the QR in this terminal (e.g. pm2 logs) — the ASCII art below; phone → Linked devices → Link a device'
      );
      console.log('📱 Scan the QR code below:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempt = 0;
      logger.info('✅ WhatsApp connected.');
      void resolveOwnerLids(sock, { logger });
      startReminderScheduler({
        getSocket: () => waSocket,
        logger,
      });
      // the first poll of the process reports what arrived while the bot was down
      agentRunner.outbox.start(agentRunnerOutboxPollMs);
      if (myPhone) {
        startRedditCronDigest({
          getSocket: () => waSocket,
          getOwnerJid: ownerJidFromMyPhone,
          logger,
        });
      }
    } else if (connection === 'close') {
      stopReminderScheduler();
      agentRunner.outbox.stop();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      /*
       * Reconnect only helps *transient* errors (408/428/440/503/515…). It does **not** fix 401:
       * WhatsApp has invalidated this linked device (logout, device_removed conflict, ToS, etc.).
       * Logs showed: stream:error conflict type device_removed — that is decided on WhatsApp’s servers,
       * not something Baileys can override by reconnecting.
       */
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.forbidden;

      logger.info(
        { statusCode, reason: statusCode != null ? DisconnectReason[statusCode] : 'unknown', err: lastDisconnect?.error?.message },
        '❌ Connection closed'
      );

      if (shouldReconnect) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        const delayMs = Math.min(120_000, 5_000 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          logger.info({ delayMs, attempt: reconnectAttempt }, 'Starting reconnection...');
          startSock();
        }, delayMs);
      } else if (statusCode === DisconnectReason.loggedOut) {
        /*
         * With old creds on disk, Baileys *resumes* and the server may return 401 before a QR is
         * ever sent — so users see "logged out" but no pairing code. Clear auth and one fresh
         * `startSock()` so pairing (QR) can run.
         */
        logger.error(
          'Session logged out (401). WhatsApp revoked this device; clearing local creds to allow a new QR.'
        );
        void (async () => {
          try {
            await fs.rm(BAILEYS_AUTH_DIR, { recursive: true, force: true });
            logger.info('Stale auth removed; starting a new pairing. Watch for the QR in the log...');
            setImmediate(() => {
              void startSock();
            });
          } catch (e) {
            logger.error(
              { err: e, path: BAILEYS_AUTH_DIR },
              'Could not clear auth. Stop the bot, delete .auth/baileys, then start again.'
            );
          }
        })();
      } else {
        logger.error('Connection closed with forbidden — not auto-reconnecting.');
      }
    } else if (connection === 'connecting') {
      logger.info('🔄 Connecting to WhatsApp...');
    }
  });

  const messageHandler = createBaileysMessageHandler({
    sock,
    commands,
    createPorts: () =>
      createProductionPorts({
        sock,
        downloadMediaMessage,
        fs,
        logger,
        commands,
        secondPhone,
        isAllowedActor,
        agentRunner: agentRunner.port,
      }),
  });

  sock.ev.on('messages.upsert', async (upsert) => {
    // With emitOwnEvents on, every sendMessage comes back here as a fromMe upsert.
    sentMessageStore.recordUpsert(upsert);
    await messageHandler.handleUpsert(upsert);
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

  waSocket = sock;
  logger.info("✅ Baileys connected.");
}

// Initialize the application
async function initializeApp() {
  try {
    // Initialize light cache first
    await initializeLightCache();

    // Before the first socket opens: Baileys 7.x rewrites the stored sessions and can't go back.
    // A failed backup aborts startup rather than migrating without a rollback copy.
    const backup = await backupAuthDirOnce({
      authDir: BAILEYS_AUTH_DIR,
      backupDir: BAILEYS_AUTH_BACKUP_DIR,
    });
    if (backup.status === 'created') {
      logger.info({ backupDir: BAILEYS_AUTH_BACKUP_DIR }, 'backed up Baileys auth folder (pre-v7)');
    }

    // Then start the WhatsApp socket
    await startSock();
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

// Start the application
initializeApp();
