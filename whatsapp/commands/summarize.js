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

const SUMMARIZE_ACK =
  'On it — fetching the page and drafting your summary.';
const SUMMARIZE_BUSY =
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
 */
export default async function summarizeCommand(sock, sender, text) {
  const parsed = parseSummarizeMessage(text);
  if (!parsed.ok) {
    await sock.sendMessage(sender, { text: parsed.error });
    return;
  }

  if (!tryAcquireSummarizeLock()) {
    await sock.sendMessage(sender, { text: SUMMARIZE_BUSY });
    return;
  }

  try {
    await sock.sendMessage(sender, { text: SUMMARIZE_ACK });

    const { url, extra } = parsed;

    let res;
    try {
      res = await botFetch(
        url,
        buildBotFetchRequestInit({ userAgent: SUMMARIZE_USER_AGENT }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, {
        text: `Could not fetch URL: ${msg}`,
      });
      return;
    }

    if (!res.ok) {
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
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, {
        text: `Could not read response body: ${msg}`,
      });
      return;
    }

    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (!isHtmlLikeResponse(contentType, html)) {
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
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, { text: msg });
      return;
    }

    const cap = maxLlmInputChars();
    let forModel = extracted;
    if (forModel.length > cap) {
      forModel = `${forModel.slice(0, cap)}\n\n[… truncated for model input length …]`;
    }

    let summary;
    try {
      summary = await deepInfraAPI(buildSummaryPrompt(forModel, extra));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sock.sendMessage(sender, {
        text: `Summary request failed: ${msg}`,
      });
      return;
    }

    const out =
      typeof summary === 'string' && summary.trim()
        ? summary.trim()
        : 'The model returned an empty summary.';
    await sock.sendMessage(sender, { text: out });
  } finally {
    releaseSummarizeLock();
  }
}
