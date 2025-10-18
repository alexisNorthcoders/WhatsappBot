import joplinAPI from '../../joplin/index.js';

// Helper function to find note by title or partial title
async function findNoteByTitle(titleQuery) {
    try {
        const results = await joplinAPI.searchNotes(titleQuery);
        
        if (results.length === 0) {
            throw new Error(`No notes found matching "${titleQuery}"`);
        }
        
        // If exact match found, return it
        const exactMatch = results.find(note => 
            note.title.toLowerCase() === titleQuery.toLowerCase()
        );
        if (exactMatch) {
            return exactMatch;
        }
        
        // If multiple partial matches, return the first one
        if (results.length > 1) {
            console.log(`Multiple notes found for "${titleQuery}", using first match: ${results[0].title}`);
        }
        
        return results[0];
    } catch (error) {
        throw new Error(`Could not find note: ${error.message}`);
    }
}

export async function addNote(sock, sender, text) {
    try {
        // Extract note content from command
        // Format: "addnote <title> | <content>" or "addnote <content>"
        const noteText = text.replace(/^addnote\s+/i, '').trim();
        
        if (!noteText) {
        await sock.sendMessage(sender, { 
            text: "❌ Please provide note content.\n\nUsage: Add note <title> | <content>\nExample: Add note Meeting Notes | Discuss project timeline" 
        });
            return;
        }

        let title, body;
        
        // Check if title and content are separated by " | "
        if (noteText.includes(' | ')) {
            const parts = noteText.split(' | ');
            title = parts[0].trim();
            body = parts.slice(1).join(' | ').trim();
        } else {
            // Use first line as title, rest as body
            const lines = noteText.split('\n');
            title = lines[0].trim();
            body = lines.slice(1).join('\n').trim() || noteText;
        }
        
        const note = await joplinAPI.createNote(title, body);
        
        await sock.sendMessage(sender, { 
            text: `✅ *Note created successfully!*\n\n📝 *Title:* ${title}\n🆔 *ID:* ${note.id}` 
        });
    } catch (error) {
        console.error('Error adding note:', error);
        await sock.sendMessage(sender, { 
            text: `❌ Failed to create note: ${error.message}` 
        });
    }
}

export async function listNotebooks(sock, sender) {
    try {
        const notebooks = await joplinAPI.getNotebooks();
        
        if (notebooks.length === 0) {
            await sock.sendMessage(sender, { text: "📁 No notebooks found." });
            return;
        }

        let message = "📁 *Available Notebooks:*\n\n";
        notebooks.forEach(notebook => {
            message += `• *${notebook.title}*\n`;
            message += `  ID: ${notebook.id}\n`;
            message += `  Notes: ${notebook.note_count || 0}\n\n`;
        });

        await sock.sendMessage(sender, { text: message });
    } catch (error) {
        console.error('Error listing notebooks:', error);
        await sock.sendMessage(sender, { 
            text: `❌ Failed to list notebooks: ${error.message}` 
        });
    }
}

export async function searchNotes(sock, sender, text) {
    try {
        const query = text.replace(/^searchnotes\s+/i, '').trim();
        
        if (!query) {
            await sock.sendMessage(sender, { 
                text: "❌ Please provide search query.\n\nUsage: searchnotes <query>\nExample: searchnotes meeting" 
            });
            return;
        }

        const results = await joplinAPI.searchNotes(query);
        
        if (results.length === 0) {
            await sock.sendMessage(sender, { text: `🔍 No notes found for "${query}"` });
            return;
        }

        let message = `🔍 *Search results for "${query}":*\n\n`;
        results.slice(0, 10).forEach(note => { // Limit to 10 results
            message += `• *${note.title}*\n`;
            message += `  ID: ${note.id}\n\n`;
        });

        if (results.length > 10) {
            message += `... and ${results.length - 10} more results`;
        }

        await sock.sendMessage(sender, { text: message });
    } catch (error) {
        console.error('Error searching notes:', error);
        await sock.sendMessage(sender, { 
            text: `❌ Failed to search notes: ${error.message}` 
        });
    }
}

export async function getNote(sock, sender, text) {
    try {
        const query = text.replace(/^getnote\s+/i, '').trim();
        
        if (!query) {
            await sock.sendMessage(sender, { 
                text: "❌ Please provide note title or ID.\n\nUsage: getnote <note_title_or_id>\nExample: getnote Meeting Notes\nExample: getnote abc123" 
            });
            return;
        }

        let note;
        
        // Check if it looks like an ID (alphanumeric, 6+ characters)
        if (/^[a-f0-9]{6,}$/i.test(query)) {
            // It's an ID, use it directly
            note = await joplinAPI.getNote(query);
        } else {
            // It's a title, search for it
            const foundNote = await findNoteByTitle(query);
            note = await joplinAPI.getNote(foundNote.id);
        }
        
        let message = `📝 *${note.title}*\n\n`;
        message += `🆔 *ID:* ${note.id}\n\n`;
        message += `*Content:*\n${note.body}`;

        // Split long messages if needed
        if (message.length > 4000) {
            const parts = message.split('\n');
            let currentMessage = '';
            
            for (const part of parts) {
                if (currentMessage.length + part.length > 4000) {
                    await sock.sendMessage(sender, { text: currentMessage });
                    currentMessage = part + '\n';
                } else {
                    currentMessage += part + '\n';
                }
            }
            
            if (currentMessage.trim()) {
                await sock.sendMessage(sender, { text: currentMessage });
            }
        } else {
            await sock.sendMessage(sender, { text: message });
        }
    } catch (error) {
        console.error('Error getting note:', error);
        await sock.sendMessage(sender, { 
            text: `❌ Failed to get note: ${error.message}` 
        });
    }
}

export async function updateNote(sock, sender, text) {
    try {
        // Format: "updatenote <note_id> | <new_title> | <new_content>" or "updatenote <note_id> | <content_to_append>"
        const updateText = text.replace(/^updatenote\s+/i, '').trim();
        
        if (!updateText) {
            await sock.sendMessage(sender, { 
                text: "❌ Please provide update details.\n\nUsage: updatenote <note_title_or_id> | <new_title> | <new_content>\nOr: updatenote <note_title_or_id> | <content_to_append>\nExample: updatenote Meeting Notes | Updated Title | New content\nExample: updatenote Meeting Notes | Additional notes here" 
            });
            return;
        }

        const parts = updateText.split(' | ');
        if (parts.length < 2) {
            await sock.sendMessage(sender, { 
                text: "❌ Invalid format. Use: updatenote <note_title_or_id> | <new_title> | <new_content> or updatenote <note_title_or_id> | <content_to_append>" 
            });
            return;
        }

        const noteQuery = parts[0].trim();
        
        // Find the note by title or ID
        let noteId;
        if (/^[a-f0-9]{6,}$/i.test(noteQuery)) {
            // It's an ID, use it directly
            noteId = noteQuery;
        } else {
            // It's a title, search for it
            const foundNote = await findNoteByTitle(noteQuery);
            noteId = foundNote.id;
        }
        
        // Get the current note to append to its body
        const currentNote = await joplinAPI.getNote(noteId);
        
        let newTitle, newContent;
        
        if (parts.length >= 3) {
            // Full update: title and content
            newTitle = parts[1].trim();
            newContent = parts.slice(2).join(' | ').trim();
        } else {
            // Append mode: keep current title, append to body
            newTitle = currentNote.title;
            const contentToAppend = parts[1].trim();
            newContent = currentNote.body + '\n\n' + contentToAppend;
        }

        const updates = {
            title: newTitle,
            body: newContent
        };

        const note = await joplinAPI.updateNote(noteId, updates);
        
        await sock.sendMessage(sender, { 
            text: `✅ *Note updated successfully!*\n\n📝 *Title:* ${note.title}\n🆔 *ID:* ${note.id}` 
        });
    } catch (error) {
        console.error('Error updating note:', error);
        await sock.sendMessage(sender, { 
            text: `❌ Failed to update note: ${error.message}` 
        });
    }
}

export async function deleteNote(sock, sender, text) {
    try {
        const query = text.replace(/^deletenote\s+/i, '').trim();
        
        if (!query) {
            await sock.sendMessage(sender, { 
                text: "❌ Please provide note title or ID.\n\nUsage: deletenote <note_title_or_id>\nExample: deletenote Meeting Notes\nExample: deletenote abc123" 
            });
            return;
        }

        // Find the note by title or ID
        let noteId;
        if (/^[a-f0-9]{6,}$/i.test(query)) {
            // It's an ID, use it directly
            noteId = query;
        } else {
            // It's a title, search for it
            const foundNote = await findNoteByTitle(query);
            noteId = foundNote.id;
        }

        await joplinAPI.deleteNote(noteId);
        
        await sock.sendMessage(sender, { 
            text: `✅ *Note deleted successfully!*\n\n🆔 *ID:* ${noteId}` 
        });
    } catch (error) {
        console.error('Error deleting note:', error);
        await sock.sendMessage(sender, { 
            text: `❌ Failed to delete note: ${error.message}` 
        });
    }
}

export async function joplinHelp(sock, sender) {
    const helpText = `📝 *Joplin Commands Help*\n\n` +
        `*Create Note:*\n` +
        `• Add note <title> | <content>\n` +
        `• Add note <content> (uses first line as title)\n\n` +
        `*Search & View:*\n` +
        `• Search notes <query>\n` +
        `• Get note <note_title_or_id>\n` +
        `• List notebooks\n\n` +
        `*Edit & Delete:*\n` +
        `• Update note <note_title_or_id> | <new_title> | <new_content>\n` +
        `• Update note <note_title_or_id> | <content_to_append>\n` +
        `• Delete note <note_title_or_id>\n\n` +
        `*Examples:*\n` +
        `• Add note Meeting Notes | Discuss project timeline\n` +
        `• Get note Meeting Notes\n` +
        `• Update note Meeting Notes | Additional notes here\n` +
        `• Update note abc123 | Updated Title | New content\n` +
        `• Search notes meeting\n` +
        `• Delete note Meeting Notes`;

    await sock.sendMessage(sender, { text: helpText });
}
