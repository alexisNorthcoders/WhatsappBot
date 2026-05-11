import pino from 'pino';
import { deepInfraAPI } from '../../models/models.js';
import {
  botFetch,
  buildBotFetchRequestInit,
  readResponseBodyBuffer,
} from '../utils/urlFetchSafety.js';
import { parseSummarizeMessage } from '../utils/summarizeArgs.js';
import { extractArticleTextFromHtml } from '../utils/articleExtract.js';
import { isHtmlLikeResponse } from '../utils/htmlResponse.js';
import {
  releaseSummarizeLock,
  tryAcquireSummarizeLock,
} from '../utils/summarizeLock.js';

/** Matches `deepInfraAPI` default model in `models/models.js`. */
const SUMMARIZE_DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3';

const summarizeRunLogger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Production invokes commands as `(sock, chatId, text, raw)`; tests inject `{ botFetch, deepInfraAPI, logger }`.
 * @param {unknown} rawOrDeps
 */
function resolveSummarizeDeps(rawOrDeps) {
  if (
    rawOrDeps != null &&
    typeof rawOrDeps === 'object' &&
    ('botFetch' in rawOrDeps ||
      'deepInfraAPI' in rawOrDeps ||
      'logger' in rawOrDeps)
  ) {
    return /** @type {{ botFetch?: typeof botFetch; deepInfraAPI?: typeof deepInfraAPI; logger?: { info: Function } }} */ (
      rawOrDeps
    );
  }
  return {};
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

function buildSummaryPrompt(extractedText, extra) {
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
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} sender
 * @param {string} text full message
 * @param {unknown} [rawOrDeps] raw Baileys message in production, or test deps `{ botFetch?, deepInfraAPI?, logger? }`
 */
export default async function summarizeCommand(sock, sender, text, rawOrDeps = {}) {
  const deps = resolveSummarizeDeps(rawOrDeps);
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
  let host = '';
  let httpStatus = /** @type {number | null} */ (null);
  let extractedLength = /** @type {number | null} */ (null);
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
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, {
        text: `Could not fetch URL: ${msg}`,
      });
      return;
    }

    httpStatus = res.status;
    if (!res.ok) {
      outcome = 'http_error';
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
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, {
        text: `Could not read response body: ${msg}`,
      });
      return;
    }

    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (!isHtmlLikeResponse(contentType, html)) {
      outcome = 'not_html';
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
      summary = await runLlm(buildSummaryPrompt(forModel, extra), undefined, {
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
    log.info({
      event: 'summarize_run',
      host,
      httpStatus,
      extractedLength,
      durationMs: Date.now() - startedAt,
      model: SUMMARIZE_DEFAULT_MODEL,
      provider: 'deepinfra',
      outcome,
    });
    releaseSummarizeLock(summarizeLeaseId);
  }
}
