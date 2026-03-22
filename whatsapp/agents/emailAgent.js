import dotenv from 'dotenv';
import OpenAI from 'openai';
import nodemailer from 'nodemailer';
import { logAgentInvocation, addCompletionUsage } from './agentUsageLog.js';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMAIL_AGENT_MODEL = process.env.EMAIL_AGENT_MODEL || 'gpt-4o-mini';
const MAX_AGENT_TURNS = 10;

export const EMAIL_AGENT_SKIP = 'SKIP';

const GMAIL_EMAIL = process.env.GMAIL_EMAIL;
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_EMAIL,
    pass: GMAIL_PASSWORD,
  },
});

const KEYWORD_PATTERN =
  /\b(email|e-mail|mail|send\s+mail|send\s+email|send\s+an?\s+email|send\s+an?\s+mail|gmail)\b|\b(email|mail)\s+(to|from|about)\b/i;

export function shouldTryEmailAgent(text) {
  if (process.env.EMAIL_AGENT_ALWAYS === '1') return true;
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return KEYWORD_PATTERN.test(trimmed);
}

function buildSystemPrompt() {
  return `You help the user send emails via Gmail. The sender address is ${GMAIL_EMAIL}.

Rules:
- Use the email_send tool to send emails. You MUST extract the recipient (to), subject, and body from the user's message.
- If the user doesn't specify a subject, infer a short one from the body content.
- If the user doesn't specify a recipient, ask them who to send to (respond with a plain text question, do NOT use SKIP).
- The body should be formatted nicely. You may use plain text or simple HTML.
- If the message is clearly NOT about sending an email, respond with exactly: ${EMAIL_AGENT_SKIP}
- After the tool succeeds, reply in a short, friendly WhatsApp style confirming the email was sent. Do not expose SKIP to the user.`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'email_send',
      description: 'Send an email via Gmail SMTP.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient email address (e.g. "user@example.com").',
          },
          subject: {
            type: 'string',
            description: 'Email subject line.',
          },
          body: {
            type: 'string',
            description: 'Email body content (plain text or HTML).',
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
];

async function executeEmailTool(name, args) {
  try {
    if (name !== 'email_send') {
      return `Error: Unknown tool "${name}".`;
    }

    const to = String(args.to ?? '').trim();
    const subject = String(args.subject ?? '').trim();
    const body = String(args.body ?? '').trim();

    if (!to) return 'Error: recipient (to) is required.';
    if (!subject) return 'Error: subject is required.';
    if (!body) return 'Error: body is required.';

    if (!GMAIL_EMAIL || !GMAIL_PASSWORD) {
      return 'Error: Gmail credentials are not configured (GMAIL_EMAIL / GMAIL_PASSWORD).';
    }

    const isHtml = /<[a-z][\s\S]*>/i.test(body);

    const mailOptions = {
      from: GMAIL_EMAIL,
      to,
      subject,
      ...(isHtml ? { html: body } : { text: body }),
    };

    const info = await transporter.sendMail(mailOptions);
    return `OK: Email sent to ${to} — messageId: ${info.messageId}`;
  } catch (e) {
    return `Error: ${e.message || String(e)}`;
  }
}

export async function runEmailAgent(userMessage) {
  const usage = { prompt: 0, completion: 0, total: 0 };
  const model = EMAIL_AGENT_MODEL;
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
        model: EMAIL_AGENT_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 1200,
      });

      addCompletionUsage(completion.usage, usage);

      const choice = completion.choices[0]?.message;
      if (!choice) {
        outcome = 'skip';
        return EMAIL_AGENT_SKIP;
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
          const result = await executeEmailTool(fn.name, parsed);
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
        return EMAIL_AGENT_SKIP;
      }
      if (text.toUpperCase() === EMAIL_AGENT_SKIP) {
        outcome = 'skip';
        return EMAIL_AGENT_SKIP;
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
      agent: 'email',
      model,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      totalTokens: usage.total,
      outcome,
    });
  }
}
