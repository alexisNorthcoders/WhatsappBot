# Google Calendar is the reminder store

Reminders used to live in a local JSON file with their own delivery state machine. We merged
"reminder" and "calendar event" into one concept: every event on the owner's primary Google
Calendar is a Reminder (whether created through the bot or in the Google app), and the bot only
sends WhatsApp nudges at each event's own notification times. Calendar is the single store, so
moving or deleting an event in Google needs no sync logic; locally we keep only "already nudged"
bookkeeping. We chose this over mirroring a local store to Calendar because two stores that can
both be edited means reconciliation bugs.

## Consequences

- Creating a Reminder while Google is unreachable fails outright; nothing is queued locally.
- Every event on the primary calendar, timed or all-day, can produce a nudge (declined invites and events with
  notifications off excepted), so the primary calendar's notification settings now also drive
  WhatsApp traffic.
- Pending reminders in the old JSON store were dropped, not migrated.
