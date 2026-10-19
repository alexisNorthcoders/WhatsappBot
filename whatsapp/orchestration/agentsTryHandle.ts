import type { InboundMessage } from './normalizeBaileysMessage.ts';
import type { Logger } from '../types.ts';

type TextGate = (text: string) => boolean;
type TextAgent = (text: string) => Promise<string>;
type Route = { agent: string; probability: number; answers?: Record<string, any> };

export type AgentChainDeps = {
  logger: Pick<Logger, 'error'>;
  messaging: { sendText(chatId: string, text: string): Promise<unknown> };
  chatMemory: { append(chatId: string, role: 'user' | 'assistant', content: string): Promise<unknown> };
  routeIntent?: (text: string) => Promise<Route | null>;
  /** Jev-answered lights request; null hands over to runLightsAgent */
  runLightsFromJev?: (text: string, answers: Record<string, any>) => Promise<string | null>;
  shouldTryReminderAgent?: TextGate;
  runReminderAgent?: (m: InboundMessage) => Promise<{ handled: boolean; replyText?: string }>;
  shouldTryLightsAgent: TextGate;
  runLightsAgent: TextAgent;
  LIGHTS_AGENT_SKIP: string;
  shouldTryWeatherAgent: TextGate;
  runWeatherAgent: TextAgent;
  WEATHER_AGENT_SKIP: string;
  shouldTryJoplinAgent: TextGate;
  runJoplinAgent: TextAgent;
  JOPLIN_AGENT_SKIP: string;
  shouldTryEmailAgent: TextGate;
  runEmailAgent: TextAgent;
  EMAIL_AGENT_SKIP: string;
  shouldTryHomeAgent?: TextGate;
  runHomeAgent?: TextAgent;
  HOME_AGENT_SKIP?: string;
  shouldTryBookAgent?: TextGate;
  /** gets the whole message (owner check needs the actor) */
  runBookAgent?: (m: InboundMessage) => Promise<string>;
  BOOK_AGENT_SKIP?: string;
  /** owner gate for the book agent; without it the book agent is never registered */
  isAllowedActor?: (actorId: string | null, actorAltId?: string | null) => boolean;
};

type ChainAgent = {
  key: string;
  shouldTry: TextGate;
  run: (m: InboundMessage, route?: Route) => Promise<string | null>;
  logLabel: string;
  errorLabel: string;
};

/**
 * Agent chain. With `routeIntent` (Jev), one call picks the agent and only that agent runs;
 * otherwise (or when Jev is unreachable) agents are tried in order behind their keyword gates,
 * with SKIP fallthrough (same semantics as legacy whatsapp.js).
 */
export async function runAgentsChainSequential(m: InboundMessage, deps: AgentChainDeps): Promise<{ handled: boolean }> {
  const { logger, messaging, chatMemory, routeIntent } = deps;
  const text = m.text;
  const chatId = m.chatId;
  const agents = listAgents(deps);

  async function runAgent(agent: ChainAgent, route?: Route): Promise<boolean> {
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
      await messaging.sendText(chatId, `${agent.errorLabel}: ${(err as Error).message}`);
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
export function listAgents(deps: AgentChainDeps): ChainAgent[] {
  const skipAware = (run: (m: InboundMessage) => Promise<string>, skip: string) => async (m: InboundMessage) => {
    const reply = await run(m);
    return reply.trim().toUpperCase() === skip ? null : reply;
  };
  const onText = (run: TextAgent) => (m: InboundMessage) => run(m.text);
  const agents: ChainAgent[] = [];
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
        return skipAware(onText(deps.runLightsAgent), deps.LIGHTS_AGENT_SKIP)(m);
      },
      logLabel: 'Lights agent error',
      errorLabel: 'Lights assistant error',
    },
    {
      key: 'weather',
      shouldTry: deps.shouldTryWeatherAgent,
      run: skipAware(onText(deps.runWeatherAgent), deps.WEATHER_AGENT_SKIP),
      logLabel: 'Weather agent error',
      errorLabel: 'Weather assistant error',
    },
    {
      key: 'joplin',
      shouldTry: deps.shouldTryJoplinAgent,
      run: skipAware(onText(deps.runJoplinAgent), deps.JOPLIN_AGENT_SKIP),
      logLabel: 'Joplin agent error',
      errorLabel: 'Notes assistant error',
    },
    {
      key: 'email',
      shouldTry: deps.shouldTryEmailAgent,
      run: skipAware(onText(deps.runEmailAgent), deps.EMAIL_AGENT_SKIP),
      logLabel: 'Email agent error',
      errorLabel: 'Email assistant error',
    },
  );
  if (typeof deps.shouldTryHomeAgent === 'function' && typeof deps.runHomeAgent === 'function') {
    agents.push({
      key: 'home',
      shouldTry: deps.shouldTryHomeAgent,
      run: skipAware(onText(deps.runHomeAgent), deps.HOME_AGENT_SKIP ?? 'SKIP'),
      logLabel: 'Home agent error',
      errorLabel: 'Home assistant error',
    });
  }
  if (
    typeof deps.shouldTryBookAgent === 'function' &&
    typeof deps.runBookAgent === 'function' &&
    typeof isAllowedActor === 'function'
  ) {
    const runBooks = skipAware(deps.runBookAgent, deps.BOOK_AGENT_SKIP ?? 'SKIP');
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
