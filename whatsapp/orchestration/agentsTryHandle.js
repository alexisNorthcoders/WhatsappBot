/**
 * Sequential agent chain with SKIP fallthrough (same semantics as legacy whatsapp.js).
 * @param {import('./normalizeBaileysMessage.js').InboundMessage} m
 * @param {object} deps
 * @param {{ info: Function; warn: Function; error: Function }} deps.logger
 * @param {{ sendText(chatId: string, text: string): Promise<void> }} deps.messaging
 * @param {{ append(chatId: string, role: 'user'|'assistant', content: string): Promise<void> }} deps.chatMemory
 * @param {(text: string) => boolean} deps.shouldTryLightsAgent
 * @param {(text: string) => Promise<string>} deps.runLightsAgent
 * @param {string} deps.LIGHTS_AGENT_SKIP
 * @param {(text: string) => boolean} deps.shouldTryWeatherAgent
 * @param {(text: string) => Promise<string>} deps.runWeatherAgent
 * @param {string} deps.WEATHER_AGENT_SKIP
 * @param {(text: string) => boolean} deps.shouldTryJoplinAgent
 * @param {(text: string) => Promise<string>} deps.runJoplinAgent
 * @param {string} deps.JOPLIN_AGENT_SKIP
 * @param {(text: string) => boolean} deps.shouldTryEmailAgent
 * @param {(text: string) => Promise<string>} deps.runEmailAgent
 * @param {string} deps.EMAIL_AGENT_SKIP
 * @returns {Promise<{ handled: boolean }>}
 */
export async function runAgentsChainSequential(m, deps) {
  const {
    logger,
    messaging,
    chatMemory,
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
  } = deps;

  const text = m.text;
  const chatId = m.chatId;

  let handled = false;

  if (shouldTryLightsAgent(text)) {
    try {
      const lightsReply = await runLightsAgent(text);
      if (lightsReply.trim().toUpperCase() !== LIGHTS_AGENT_SKIP) {
        await messaging.sendText(chatId, lightsReply);
        await chatMemory.append(chatId, 'user', text);
        await chatMemory.append(chatId, 'assistant', lightsReply);
        handled = true;
      }
    } catch (lightsErr) {
      logger.error({ err: lightsErr }, 'Lights agent error');
      await messaging.sendText(chatId, `Lights assistant error: ${lightsErr.message}`);
      handled = true;
    }
  }

  if (!handled && shouldTryWeatherAgent(text)) {
    try {
      const weatherReply = await runWeatherAgent(text);
      if (weatherReply.trim().toUpperCase() !== WEATHER_AGENT_SKIP) {
        await messaging.sendText(chatId, weatherReply);
        await chatMemory.append(chatId, 'user', text);
        await chatMemory.append(chatId, 'assistant', weatherReply);
        handled = true;
      }
    } catch (weatherErr) {
      logger.error({ err: weatherErr }, 'Weather agent error');
      await messaging.sendText(chatId, `Weather assistant error: ${weatherErr.message}`);
      handled = true;
    }
  }

  if (!handled && shouldTryJoplinAgent(text)) {
    try {
      const joplinReply = await runJoplinAgent(text);
      if (joplinReply.trim().toUpperCase() !== JOPLIN_AGENT_SKIP) {
        await messaging.sendText(chatId, joplinReply);
        await chatMemory.append(chatId, 'user', text);
        await chatMemory.append(chatId, 'assistant', joplinReply);
        handled = true;
      }
    } catch (joplinErr) {
      logger.error({ err: joplinErr }, 'Joplin agent error');
      await messaging.sendText(chatId, `Notes assistant error: ${joplinErr.message}`);
      handled = true;
    }
  }

  if (!handled && shouldTryEmailAgent(text)) {
    try {
      const emailReply = await runEmailAgent(text);
      if (emailReply.trim().toUpperCase() !== EMAIL_AGENT_SKIP) {
        await messaging.sendText(chatId, emailReply);
        await chatMemory.append(chatId, 'user', text);
        await chatMemory.append(chatId, 'assistant', emailReply);
        handled = true;
      }
    } catch (emailErr) {
      logger.error({ err: emailErr }, 'Email agent error');
      await messaging.sendText(chatId, `Email assistant error: ${emailErr.message}`);
      handled = true;
    }
  }

  return { handled };
}
