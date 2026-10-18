#!/usr/bin/env node
/**
 * One-time OAuth consent for the Owner's calendar: prints a Google consent URL, receives the
 * authorization code and prints the refresh token to put in GOOGLE_CALENDAR_REFRESH_TOKEN.
 * Setup steps: docs/google-calendar-setup.md.
 *
 *   GOOGLE_CALENDAR_CLIENT_ID=… GOOGLE_CALENDAR_CLIENT_SECRET=… npm run calendar:consent
 *
 * The code arrives either on the local loopback server (browser on this machine), or by
 * pasting the address the browser was redirected to (browser on another machine, e.g. when
 * running on the Pi over SSH: that page fails to load, but its URL holds the code).
 */
import http from 'node:http';
import readline from 'node:readline';
import dotenv from 'dotenv';

dotenv.config();

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  // calendarList.get on primary: timezone and default notifications
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
const port = Number(process.env.GOOGLE_CALENDAR_CONSENT_PORT) || 53682;
const redirectUri = `http://127.0.0.1:${port}`;

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET first (see .env.example).');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent',
}).toString();

/** @param {string} code */
async function exchange(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: String(clientId),
      client_secret: String(clientSecret),
      redirect_uri: redirectUri,
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return String(body.refresh_token);
}

/** @param {string} input a code, or a URL / query string containing `code=` */
function codeFrom(input) {
  const s = input.trim();
  if (!s.includes('code=')) return s;
  return new URLSearchParams(s.slice(s.indexOf('?') + 1)).get('code') ?? '';
}

let done = false;
/** @param {string} code */
async function finish(code) {
  if (done || !code) return;
  done = true;
  try {
    const refreshToken = await exchange(code);
    console.log('\nAdd this to .env, then restart the bot (pm2 restart whatsapp):\n');
    console.log(`GOOGLE_CALENDAR_REFRESH_TOKEN=${refreshToken}\n`);
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

const server = http.createServer((req, res) => {
  const code = new URL(req.url ?? '/', redirectUri).searchParams.get('code') ?? '';
  res.end(code ? 'Done: you can close this tab and check the terminal.' : 'No code in this request.');
  void finish(code);
});
server.listen(port, '127.0.0.1');

console.log('Open this URL, sign in as the calendar owner and allow access:\n');
console.log(`${authUrl}\n`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('…or paste the address you were redirected to here: ', (answer) => {
  void finish(codeFrom(answer));
});
