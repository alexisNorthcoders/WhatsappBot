import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import * as commands from './whatsapp/commands/index.js';
import { isAllowedActor } from './whatsapp/whatsAppActorAllowlist.js';
import { createBaileysMessageHandler } from './whatsapp/orchestration/createBaileysMessageHandler.js';
import { createProductionPorts } from './whatsapp/orchestration/createProductionPorts.js';
import pino from 'pino';
const logger = pino();
import { promises as fs } from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';

const BAILEYS_AUTH_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.auth',
  'baileys'
);
import { initializeLightCache } from './hue/index.js';
import {
  readPendingCursorRun,
  clearPendingCursorRun,
} from './whatsapp/agents/cursorCliPending.js';
import { startCronIssueTracer } from './whatsapp/agents/cronIssueTracer.js';
import dotenv from 'dotenv';
dotenv.config();

const myPhone = process.env.MY_PHONE;
const secondPhone = process.env.SECOND_PHONE;

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
    maxMsgRetryCount: 3,
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
      if (myPhone) {
        startCronIssueTracer({
          getSocket: () => waSocket,
          getOwnerJid: () => {
            const raw = String(myPhone).trim();
            if (raw.includes('@')) return raw;
            const d = raw.replace(/\D/g, '');
            return d ? `${d}@s.whatsapp.net` : null;
          },
          logger,
        });
      }
      (async () => {
        const pending = await readPendingCursorRun();
        if (pending?.sender && pending?.logPath) {
          try {
            const ws = pending.workspaceRoot ? `\nWorkspace: ${pending.workspaceRoot}\n` : '';
            await sock.sendMessage(pending.sender, {
              text:
                'Previous Cursor agent run was interrupted before the bot could send the completion message (for example `pm2 restart` while the agent was still running).' +
                ws +
                'Inspect the run on the Pi:\n' +
                pending.logPath,
            });
            await clearPendingCursorRun();
          } catch (e) {
            logger.warn({ err: e }, 'pending Cursor run notice failed');
          }
        }
      })();
    } else if (connection === 'close') {
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
      }),
  });

  sock.ev.on('messages.upsert', async (upsert) => {
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
    
    // Then start the WhatsApp socket
    await startSock();
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

// Start the application
initializeApp();
