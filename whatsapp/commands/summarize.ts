import pino from 'pino';
import { deepInfraAPI, DEEPINFRA_DEFAULT_CHAT_MODEL } from '../../models/models.ts';
import {
  botFetch,
  buildBotFetchRequestInit,
  readResponseBodyBuffer,
} from '../utils/urlFetchSafety.ts';
import { parseSummarizeMessage } from '../utils/summarizeArgs.ts';
import { extractArticleTextFromHtml } from '../utils/articleExtract.ts';
import { isHtmlLikeResponse } from '../utils/htmlResponse.ts';
import {
  releaseSummarizeLock,
  tryAcquireSummarizeLock,
} from '../utils/summarizeLock.ts';
import type { Command, Logger, TextSender } from '../types.ts';

/** Test-only: marks injected `{ botFetch?, deepInfraAPI?, logger? }` so raw WhatsApp messages are never mistaken for deps. */
const summarizeInjectedDepsBrand = Symbol.for('WhatsappBot.summarize.injectedDeps');

type SummarizeDeps = {
  botFetch?: typeof botFetch;
  deepInfraAPI?: typeof deepInfraAPI;
  logger?: Pick<Logger, 'info'>;
};

/**
 * Wrap test-only `{ botFetch?, deepInfraAPI?, logger? }`. Production passes the raw Baileys
 * message as the 4th argument; it must not be mistaken for injected deps.
 */
export function summarizeInjectedDeps(partial: SummarizeDeps) {
  return { [summarizeInjectedDepsBrand]: true, ...partial };
}

const summarizeRunLogger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * @param fourthArg raw Baileys message in production, or {@link summarizeInjectedDeps} in tests
 */
function resolveSummarizeDeps(fourthArg: unknown): SummarizeDeps {
  if (
    fourthArg != null &&
    typeof fourthArg === 'object' &&
    (fourthArg as Record<symbol, unknown>)[summarizeInjectedDepsBrand] === true
  ) {
    const { [summarizeInjectedDepsBrand]: _b, ...rest } = fourthArg as Record<symbol | string, unknown>;
    return rest as SummarizeDeps;
  }
  return {};
}

/**
 * One JSON log object per summarize run (no page body or prompts).
 * Every key is always present: use null when a value does not apply (see outcome).
 */
function logSummarizeRun(
  log: { info: (o: object) => void },
  { host, httpStatus, extractedLength, startedAt, model, outcome }: {
    host: string;
    httpStatus: number | null;
    extractedLength: number | null;
    startedAt: number;
    model: string;
    outcome: string;
  },
) {
  log.info({
    event: 'summarize_run',
    host: host || '',
    httpStatus: httpStatus === null || httpStatus === undefined ? null : httpStatus,
    extractedLength:
      extractedLength === null || extractedLength === undefined ? null : extractedLength,
    durationMs: Date.now() - startedAt,
    model,
    provider: 'deepinfra',
    outcome,
  });
}

export const SUMMARIZE_ACK =
  'On it — fetching the page and drafting your summary.';
export const SUMMARIZE_BUSY =
  'Summarize is busy (another run is in progress). Try again shortly.';

const SUMMARIZE_USER_AGENT = 'WhatsappBot-Summarize/1.0';

function maxLlmInputChars() {
  const n = parseInt(process.env.SUMMARIZE_MAX_INPUT_CHARS || '24000', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500_000) : 24_000;
}

function buildSummaryPrompt(extractedText: string, extra: string) {
  const instructions = extra.trim() || 'None.';
  return [
    'Summarize the following text extracted from a web page for a WhatsApp reader.',
    'Be concise and accurate; do not invent facts. Use short paragraphs or bullet points.',
    '',
    'Optional user focus:',
    instructions,
    '',
    'Extracted page text:',
    '---',
    extractedText,
    '---',
  ].join('\n');
}

/**
 * @param text full message
 * @param fourthArg raw Baileys message in production, or {@link summarizeInjectedDeps} in tests
 */
const summarizeCommand: Command<TextSender> = async (sock, sender, text, fourthArg) => {
  const deps = resolveSummarizeDeps(fourthArg);
  const fetchPage = deps.botFetch ?? botFetch;
  const runLlm = deps.deepInfraAPI ?? deepInfraAPI;
  const log = deps.logger ?? summarizeRunLogger;

  const parsed = parseSummarizeMessage(text);
  if (!parsed.ok) {
    await sock.sendMessage(sender, { text: parsed.error });
    return;
  }

  const summarizeLease = tryAcquireSummarizeLock();
  if (summarizeLease == null) {
    await sock.sendMessage(sender, { text: SUMMARIZE_BUSY });
    return;
  }
  const { leaseId: summarizeLeaseId, signal: summarizeSignal } = summarizeLease;

  const startedAt = Date.now();
  /** Hostname from URL, or '' if parsing failed. */
  let host = '';
  /** Set only after a Response exists; null on fetch/network errors before that. */
  let httpStatus = null as number | null;
  /** Character length of extracted article text; null until extraction succeeds. */
  let extractedLength = null as number | null;
  let outcome = 'unknown';

  try {
    await sock.sendMessage(sender, { text: SUMMARIZE_ACK });

    const { url, extra } = parsed;

    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }

    let res;
    try {
      res = await fetchPage(
        url,
        buildBotFetchRequestInit({
          userAgent: SUMMARIZE_USER_AGENT,
          signal: summarizeSignal,
        }),
      );
    } catch (e) {
      outcome = 'fetch_error';
      httpStatus = null;
      extractedLength = null;
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, {
        text: `Could not fetch URL: ${msg}`,
      });
      return;
    }

    httpStatus = res.status;
    if (!res.ok) {
      outcome = 'http_error';
      extractedLength = null;
      await sock.sendMessage(sender, {
        text: `Fetch failed: HTTP ${res.status} for ${url}`,
      });
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    let buf;
    try {
      buf = await readResponseBodyBuffer(res);
    } catch (e) {
      outcome = 'read_body_error';
      extractedLength = null;
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, {
        text: `Could not read response body: ${msg}`,
      });
      return;
    }

    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (!isHtmlLikeResponse(contentType, html)) {
      outcome = 'not_html';
      extractedLength = null;
      await sock.sendMessage(sender, {
        text:
          'This command only supports HTML web pages. The response was not HTML (check Content-Type or body).',
      });
      return;
    }

    let extracted;
    try {
      extracted = extractArticleTextFromHtml(html, url);
    } catch (e) {
      outcome = 'extract_error';
      extractedLength = null;
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, { text: msg });
      return;
    }

    extractedLength = extracted.length;

    const cap = maxLlmInputChars();
    let forModel = extracted;
    if (forModel.length > cap) {
      forModel = `${forModel.slice(0, cap)}\n\n[… truncated for model input length …]`;
    }

    let summary;
    try {
      summary = await runLlm(buildSummaryPrompt(forModel, extra), DEEPINFRA_DEFAULT_CHAT_MODEL, {
        signal: summarizeSignal,
      });
    } catch (e) {
      outcome = 'llm_error';
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, {
        text: `Summary request failed: ${msg}`,
      });
      return;
    }

    outcome = 'success';
    const out =
      typeof summary === 'string' && summary.trim()
        ? summary.trim()
        : 'The model returned an empty summary.';
    await sock.sendMessage(sender, { text: out });
  } finally {
    logSummarizeRun(log, {
      host,
      httpStatus,
      extractedLength,
      startedAt,
      model: DEEPINFRA_DEFAULT_CHAT_MODEL,
      outcome,
    });
    releaseSummarizeLock(summarizeLeaseId);
  }
};

export default summarizeCommand;
