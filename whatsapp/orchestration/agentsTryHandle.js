/**
 * Agent chain. With `routeIntent` (Jev), one call picks the agent and only that agent runs;
 * otherwise (or when Jev is unreachable) agents are tried in order behind their keyword gates,
 * with SKIP fallthrough (same semantics as legacy whatsapp.js).
 * @param {import('./normalizeBaileysMessage.js').InboundMessage} m
 * @param {object} deps
 * @param {{ info: Function; warn: Function; error: Function }} deps.logger
 * @param {{ sendText(chatId: string, text: string): Promise<void> }} deps.messaging
 * @param {{ append(chatId: string, role: 'user'|'assistant', content: string): Promise<void> }} deps.chatMemory
 * @param {(text: string) => Promise<{ agent: string; probability: number; answers?: Record<string, any> } | null>} [deps.routeIntent]
 * @param {(text: string, answers: Record<string, any>) => Promise<string | null>} [deps.runLightsFromJev]
 *   Jev-answered lights request; null hands over to runLightsAgent
 * @param {(text: string) => boolean} [deps.shouldTryReminderAgent]
 * @param {(m: import('./normalizeBaileysMessage.js').InboundMessage) => Promise<{ handled: boolean, replyText?: string }>} [deps.runReminderAgent]
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
 * @param {(text: string) => boolean} [deps.shouldTryHomeAgent]
 * @param {(text: string) => Promise<string>} [deps.runHomeAgent]
 * @param {string} [deps.HOME_AGENT_SKIP]
 * @param {(text: string) => boolean} [deps.shouldTryBookAgent]
 * @param {(m: import('./normalizeBaileysMessage.js').InboundMessage) => Promise<string>} [deps.runBookAgent]
 *   gets the whole message (owner check needs the actor)
 * @param {string} [deps.BOOK_AGENT_SKIP]
 * @returns {Promise<{ handled: boolean }>}
 */
export async function runAgentsChainSequential(m, deps) {
  const { logger, messaging, chatMemory, routeIntent } = deps;
  const text = m.text;
  const chatId = m.chatId;
  const agents = listAgents(deps);

  /**
   * @returns {Promise<boolean>} handled
   */
  async function runAgent(agent, route) {
    try {
      const reply = await agent.run(m, route);
      if (reply === null) return false;
      if (reply) {
        await messaging.sendText(chatId, reply);
        await chatMemory.append(chatId, 'user', text);
        await chatMemory.append(chatId, 'assistant', reply);
      }
      return true;
    } catch (err) {
      logger.error({ err }, agent.logLabel);
      await messaging.sendText(chatId, `${agent.errorLabel}: ${err.message}`);
      return true;
    }
  }

  if (typeof routeIntent === 'function') {
    const route = await routeIntent(text);
    if (route) {
      const agent = agents.find((a) => a.key === route.agent);
      return { handled: agent ? await runAgent(agent, route) : false };
    }
  }

  for (const agent of agents) {
    if (agent.shouldTry(text) && (await runAgent(agent))) return { handled: true };
  }
  return { handled: false };
}

/**
 * Keys match the Choice options in jevRouter.js. `run(m, route?)` returns the reply, or null to
 * fall through; `route` is the Jev route when Jev picked this agent.
 * @param {Parameters<typeof runAgentsChainSequential>[1]} deps
 */
export function listAgents(deps) {
  const skipAware = (run, skip, input = (m) => m.text) => async (m) => {
    const reply = await run(input(m));
    return reply.trim().toUpperCase() === skip ? null : reply;
  };
  const agents = [];
  if (typeof deps.shouldTryReminderAgent === 'function') {
    agents.push({
      key: 'reminder',
      shouldTry: deps.shouldTryReminderAgent,
      run: async (m) => {
        const r = await deps.runReminderAgent(m);
        return r?.handled ? (r.replyText ?? '') : null;
      },
      logLabel: 'Reminder agent error',
      errorLabel: 'Reminder error',
    });
  }
  agents.push(
    {
      key: 'lights',
      shouldTry: deps.shouldTryLightsAgent,
      run: async (m, route) => {
        if (route?.answers && typeof deps.runLightsFromJev === 'function') {
          const reply = await deps.runLightsFromJev(m.text, route.answers);
          if (reply !== null) return reply;
        }
        return skipAware(deps.runLightsAgent, deps.LIGHTS_AGENT_SKIP)(m);
      },
      logLabel: 'Lights agent error',
      errorLabel: 'Lights assistant error',
    },
    {
      key: 'weather',
      shouldTry: deps.shouldTryWeatherAgent,
      run: skipAware(deps.runWeatherAgent, deps.WEATHER_AGENT_SKIP),
      logLabel: 'Weather agent error',
      errorLabel: 'Weather assistant error',
    },
    {
      key: 'joplin',
      shouldTry: deps.shouldTryJoplinAgent,
      run: skipAware(deps.runJoplinAgent, deps.JOPLIN_AGENT_SKIP),
      logLabel: 'Joplin agent error',
      errorLabel: 'Notes assistant error',
    },
    {
      key: 'email',
      shouldTry: deps.shouldTryEmailAgent,
      run: skipAware(deps.runEmailAgent, deps.EMAIL_AGENT_SKIP),
      logLabel: 'Email agent error',
      errorLabel: 'Email assistant error',
    },
  );
  if (typeof deps.shouldTryHomeAgent === 'function' && typeof deps.runHomeAgent === 'function') {
    agents.push({
      key: 'home',
      shouldTry: deps.shouldTryHomeAgent,
      run: skipAware(deps.runHomeAgent, deps.HOME_AGENT_SKIP ?? 'SKIP'),
      logLabel: 'Home agent error',
      errorLabel: 'Home assistant error',
    });
  }
  if (typeof deps.shouldTryBookAgent === 'function' && typeof deps.runBookAgent === 'function') {
    agents.push({
      key: 'books',
      shouldTry: deps.shouldTryBookAgent,
      run: skipAware(deps.runBookAgent, deps.BOOK_AGENT_SKIP ?? 'SKIP', (m) => m),
      logLabel: 'Book agent error',
      errorLabel: 'Book recommendations error',
    });
  }
  return agents;
}
