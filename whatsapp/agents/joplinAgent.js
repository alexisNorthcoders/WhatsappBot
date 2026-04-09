import dotenv from 'dotenv';
import OpenAI from 'openai';
import joplinAPI, { WHATSAPP_BOT_NOTEBOOK } from '../../joplin/index.js';
import { openaiChatTokenOpts } from '../../models/models.js';
import { logAgentInvocation, addCompletionUsage } from './agentUsageLog.js';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const JOPLIN_AGENT_MODEL = process.env.JOPLIN_AGENT_MODEL || 'gpt-5-nano';
const MAX_AGENT_TURNS = 15;
const MAX_TOOL_TEXT = 12000;

export const JOPLIN_AGENT_SKIP = 'SKIP';

/** Only this notebook is searched or mutated by the WhatsApp agent (saves CLI + LLM cost). */
const AGENT_NOTEBOOK = process.env.JOPLIN_AGENT_NOTEBOOK?.trim() || WHATSAPP_BOT_NOTEBOOK;

async function findNoteByTitle(titleQuery) {
  const results = await joplinAPI.searchNotesInNotebook(AGENT_NOTEBOOK, titleQuery);
  if (results.length === 0) {
    throw new Error(`No notes found matching "${titleQuery}"`);
  }
  const exactMatch = results.find((note) => note.title.toLowerCase() === titleQuery.toLowerCase());
  if (exactMatch) return exactMatch;
  if (results.length > 1) {
    console.log(`Multiple notes for "${titleQuery}", using first: ${results[0].title}`);
  }
  return results[0];
}

function resolveNoteId(noteQuery) {
  const q = String(noteQuery || '').trim();
  if (!q) throw new Error('note_query is required');
  if (/^[a-f0-9]{6,}$/i.test(q)) return q;
  return null;
}

async function resolveNoteIdOrSearch(noteQuery) {
  const direct = resolveNoteId(noteQuery);
  if (direct) {
    return joplinAPI.resolveNoteIdInNotebook(direct, AGENT_NOTEBOOK);
  }
  const found = await findNoteByTitle(noteQuery);
  return joplinAPI.resolveNoteIdInNotebook(found.id, AGENT_NOTEBOOK);
}

const KEYWORD_PATTERN =
  /\b(note|notes|notepad|joplin|notebook|notebooks)\b|\b(save|add|write)\s+(a\s+)?note\b|\b(list|show|search|find|get|open|delete|remove|update|edit)\b.*\bnote|\b(fetch|save|archive|capture|store)\s+(the\s+)?(page|url|web|html|site|webpage)\b|\bhttps?:\/\/\S+.*\b(joplin|note|save|archive|page|html)\b|\b(joplin|note|save)\b.*\bhttps?:\/\//i;

const FETCH_USER_AGENT = 'WhatsappBot-JoplinAgent/1.0';
const DEFAULT_MAX_FETCH_CHARS = 500_000;

function maxFetchChars() {
  const n = parseInt(process.env.JOPLIN_FETCH_MAX_HTML_CHARS || String(DEFAULT_MAX_FETCH_CHARS), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2_000_000) : DEFAULT_MAX_FETCH_CHARS;
}

/** Block obvious SSRF targets (private/local); http(s) only. */
function isUrlAllowedForFetch(urlStr) {
  let u;
  try {
    u = new URL(urlStr.trim());
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1') return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return false;
    if (a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
  }
  return true;
}

function markdownFence(lang, content) {
  const inner = String(content);
  let longest = 0;
  for (const m of inner.matchAll(/`+/g)) {
    if (m[0].length > longest) longest = m[0].length;
  }
  const fence = '`'.repeat(Math.max(3, longest) + 1);
  return `${fence}${lang}\n${inner}\n${fence}`;
}

async function fetchUrlBodyForNote(url) {
  const maxChars = maxFetchChars();
  const res = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8', 'User-Agent': FETCH_USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(45_000),
  });
  const ct = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();
  const dec = new TextDecoder('utf-8');
  let text = dec.decode(buf);
  const fullLen = text.length;
  let truncated = false;
  if (fullLen > maxChars) {
    truncated = true;
    text = `${text.slice(0, maxChars)}\n\n… (truncated: ${fullLen} characters, limit ${maxChars})`;
  }
  let fenceLang = /json/i.test(ct) ? 'json' : /html|xml/i.test(ct) ? 'html' : '';
  const head = text.trimStart().slice(0, 500);
  if (!fenceLang && (/^<!DOCTYPE\s+html/i.test(head) || /^<html[\s>]/i.test(head))) {
    fenceLang = 'html';
  }
  if (!fenceLang) fenceLang = 'text';
  return {
    ok: res.ok,
    status: res.status,
    contentType: ct.split(';')[0].trim() || 'unknown',
    body: text,
    fenceLang,
    truncated,
  };
}

export function shouldTryJoplinAgent(text) {
  if (process.env.JOPLIN_AGENT_ALWAYS === '1') return true;
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return KEYWORD_PATTERN.test(trimmed);
}

function buildSystemPrompt() {
  return `You help the user manage Joplin notes via tools. All read/search/update/delete operations are limited to the "${AGENT_NOTEBOOK}" notebook only (not the whole Joplin account). New notes are created there too.

Rules:
- Use tools to perform actions. Prefer search_notes when the user is vague about which note they mean.
- For get_note, pass either a hex note id (6+ hex chars) or a title / partial title (must be in ${AGENT_NOTEBOOK}).
- create_note: provide title and body (body can be empty).
- fetch_url_save: download a public http(s) URL and create a note whose body is the raw response (HTML/JSON/text) in a fenced code block, plus metadata. Use when the user wants a webpage or URL saved/archived to Joplin.
- update_note: mode "append" + text_to_append, OR mode "replace" with new_title and optionally new_body (omit new_body to keep current body).
- list_notebooks returns a summary of that single bot notebook, not every notebook in Joplin.
- If the message is clearly NOT about notes / Joplin / notebooks, respond with exactly: ${JOPLIN_AGENT_SKIP}
- After tools succeed, reply in a short, friendly WhatsApp style (emoji ok). Do not expose raw SKIP to the user.`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'joplin_create_note',
      description: 'Create a note in the WhatsApp Bot notebook.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown/plain body; can be empty' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'joplin_fetch_url_save',
      description:
        'HTTP GET a public URL and save the response body into a new note (markdown with fenced code block). Localhost/private IPs are blocked.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL to fetch' },
          note_title: {
            type: 'string',
            description: 'Optional note title; default derived from URL',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'joplin_list_notebooks',
      description: `List note titles in the "${AGENT_NOTEBOOK}" notebook only (count + preview; does not scan other notebooks).`,
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'joplin_search_notes',
      description: `Search note titles in "${AGENT_NOTEBOOK}" only; returns up to 15 matches.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'joplin_get_note',
      description: 'Fetch full note content by id or title.',
      parameters: {
        type: 'object',
        properties: {
          note_query: { type: 'string', description: 'Hex id or title' },
        },
        required: ['note_query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'joplin_update_note',
      description: 'Append text to a note, or replace title and/or body.',
      parameters: {
        type: 'object',
        properties: {
          note_query: { type: 'string' },
          mode: { type: 'string', enum: ['append', 'replace'] },
          text_to_append: { type: 'string', description: 'Required when mode is append' },
          new_title: { type: 'string', description: 'For replace: new title (required if replacing)' },
          new_body: { type: 'string', description: 'For replace: full new body; omit to keep existing body' },
        },
        required: ['note_query', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'joplin_delete_note',
      description: 'Delete a note by id or title.',
      parameters: {
        type: 'object',
        properties: {
          note_query: { type: 'string' },
        },
        required: ['note_query'],
      },
    },
  },
];

function truncate(s) {
  if (s.length <= MAX_TOOL_TEXT) return s;
  return `${s.slice(0, MAX_TOOL_TEXT)}\n\n… (truncated)`;
}

export async function executeJoplinTool(name, args) {
  try {
    switch (name) {
      case 'joplin_create_note': {
        const title = String(args.title || '').trim();
        const body = args.body != null ? String(args.body) : '';
        if (!title) return 'Error: title is required.';
        const parent =
          AGENT_NOTEBOOK === WHATSAPP_BOT_NOTEBOOK ? null : AGENT_NOTEBOOK;
        const note = await joplinAPI.createNote(title, body, parent);
        return `OK: Created note "${note.title}" (id: ${note.id}) in ${AGENT_NOTEBOOK}`;
      }
      case 'joplin_fetch_url_save': {
        const url = String(args.url || '').trim();
        if (!url) return 'Error: url is required.';
        if (!isUrlAllowedForFetch(url)) {
          return 'Error: Only public http(s) URLs are allowed (no localhost, credentials in URL, or private IP ranges).';
        }
        let fetched;
        try {
          fetched = await fetchUrlBodyForNote(url);
        } catch (e) {
          return `Error: Fetch failed: ${e.message || String(e)}`;
        }
        const titleRaw = args.note_title != null ? String(args.note_title).trim() : '';
        let title = titleRaw;
        if (!title) {
          try {
            const u = new URL(url);
            const path = u.pathname === '/' ? '' : u.pathname;
            title = `Web: ${u.hostname}${path}`.slice(0, 200);
          } catch {
            title = 'Fetched page';
          }
        }
        const headline = [
          `Source: ${url}`,
          `Fetched: ${new Date().toISOString()}`,
          `HTTP ${fetched.status}${fetched.ok ? '' : ' (non-OK)'}`,
          `Content-Type: ${fetched.contentType}`,
          fetched.truncated ? 'Truncated: yes' : '',
        ]
          .filter(Boolean)
          .join('\n');
        const body = `${headline}\n\n${markdownFence(fetched.fenceLang, fetched.body)}`;
        const parent = AGENT_NOTEBOOK === WHATSAPP_BOT_NOTEBOOK ? null : AGENT_NOTEBOOK;
        const note = await joplinAPI.createNote(title, body, parent);
        const statusHint = fetched.ok ? 'saved' : 'saved (non-OK HTTP status)';
        return `OK: ${statusHint} — "${note.title}" (id: ${note.id}) in ${AGENT_NOTEBOOK}`;
      }
      case 'joplin_list_notebooks': {
        const { notebookName, noteCount, notes } = await joplinAPI.summarizeNotebook(AGENT_NOTEBOOK);
        if (!noteCount) return `📁 *${notebookName}* — no notes yet.`;
        const preview = notes.slice(0, 25).map((n) => `• ${n.title} — ${n.id}`);
        let msg = `📁 *${notebookName}* — ${noteCount} note(s)\n\n${preview.join('\n')}`;
        if (notes.length > 25) msg += `\n… and ${notes.length - 25} more`;
        return msg;
      }
      case 'joplin_search_notes': {
        const query = String(args.query || '').trim();
        if (!query) return 'Error: query is required.';
        const results = await joplinAPI.searchNotesInNotebook(AGENT_NOTEBOOK, query);
        if (!results.length) return `No notes found for "${query}" in ${AGENT_NOTEBOOK}.`;
        const slice = results.slice(0, 15);
        const lines = slice.map((n) => `• ${n.title} — id: ${n.id}`);
        let out = lines.join('\n');
        if (results.length > 15) out += `\n… and ${results.length - 15} more`;
        return out;
      }
      case 'joplin_get_note': {
        const noteQuery = String(args.note_query || '').trim();
        let note;
        if (resolveNoteId(noteQuery)) {
          note = await joplinAPI.getNoteInNotebook(noteQuery, AGENT_NOTEBOOK);
        } else {
          const found = await findNoteByTitle(noteQuery);
          note = await joplinAPI.getNoteInNotebook(found.id, AGENT_NOTEBOOK);
        }
        const header = `Title: ${note.title}\nID: ${note.id}\n---\n`;
        return truncate(header + (note.body || ''));
      }
      case 'joplin_update_note': {
        const mode = args.mode;
        const noteQuery = String(args.note_query || '').trim();
        const noteId = await resolveNoteIdOrSearch(noteQuery);
        if (mode === 'append') {
          const append = String(args.text_to_append || '').trim();
          if (!append) return 'Error: text_to_append required for append mode.';
          const current = await joplinAPI.getNoteInNotebook(noteId, AGENT_NOTEBOOK);
          const newBody = (current.body || '') + '\n\n' + append;
          await joplinAPI.updateNote(noteId, { title: current.title, body: newBody });
          return `OK: Appended to "${current.title}" (${noteId})`;
        }
        if (mode === 'replace') {
          const newTitleRaw = args.new_title != null ? String(args.new_title).trim() : '';
          const current = await joplinAPI.getNoteInNotebook(noteId, AGENT_NOTEBOOK);
          const newTitle = newTitleRaw || current.title;
          const newBody =
            args.new_body !== undefined && args.new_body !== null
              ? String(args.new_body)
              : current.body;
          if (!newTitleRaw && args.new_body === undefined) {
            return 'Error: For replace, provide new_title and/or new_body.';
          }
          await joplinAPI.updateNote(noteId, { title: newTitle, body: newBody });
          return `OK: Updated note ${noteId} — title "${newTitle}"`;
        }
        return 'Error: mode must be "append" or "replace".';
      }
      case 'joplin_delete_note': {
        const noteQuery = String(args.note_query || '').trim();
        const noteId = await resolveNoteIdOrSearch(noteQuery);
        await joplinAPI.deleteNote(noteId);
        return `OK: Deleted note ${noteId}`;
      }
      default:
        return `Error: Unknown tool "${name}".`;
    }
  } catch (e) {
    return `Error: ${e.message || String(e)}`;
  }
}

export async function runJoplinAgent(userMessage) {
  const usage = { prompt: 0, completion: 0, total: 0 };
  const model = JOPLIN_AGENT_MODEL;
  let outcome = 'error';

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: userMessage },
    ];

    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const completion = await openai.chat.completions.create({
        model: JOPLIN_AGENT_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        ...openaiChatTokenOpts(JOPLIN_AGENT_MODEL, 1200),
      });

      addCompletionUsage(completion.usage, usage);

      const choice = completion.choices[0]?.message;
      if (!choice) {
        outcome = 'skip';
        return JOPLIN_AGENT_SKIP;
      }

      if (choice.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: choice.content || null,
          tool_calls: choice.tool_calls,
        });
        for (const tc of choice.tool_calls) {
          const fn = tc.function;
          let parsed = {};
          try {
            parsed = fn.arguments ? JSON.parse(fn.arguments) : {};
          } catch {
            parsed = {};
          }
          const result = await executeJoplinTool(fn.name, parsed);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        }
        continue;
      }

      const text = (choice.content || '').trim();
      if (!text) {
        outcome = 'skip';
        return JOPLIN_AGENT_SKIP;
      }
      if (text.toUpperCase() === JOPLIN_AGENT_SKIP) {
        outcome = 'skip';
        return JOPLIN_AGENT_SKIP;
      }
      outcome = 'answered';
      return text;
    }

    outcome = 'max_turns';
    return 'Too many tool steps — try a simpler request.';
  } catch (e) {
    outcome = 'error';
    throw e;
  } finally {
    await logAgentInvocation({
      agent: 'joplin',
      model,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      totalTokens: usage.total,
      outcome,
    });
  }
}
