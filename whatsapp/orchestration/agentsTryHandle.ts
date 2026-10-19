import type { InboundMessage } from './normalizeBaileysMessage.ts';
import type { Logger } from '../types.ts';

/**
 * Agent chain. With `routeIntent` (Jev), one call picks the agent and only that agent runs;
 * otherwise (or when Jev is unreachable) agents are tried in order behind their keyword gates,
 * with SKIP fallthrough (same semantics as legacy whatsapp.js).
 * @param deps.runLightsFromJev
 *   Jev-answered lights request; null hands over to runLightsAgent
 * @param deps.runBookAgent
 *   gets the whole message (owner check needs the actor)
 * @param deps.isAllowedActor
 *   owner gate for the book agent; without it the book agent is never registered
 */
export async function runAgentsChainSequential(m: InboundMessage, deps: { logger: Logger; messaging: { sendText(chatId: string, text: string): Promise<void> }; chatMemory: { append(chatId: string, role: 'user' | 'assistant', content: string): Promise<void> }; routeIntent?: (text: string) => Promise<{ agent: string; probability: number; answers?: Record<string, any> } | null>; runLightsFromJev?: (text: string, answers: Record<string, any>) => Promise<string | null>; shouldTryReminderAgent?: (text: string) => boolean; runReminderAgent?: (m: InboundMessage) => Promise<{ handled: boolean; replyText?: string }>; shouldTryLightsAgent: (text: string) => boolean; runLightsAgent: (text: string) => Promise<string>; LIGHTS_AGENT_SKIP: string; shouldTryWeatherAgent: (text: string) => boolean; runWeatherAgent: (text: string) => Promise<string>; WEATHER_AGENT_SKIP: string; shouldTryJoplinAgent: (text: string) => boolean; runJoplinAgent: (text: string) => Promise<string>; JOPLIN_AGENT_SKIP: string; shouldTryEmailAgent: (text: string) => boolean; runEmailAgent: (text: string) => Promise<string>; EMAIL_AGENT_SKIP: string; shouldTryHomeAgent?: (text: string) => boolean; runHomeAgent?: (text: string) => Promise<string>; HOME_AGENT_SKIP?: string; shouldTryBookAgent?: (text: string) => boolean; runBookAgent?: (m: InboundMessage) => Promise<string>; BOOK_AGENT_SKIP?: string; isAllowedActor?: (actorId: string | null, actorAltId?: string | null) => boolean }): Promise<{ handled: boolean }> {
  const { logger, messaging, chatMemory, routeIntent } = deps;
  const text = m.text;
  const chatId = m.chatId;
  const agents = listAgents(deps);

  async function runAgent(agent, route): Promise<boolean> {
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
 * Keys match the Choice options in jevRouter.ts. `run(m, route?)` returns the reply, or null to
 * fall through; `route` is the Jev route when Jev picked this agent.
 */
export function listAgents(deps: Parameters<typeof runAgentsChainSequential>[1]) {
  const skipAware = (run, skip, input = (m) => m.text) => async (m) => {
    const reply = await run(input(m));
    return reply.trim().toUpperCase() === skip ? null : reply;
  };
  const agents = [];
  const { runReminderAgent, isAllowedActor } = deps;
  if (typeof deps.shouldTryReminderAgent === 'function' && typeof runReminderAgent === 'function') {
    agents.push({
      key: 'reminder',
      shouldTry: deps.shouldTryReminderAgent,
      run: async (m) => {
        const r = await runReminderAgent(m);
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
  if (
    typeof deps.shouldTryBookAgent === 'function' &&
    typeof deps.runBookAgent === 'function' &&
    typeof isAllowedActor === 'function'
  ) {
    const runBooks = skipAware(deps.runBookAgent, deps.BOOK_AGENT_SKIP ?? 'SKIP', (m) => m);
    agents.push({
      key: 'books',
      shouldTry: deps.shouldTryBookAgent,
      // Owner-only: non-owners fall through without reaching the service.
      run: async (m) => (isAllowedActor(m.actorId, m.actorAltId) ? runBooks(m) : null),
      logLabel: 'Book agent error',
      errorLabel: 'Book recommendations error',
    });
  }
  return agents;
}
