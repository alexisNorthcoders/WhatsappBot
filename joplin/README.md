# Joplin Integration for WhatsApp Bot

This module provides integration with Joplin for creating, reading, updating, and deleting notes via WhatsApp commands.

## Setup

### 1. Install Joplin CLI

Install Joplin CLI on your Raspberry Pi:

```bash
npm install -g joplin
```

### 2. Configure Environment Variables

Add the following to your `.env` file:

```env
# Joplin Server Configuration
JOPLIN_SERVER_URL=http://192.168.4.42:22300
JOPLIN_EMAIL=admin@localhost
JOPLIN_PASSWORD=your_actual_password_here
```

### 3. Test the Integration

Run the test script to verify everything is working:

```bash
node test-joplin.js
```

The integration will automatically configure the Joplin CLI to sync with your Joplin Server and use CLI commands for all operations.

## Available Commands

- `Addnote <title> | <content>` - Create a new note
- `Addnote <content>` - Create a note with first line as title
- `List notebooks` - List all available notebooks
- `Search notes <query>` - Search for notes
- `Get note <note_id>` - Get a specific note
- `Update note <note_id> | <new_title> | <new_content>` - Update a note
- `Delete note <note_id>` - Delete a note
- `Joplin help` - Show help for Joplin commands

## Examples

- `Addnote Meeting Notes | Discuss project timeline with team`
- `Addnote Quick reminder to call mom`
- `Search notes meeting`
- `Get note abc123def456`

## Notes

- The Joplin Data API runs on port 41184 by default
- Make sure Joplin desktop application is running when using the bot
- Notes are created in the default notebook unless a specific notebook ID is provided
