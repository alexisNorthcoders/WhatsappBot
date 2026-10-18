# Google Calendar setup (calendar nudges)

The bot reads the Owner's calendar (primary Google Calendar) through the Calendar v3 API with
an OAuth refresh token. This is a one-time setup.

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project
   and enable the **Google Calendar API** (APIs & Services → Library).
2. Configure the **OAuth consent screen**: user type *External*, add your own Google account
   as a **test user**. Then **publish** the app (Publishing status → *In production*); while it
   stays in *Testing*, Google expires refresh tokens after 7 days. For a personal app you can
   skip verification and accept the "unverified app" warning during consent.
3. Create an **OAuth client ID** of type **Desktop app** (APIs & Services → Credentials). Copy
   its client ID and secret into `.env` as `GOOGLE_CALENDAR_CLIENT_ID` and
   `GOOGLE_CALENDAR_CLIENT_SECRET`.
4. On the Pi, run `npm run calendar:consent`. Open the printed URL, sign in as the calendar
   owner and allow access (scopes: `calendar.events`, `calendar.calendarlist.readonly`).
   - Browser on the same machine: the script receives the code on `http://127.0.0.1:53682`
     (override with `GOOGLE_CALENDAR_CONSENT_PORT`).
   - Browser elsewhere (SSH to the Pi): the redirect page fails to load; copy its full address
     from the address bar and paste it into the script.
5. Put the printed `GOOGLE_CALENDAR_REFRESH_TOKEN=…` line in `.env` and `pm2 restart whatsapp`.
   The log shows `calendar nudges: started` on connect.

To switch nudges off without removing the credentials, set `CALENDAR_NUDGES_DISABLE=1`. Other
tunables are in `.env.example`. Revoking access at
<https://myaccount.google.com/permissions> invalidates the refresh token; rerun step 4.
