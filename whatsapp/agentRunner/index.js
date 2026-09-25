import { createClient } from 'redis';
import { createAgentRunnerClient } from './agentRunnerClient.js';
import { createOutboxDrain, createRedisOutboxStore } from './agentRunnerOutbox.js';

const REDIS_CONNECT_TIMEOUT_MS = 3000;

/**
 * Bot side of agent-runner (docs/adr/0001-agent-runner-out-of-process.md): the orchestrator's
 * `agentRunner` port, plus the outbox drain that `whatsapp.js` starts on connect.
 *
 * @param {{
 *   url: string,
 *   redisUrl?: string,
 *   sendText: (chatId: string, text: string) => Promise<void>,
 *   getOwnerJid: () => string | null,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} p
 */
export function createAgentRunnerIntegration({ url, redisUrl, sendText, getOwnerJid, logger }) {
  const client = createAgentRunnerClient({ baseUrl: url });

  // node-redis keeps retrying a failed connect (and queues commands while offline) without ever
  // settling, which would hang `claude:missed`. Time-box the connect and fail commands fast instead.
  /** @type {Promise<import('redis').RedisClientType> | null} */
  let connecting = null;
  const connect = () => {
    if (!connecting) {
      const redis = createClient({ url: redisUrl || 'redis://127.0.0.1:6379', disableOfflineQueue: true });
      let down = false; // log once per outage, not on every reconnect attempt
      redis.on('error', (err) => {
        if (!down) logger.warn({ err: err.message }, 'agent-runner outbox (redis) error');
        down = true;
      });
      redis.on('ready', () => {
        down = false;
      });
      connecting = redis.connect().then(
        () => redis,
        (err) => {
          connecting = null;
          throw err;
        }
      );
    }
    return Promise.race([
      connecting,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('redis not connected')), REDIS_CONNECT_TIMEOUT_MS).unref();
      }),
    ]);
  };

  const outbox = createOutboxDrain({
    store: createRedisOutboxStore({ connect }),
    sendText,
    getOwnerJid,
    logger,
  });

  return {
    port: {
      sendCommand: client.sendCommand,
      status: client.status,
      missedReport: outbox.missedReport,
    },
    outbox,
  };
}
