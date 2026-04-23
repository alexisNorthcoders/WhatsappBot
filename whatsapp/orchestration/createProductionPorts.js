import restartCommand from '../commands/restart.js';
import { spriteIterateCommand } from '../commands/sprite.js';
import { lidExtraJidsHint } from '../whatsAppActorAllowlist.js';
import { getWeatherData, deepInfraAPI, vision, visionQuality, visionHelp, assistantgenerateResponse } from '../../models/models.js';
import { pickRandomTopic } from '../../data/helper.js';
import { topics } from '../../data/topics.js';
import { getMessages, appendMessage, clearMessages } from '../chatMemory.js';
import { shouldTryLightsAgent, runLightsAgent, LIGHTS_AGENT_SKIP } from '../agents/lightsAgent.js';
import {
  shouldTryWeatherAgent,
  runWeatherAgent,
  WEATHER_AGENT_SKIP,
} from '../agents/weatherAgent.js';
import { shouldTryJoplinAgent, runJoplinAgent, JOPLIN_AGENT_SKIP } from '../agents/joplinAgent.js';
import { shouldTryEmailAgent, runEmailAgent, EMAIL_AGENT_SKIP } from '../agents/emailAgent.js';
import { runAgentsChainSequential } from './agentsTryHandle.js';

/**
 * @typedef {import('./normalizeBaileysMessage.js').InboundMessage} InboundMessage
 */

/**
 * @param {object} deps
 * @param {import('@whiskeysockets/baileys').WASocket} deps.sock
 * @param {typeof import('@whiskeysockets/baileys').downloadMediaMessage} deps.downloadMediaMessage
 * @param {typeof import('fs').promises} deps.fs
 * @param {{ info: Function; warn: Function; error: Function }} deps.logger
 * @param {Record<string, unknown>} deps.commands
 * @param {string | undefined} deps.secondPhone
 * @param {(actorId: string | null) => boolean} deps.isAllowedActor
 */
export function createProductionPorts(deps) {
  const { sock, downloadMediaMessage, fs, logger, commands, secondPhone, isAllowedActor } = deps;

  async function sendRandomMessage(recipient) {
    const topic = pickRandomTopic(topics);
    const response = await deepInfraAPI(`Give me a random fact about ${topic}`);
    await sock.sendMessage(recipient, { text: response });
  }

  async function sendWeatherMessage(recipient, city = 'Manchester') {
    const weatherData = await getWeatherData(city);
    const summary = await deepInfraAPI(`Summarize this weather: ${JSON.stringify(weatherData)}`);
    await sock.sendMessage(recipient, { text: summary });
  }

  const agentChainDeps = {
    logger,
    messaging: {
      sendText: async (chatId, text) => {
        await sock.sendMessage(chatId, { text });
      },
    },
    chatMemory: {
      append: appendMessage,
    },
    shouldTryLightsAgent,
    runLightsAgent,
    LIGHTS_AGENT_SKIP,
    shouldTryWeatherAgent,
    runWeatherAgent,
    WEATHER_AGENT_SKIP,
    shouldTryJoplinAgent,
    runJoplinAgent,
    JOPLIN_AGENT_SKIP,
    shouldTryEmailAgent,
    runEmailAgent,
    EMAIL_AGENT_SKIP,
  };

  return {
    receipts: {
      async markRead(m) {
        const raw = /** @type {import('@whiskeysockets/baileys').proto.WebMessageInfo} */ (m.raw);
        await sock.readMessages([raw.key]);
      },
    },
    messaging: {
      sendText: async (chatId, text) => {
        await sock.sendMessage(chatId, { text });
      },
      sendPoll: async (chatId, poll) => {
        await sock.sendMessage(chatId, { poll });
      },
      sendImage: async (chatId, image) => {
        await sock.sendMessage(chatId, { image: image.buffer, caption: image.caption });
      },
    },
    media: {
      async downloadImageBuffer(m) {
        const raw = /** @type {import('@whiskeysockets/baileys').proto.WebMessageInfo} */ (m.raw);
        return /** @type {Buffer} */ (
          await downloadMediaMessage(raw, 'buffer', {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage })
        );
      },
    },
    buttonSink: {
      async writeButton(button) {
        if (['a', 'b'].includes(button)) {
          await fs.writeFile('button.txt', button.toUpperCase(), 'utf8');
        } else {
          await fs.writeFile('button.txt', button, 'utf8');
        }
      },
    },
    chatMemory: {
      get: getMessages,
      append: appendMessage,
      clear: clearMessages,
    },
    ai: {
      visionText: (b64) => vision(b64),
      visionTextHigh: (b64) => visionQuality(b64),
      visionHelp: (b64) => visionHelp(b64),
      assistant: (userText, prior) => assistantgenerateResponse(userText, prior),
    },
    routes: {
      async runSpritePlus(m) {
        await spriteIterateCommand(sock, m.chatId, m.text);
        return { handled: true };
      },
      async runCommandByFirstToken(m) {
        const command = m.text.split(' ')[0].toLowerCase();
        const raw = /** @type {import('@whiskeysockets/baileys').proto.WebMessageInfo} */ (m.raw);
        if (!commands[command]) {
          return { handled: false };
        }

        if (command === 'cursor' && !isAllowedActor(m.actorId)) {
          await sock.sendMessage(m.chatId, {
            text:
              `Not allowed to run the Cursor agent from this identity.${lidExtraJidsHint(m.actorId)}\n\n(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CURSOR_AGENT_EXTRA_JIDS.)`,
          });
          return { handled: true };
        }

        logger.info(`Executing command: ${command}`);
        try {
          await commands[command](sock, m.chatId, m.text, raw);
          logger.info(`Command completed: ${command}`);
        } catch (cmdErr) {
          throw new Error(`Command '${command}' failed: ${cmdErr.message}`);
        }
        return { handled: true };
      },
      async runLegacyRoutes(m) {
        const command = m.text.split(' ')[0].toLowerCase();

        if (m.text.startsWith('Altweather')) {
          await sendWeatherMessage(m.chatId);
          return { handled: true };
        }
        if (command === '!help') {
          await commands.help(sock, m.chatId);
          return { handled: true };
        }
        if (command === '!restart') {
          if (!isAllowedActor(m.actorId)) {
            await sock.sendMessage(m.chatId, {
              text:
                `Not allowed to restart this bot from this identity.${lidExtraJidsHint(m.actorId)}\n\n(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CURSOR_AGENT_EXTRA_JIDS.)`,
            });
          } else {
            await restartCommand(sock, m.chatId);
          }
          return { handled: true };
        }
        if (command === '!clear') {
          const count = await clearMessages(m.chatId);
          await sock.sendMessage(m.chatId, {
            text:
              count > 0
                ? `Chat memory cleared (${count} message${count !== 1 ? 's' : ''} removed).`
                : 'Chat memory was already empty.',
          });
          return { handled: true };
        }
        if (m.text === '!sendpoll') {
          await sock.sendMessage(m.chatId, {
            poll: {
              name: 'Winter or Summer?',
              values: ['Winter', 'Summer'],
              selectableCount: 1,
            },
          });
          return { handled: true };
        }
        if (m.text.startsWith('Send')) {
          await sendRandomMessage(m.chatId);
          if (secondPhone) {
            await sendRandomMessage(`${secondPhone}@s.whatsapp.net`);
          }
          return { handled: true };
        }

        return { handled: false };
      },
    },
    agents: {
      tryHandle: async (m) => {
        const r = await runAgentsChainSequential(m, agentChainDeps);
        return { handled: r.handled };
      },
    },
    logger,
    buttons: { labels: ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'] },
  };
}
