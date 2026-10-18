# WhatsappBot

A personal WhatsApp assistant for its owner: it answers commands and natural-language requests,
and keeps the owner on top of their schedule.

## Language

### Schedule

**Owner's calendar**:
The owner's primary Google Calendar; the single source of truth for every Reminder.
_Avoid_: reminder store, local reminders

**Reminder**:
Any event on the Owner's calendar, whether created through the bot or directly in Google
Calendar. Covers both quick "remind me" items and appointments.
_Avoid_: event (when meaning the bot concept), calendar entry, task

**Nudge**:
The WhatsApp message the bot sends when one of a Reminder's alert times arrives; it goes to the
owner, and also to the Reminder's creator when that is someone else.
_Avoid_: notification, alert, delivery

**Alert time**:
A moment, relative to a Reminder's start, at which a Nudge is due; taken from the Reminder's own
Google Calendar notification settings.
_Avoid_: due time, lead time
